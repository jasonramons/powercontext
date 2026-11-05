# 一页技术说明

## 1. 模块结构

```
任务描述
   │
   ├─ seekdb 检索 ──────────────┐
   │   hybridSearch(全文 + 向量 + RRF)  │
   │   ↓                        │
   │   按 kind 分组：spec / code / test │
   │                            ▼
   └────────────► MiniMax chat/completions
                                │  返回 {"files":[{path, content}]}
                                ▼
                    写文件 → node --test → 通过？
                                │ 否 → 带失败输出重试一次 → 仍失败则回滚
                                ▼
                     PowerContext /v1/memory/remember
```

三层职责严格分开：seekdb 只负责「找到材料」，MiniMax 只负责「生成修改」，PowerContext 只负责「记住状态」。没有任何一层越界做别人的事。

## 2. 上下文选择方式

- **切分**：规格按 Markdown 标题切，代码按 60 行滑窗切（重叠 10 行），保证一条规格/一个函数不会被腰斩。
- **向量**：256 维特征哈希（英文按词、中文按双字），L2 归一化，离线可复现，不依赖外部模型。
- **检索**：`hybridSearch` 把全文 `contains` 与向量 `knn` 两路在 seekdb 内部用 RRF（k=60）合并；不满足条件时退回纯向量。
- **分组**：按元数据 `kind` 取 spec/code/test 各最多 4 条，直接构造成给模型的上下文块。

上下文随内容变化：`ingest` 会先按 `document_id` 删除旧片段再写入，所以改了规格重新导入后，检索结果立即变成新内容——这一点是验收「上下文正确」的关键。

## 3. 各技术的实际承担

| 技术 | 承担 | 记录位置 |
|---|---|---|
| seekdb | 12 个片段的存储与检索（集合 `ctx_chunks`，256 维，cosine + HNSW） | `docs/technical-usage.md` 的「检索记录」 |
| MiniMax | 一次真实 `chat/completions` 调用，模型 `MiniMax-M3.1-Flash`，生成完整修正文件 | 「MiniMax 调用记录」表（含延迟、token） |
| PowerContext | `scp_...` scope 下写入 4 条 memory：observation / outcome / decision / next-step | 「状态写入」段 + `state` 命令可复核 |

## 4. 状态设计

- scope 用固定 `idempotency_key` 创建：`mm-context-pagination-v1`，重复调用返回同一个 `scope_id`，进程重启不会新建。
- 写入分四类：`observation`（任务开始）、`outcome`（测试结果）、`decision`（改了什么）、`next-step`（后续动作）。
- 读取用 `/v1/memory/entries/list`，失败时退回 `/v1/memory/search`。实测新进程读取到 4 条完整记录。

## 5. 一次实测结果

| 项 | 值 |
|---|---|
| 修复前测试 | exit=1（10 个用例中 6 个失败） |
| MiniMax 模型 / 延迟 | `MiniMax-M3.1-Flash` / 12.8 s |
| token 用量 | prompt 1504 / completion 1379 |
| 修复后测试 | exit=0（10/10 通过） |
| 变更规模 | 1 个文件、15 行 |
| seekdb 检索 | 命中 12 条，返回规格 4 条 + 代码 2 条 + 测试 1 条 |
| 状态复用 | 新进程读回 4 条记录 |

MiniMax 产出的修复与规格逐条对应：`pageSize` 1..100 校验、`page >= 1` 校验、越界返回空数组、`start = (page-1)*pageSize`，且 `pageCount` 原样保留（P-6/P-7 的兼容要求）。

## 6. 失败处理

- 模型返回非 JSON：把错误回灌给模型重试一次。
- 补丁路径不在 `demo/src/`：直接拒绝，不写盘。
- 两次测试仍失败：恢复备份文件，并在 PowerContext 里记 `outcome: 修复失败，已回滚`。
- MiniMax 限流/5xx：同模型重试一次，再切换 `MiniMax-M3` → `MiniMax-M2.7`。

## 7. 已知限制

- 检索是词面级的，不理解同义改写；换成真实 embedding 模型即可提升，接口不变。
- 只针对单文件修复场景设计，多文件改动虽支持但未做冲突合并。
- PowerContext 未配生成/embedding 模型，状态检索走文本模式。

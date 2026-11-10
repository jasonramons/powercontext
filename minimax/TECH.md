# 一页技术说明

## 模块结构

```
任务 ──► materials.py ──► seekdb（片段 + 向量 + 元数据）
                              │ 向量距离 + 关键词
                              ▼
        context.py  ◄── 检索结果 ── 规格 / 代码 / 测试 分组、必需来源补位
             │
             ├── PowerContext.scoped Memory ── 已完成 / 待办 / 上次验证结果
             ▼
        prompting.py ──► MiniMax-M3.1-Flash ──► 完整文件补丁
             ▼
        apply.py（落盘 + 快照 + diff）──► pytest（目标 + 回归）──► state.py 写回 PowerContext
```

`mmctx` 是上下文模块本体；`business/` 是被修改的业务工程；`materials/` 是规格与规格
变更样例；`records/` 是 MiniMax、数据库、测试与状态的运行记录。

## 上下文怎么选

1. **入库**：规格按 `##` 小节切分（每节一个 `SPEC-xxx` 编号）；Python 代码与测试按
   AST 的顶层函数/类切分（符号名 + 行范围）。每个片段带 `path`、`start_line`、
   `end_line`，上下文里的来源可以直接回原文核对。
2. **检索**：任务文本先做特征哈希向量，seekdb 用 `COSINE_DISTANCE(embedding, ?)`
   排序，再按关键词命中与符号名加权。SQL 与命中行数全部写进 `records/db-queries.log`。
3. **选材**：按 `spec` / `code` / `test` 三组各取最多 4 条，保证三类资料都在上下文里，
   不会被某个大文件挤掉。
4. **必需来源**：验证样例 `samples/task.json` 声明本次任务必须出现的来源；缺哪条就按
   符号精确回查 seekdb 补上，并在输出里标 `required=true`、在 `required_check` 里逐条
   给出 `present`，评审可以直接对照。
5. **规格演进**：规格文档的 `spec-id` 是逻辑主键。重新导入 v2 时按 `doc_key` 整篇替换，
   旧版本片段不会残留；下一次检索自然只能用新内容。
6. **状态复用**：任务进展写进 PowerContext 的 scoped Memory（`idempotency_key` 固定，
   重启后仍是同一个 scope）。新进程打开同一个 SQLite 库，用 FTS 检索回读最近快照，
   把「已完成 / 待办 / 上次验证结果」带进下一次上下文与提示词。

## 三项技术的分工

| 技术 | 承担的作用 | 不承担 |
| --- | --- | --- |
| **MiniMax**（`MiniMax-M3.1-Flash`） | 阅读上下文，产出 `business/app/orderkit/pagination.py` 的完整替换内容；两次真实调用记录在 `records/` | 不做检索、不做状态存储 |
| **seekdb**（嵌入式 `pylibseekdb`，MySQL 协议访问） | 存工程资料片段、向量与元数据；上下文的每一条来源都来自 seekdb 查询 | 不存任务进展（那是 PowerContext 的职责） |
| **PowerContext**（`powercontext[builtin]` 的 scoped Memory + SQLite 持久化） | 存任务进展与验证结果；重启后读回并用于后续上下文 | 不做代码检索 |

## 关键设计取舍

- **离线可复现**：向量用特征哈希，不下载模型；MiniMax 调用有完整记录，评审环境无
  Key 时回放同一条记录，不需要重新生成完全一致的补丁。
- **来源可核对**：上下文输出只包含 `path:start-end` 形式的真实片段，`context.py` 的
  `required_check` 把「样例要求的来源是否都在」变成可断言的字段。
- **修改可验证**：同一组目标测试在修改前后各跑一次，日志里带命令、退出码和对应代码
  快照；回归测试专门覆盖与页码语义无关的既有契约（不修改入参、返回新 list、接受
  tuple/range），因此修改前也必须通过。
- **状态可续跑**：状态写入与读取走两个进程，避免「同一个进程里的内存变量」冒充持久化。

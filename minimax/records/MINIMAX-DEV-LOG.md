# MiniMax 开发记录

本文件说明 MiniMax 在本次任务里实际做了什么、拿到的上下文是什么、产出的修改如何与
提交的代码差异对应。原始记录（不可改写的机器日志）：

- `records/generations/gen-001.json` —— 完整请求/响应（含 messages、usage、耗时、prompt 指纹）
- `records/minimax-session.jsonl` —— 调用流水（真实调用 + 回放各一条，字段一致）
- `records/prompts/gen-001.md` —— 发给模型的提示词全文
- `records/pagination.diff` —— 模型返回的文件内容与基线的差异

## 1. 任务

`TASK-PAGINATION-001`：修复 `business/app/orderkit/pagination.py` 的边界缺陷。

- `paginate` 的页码改为 1 基；
- `page_size` 只接受 1..100，非法值抛 `ValueError`；
- 超出末页返回 `[]`；
- `page_count` 整除时不多算一页，`total < 0` 抛 `ValueError`；
- 保持函数名、参数顺序、返回类型不变，不修改入参。

## 2. 提供给 MiniMax 的上下文

上下文由 `python -m mmctx context` 从嵌入式 seekdb 检索得到（`records/db-queries.log`
里有对应 SQL），随后渲染成提示词（`records/prompts/gen-001.md`，共 4228 字符）：

| 类别 | 来源 |
| --- | --- |
| 规格 | `materials/specs/pagination.spec.md` 的 SPEC-PAGE-001 / 002 / 003 / 004 / 005 / 006 |
| 代码 | `business/app/orderkit/pagination.py` 的 `paginate`、`page_count` |
| 测试 | `business/tests/test_pagination_target.py`（目标行为）、`business/tests/test_pagination_regression.py`（必须保持的既有行为） |
| 当前实现 | `business/app/orderkit/pagination.py` 全文 |

提示词要求模型只输出 JSON，并且 `content` 必须是修改后的完整文件。

## 3. 模型调用

| 项 | 值 |
| --- | --- |
| 模型 | `MiniMax-M3.1-Flash` |
| 接口 | `POST https://api.minimaxi.com/v1/chat/completions`（OpenAI 兼容） |
| 时间 | 2026-11-10T12:12:45Z（UTC） |
| 耗时 | 69.8 s |
| Token | prompt 1748 / completion 9344（其中推理 8960）/ total 11092 |
| 提示词指纹 | `712059dddca99aea1ca8c38a7aad0a2cb671371ae941b96448f2b473a6344310` |
| 记录文件 | `records/generations/gen-001.json` |

模型返回的 `summary`：

> 修复分页工具的 1 基页码、参数范围校验、超出末页返回空列表及向上取整页数计算。

## 4. 模型产出的修改

`records/snapshots/pagination.after.py` 就是模型返回的 `content` 原文，新增/修改了：

- 新增 `_validate_page_size(page_size)`：非整数、`bool`、越界一律 `ValueError`；
- `paginate`：`page` 校验（非整数 / `bool` / `< 1` 抛 `ValueError`），起点改为 `(page - 1) * page_size`；
- `page_count`：先校验 `page_size`，`total < 0` 抛 `ValueError`，改用 `(total + page_size - 1) // page_size`。

对应差异见 `records/pagination.diff`（33 行文件，+19/−2）。

## 5. 开发过程中的一次规格修正

第一轮生成时，`SPEC-PAGE-001` 只写了「页码从 1 开始、调用方不会传 0 基页码」，没有
规定 `page < 1` 的失败方式。模型据此选择了「`page < 1` 返回空列表」，目标测试
`test_page_below_one_is_rejected` 因此失败（3 个参数化用例）。

处理方式是把规格补全（`SPEC-PAGE-001` 增加「小于 1 或非整数必须抛 `ValueError`」），
重新导入 seekdb（同一 `spec-id` 整篇替换），再生成一次。这轮之后目标测试 18 项、
回归测试 6 项全部通过。

这条记录说明上下文模块的作用边界：**规格没写清楚的行为，模型不会替业务方决定**；
规格变更后重新导入，上下文和生成结果都会跟着变。

## 6. 与提交代码的对应关系

- 提交的业务代码 `business/app/orderkit/pagination.py` 保持**修改前**的基线状态；
- 修改后的文件、diff、测试日志都在 `records/` 里；
- `python -m mmctx demo` 会回放这份生成记录并落盘，`python -m mmctx verify` 给出
  「修改前失败 / 修改后通过 / 回归通过」的对照。

评审环境没有 API Key 时不需要重新调用模型：`--live` 只用于复现真实调用。

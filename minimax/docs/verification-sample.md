# 验证样例

本文件描述仓库内自带的验证样例，评审可完全按此复现。

## 1. 任务描述

> 修复 `paginate` 的分页边界缺陷：`page` 应按 1-based 处理，并补齐 `pageSize` 范围、非法页码、越界页、不修改入参的校验；保持 `pageCount` 与既有调用方兼容。

「要做什么」：让 `demo/test/pagination.test.mjs` 中 6 个失败用例转为通过。
「哪些原有行为必须保留」：P-4 越界返回空数组、P-5 不修改入参、P-6 `pageCount` 语义、P-7 调用方接口不变——这 4 个用例初始就是通过的，修复后必须仍然通过，且不得删除或改写。

## 2. 有效规格

`demo/specs/pagination.md` 共 7 条，本次任务直接适用：

| 条目 | 内容 | 初始状态 |
|---|---|---|
| P-1 | 页码 1-based | 违反（实现按 0-based） |
| P-2 | `pageSize` 1..100，越界抛 `RangeError` | 违反（无校验） |
| P-3 | `page < 1` 抛 `RangeError` | 违反（无校验） |
| P-4 | 越界页返回空数组 | 已满足，需保持 |
| P-5 | 不修改入参 | 已满足，需保持 |
| P-6 | `pageCount` 语义不变 | 已满足，需保持 |
| P-7 | 调用方 `list-articles.mjs` 兼容 | 已满足，需保持 |

## 3. 初始数据

- `demo/src/pagination.mjs`：缺陷实现，`const start = page * pageSize;`（把 1-based 当 0-based）。
- `demo/src/list-articles.mjs`：调用方，依赖 P-6/P-7。
- `demo/test/pagination.test.mjs`：10 个用例，**初始 4 通过 / 6 失败**。
- `demo/specs/pagination.md`：规格来源。

## 4. 操作步骤

```bash
# 0. 依赖：Node 22+、Python 3.11+、MiniMax Key
python -m venv .venv-pc
.venv-pc\Scripts\pip install "powercontext[cli,server] @ git+https://github.com/oceanbase/powercontext.git@master"
.venv-pc\Scripts\powercontext server run --host 127.0.0.1 --port 8000

set MINIMAX_API_KEY=sk-api-...

# 1. 导入资料到 seekdb
npm install
node src/cli.mjs ingest

# 2. 看上下文（应命中 P-1/P-3/P-6/P-7 与两个源文件、测试文件）
node src/cli.mjs context

# 3. 完整闭环
node src/cli.mjs fix

# 4. 新进程读取状态（验证复用）
node src/cli.mjs state
```

## 5. 预期结果

| 检查点 | 预期 |
|---|---|
| `ingest` | `files=4, chunks=12`（spec 9 / code 2 / test 1），写入 seekdb 集合 `ctx_chunks` |
| `context` | `retrieved=12`；specs 含 `pagination.md:5-9`（P-1）；code 含 `pagination.mjs` 与 `list-articles.mjs`；tests 含 `pagination.test.mjs` |
| `fix` | `testsBefore.ok=false`（exit=1）、`testsAfter.ok=true`（exit=0）；`changedFiles=["demo/src/pagination.mjs"]`；生成 `docs/technical-usage.md` |
| 产出代码 | 含 `pageSize` 1..100 校验、`page>=1` 校验、越界返回 `[]`、`start=(page-1)*pageSize` 且 `pageCount` 未改动 |
| `state` | 返回同一 `scopeId`，含 4 条记录（observation / outcome / decision / next-step） |

## 6. 上下文随导入变化（防固定答案）

1. 修改 `demo/specs/pagination.md`，例如把 P-2 的上限从 100 改成 50。
2. 重新执行 `node src/cli.mjs ingest`。
3. 再执行 `node src/cli.mjs context`，返回的规格片段应包含"50"而不是"100"。

该行为由 `ingest` 先按 `document_id` 删除旧片段、再写入新片段保证，模块不会返回写死的答案。

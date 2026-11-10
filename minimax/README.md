# MiniMax × OceanBase · 规有所依：SDD 工程上下文模块

给 AI 开发助手用的工程上下文模块：**从规格、代码和测试里找出这次任务要遵守什么、
要改哪里、怎么验证**，把上下文交给 MiniMax 生成一次真实的代码修改，用测试证明修改
有效，再把任务进展交给 PowerContext，模块重启后继续复用。

业务工程是 `business/` 里一个可运行的订单分页工具，任务是一个真实的边界缺陷修复。

## 六项必做行为与对应证据

| 验收项 | 本作品中的实现 | 直接证据（可复跑） |
| --- | --- | --- |
| 能够运行 | 纯 Python 3.12 + 嵌入式 seekdb，不需要外部数据库服务 | `python -m mmctx demo` 一条命令跑完 |
| MiniMax 实际参与 | 上下文真的作为 prompt 发给 `MiniMax-M3.1-Flash`，返回的补丁逐字落盘 | `records/generations/gen-001.json`（含完整 prompt/response/耗时）、`records/minimax-session.jsonl` |
| 上下文正确 | 检索结果按 规格/代码/测试 分组，验证样例要求的来源全部命中并标记 ★必需；规格改版重新导入后输出立刻使用新内容 | `python -m mmctx context`、`python -m mmctx reimport --spec materials/updates/pagination.spec.v2.md` |
| 数据库实际参与 | 规格/代码/测试片段与向量写入嵌入式 seekdb（`mm_material_chunks` 表），上下文的每一条来源都来自 seekdb 查询 | `records/db-queries.log`（逐条 SQL + 行数 + 耗时）、`python -m mmctx db` |
| 状态能够复用 | 任务进展写入 PowerContext scoped Memory；`demo` 的第 6 步启动**新进程**读回状态，并带进下一次上下文 | `python -m mmctx state`、`records/state-reuse.log` |
| 代码修改有效 | 同一组目标测试在修改前失败、修改后通过；回归测试全程通过 | `python -m mmctx verify`、`records/test-before-*.log` / `records/test-after-*.log` |

## 1. 环境要求

- **Linux x86_64**（或 macOS arm64）；仓库其余部分也要求 Linux，Windows 不支持嵌入式 seekdb。
- **Python 3.12**。
- 不需要单独安装 seekdb / OceanBase / MySQL：`pylibseekdb` 会在本机拉起一个嵌入式实例。
- 依赖固定版本见 [requirements.txt](requirements.txt)：
  `powercontext[builtin]==1.2.0`、`pylibseekdb==1.4.0.post1`、`pymysql`、`pytest`。

## 2. 安装

```bash
cd minimax
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt          # 国内网络可加 -i https://pypi.tuna.tsinghua.edu.cn/simple
```

首次安装会下载约 150 MB（其中 `pylibseekdb` 51 MB），需要网络。

## 3. 一次跑完六项（推荐）

```bash
python -m mmctx demo
```

依次执行：

1. 清空 `data/`（从空状态开始），初始化嵌入式 seekdb 并导入工程资料；
2. 构造开发上下文，打印命中的规格/代码/测试来源与「必需来源核对」；
3. 回放（或 `--live` 实时调用）MiniMax 生成的补丁 → 落盘 → 运行目标测试与回归测试；
4. 把规格从 v1 改为 v2 重新导入，再取一次上下文，输出必须变成 v2 的内容；
5. 把任务状态写入 PowerContext；
6. **启动新进程**读回状态，并把它带进后续上下文。

完整输出会同时写到 `records/demo-run.log`。

### 本次提交实际跑出的结果（Linux x86_64 / Python 3.12.3）

```text
[1/6] 清空 data/（空状态开始），初始化 seekdb 并导入资料
  · 导入 PAGINATION-SPEC: 6 个片段（spec）
  · 导入 business/app/orderkit/pagination.py: 2 个片段（code）
  · 导入 business/tests/test_pagination_target.py: 12 个片段（test）
  · seekdb 统计：{"code": 3, "spec": 6, "test": 18}
[2/6] 构建开发上下文（规格 v1）
  · 必需来源 8/8 全部命中（见 records/demo-run.log）
[3/6] 交给 MiniMax 生成修改，并运行目标测试
  · 回放 MiniMax 记录 gen-001.json（原模型 MiniMax-M3.1-Flash，69791 ms）
  · 代码差异 38 行 → records/pagination.diff
  · 目标测试：exit=0 passed=18 failed=0
  · 回归测试：exit=0 passed=6 failed=0
[4/6] 规格变更（v1 → v2）后重新导入，上下文必须跟着变
  · 变更前 SPEC-PAGE-002：page_size 必须是 1 到 100（含）之间的整数…
  · 变更后 SPEC-PAGE-002：page_size 必须是 1 到 50（含）之间的整数…
  · 来源：materials/updates/pagination.spec.v2.md:21-27
  · 上下文是否使用新规格：是
[5/6] 把任务状态写入 PowerContext
  · 已写入 scope scp_…（PowerContext Memory）
[6/6] 重启模块（新进程）后读回状态，并用于后续上下文
  · 子进程读回 status=done，已完成 5 项
  · 该状态已进入提示词：是
```

`python -m mmctx verify` 的同一次运行结果：

```text
[2/5] 修改前运行目标测试（应失败）
  · exit=1 passed=2 failed=16
[3/5] 应用修改后代码并运行同一组目标测试（应通过）
  · exit=0 passed=18 failed=0
[4/5] 运行回归测试
  · exit=0 passed=6 failed=0
结论：修改前失败 / 修改后通过 / 回归通过 ✔
```


## 4. 分步调用（每个入口都可单独运行）

```bash
python -m mmctx init                     # 初始化 seekdb + 导入 materials/ 与 business/ 的资料
python -m mmctx context                  # 打印本次任务的上下文（--json 输出完整 JSON）
python -m mmctx reimport --spec materials/updates/pagination.spec.v2.md
python -m mmctx generate --live          # 真实调用 MiniMax（需要 MINIMAX_API_KEY）
python -m mmctx generate                 # 回放 records/generations/gen-001.json
python -m mmctx apply --generation records/generations/gen-001.json
python -m mmctx test --which target      # target | regression | all
python -m mmctx state                    # 读取 PowerContext 里保存的任务状态（--json）
python -m mmctx db                       # seekdb 统计；--sql 'SELECT ...' 直接查询
python -m mmctx verify                   # 修改前失败 / 修改后通过 / 回归通过 的证据
python -m mmctx reset                    # 恢复基线代码并清空 data/
```

实时调用 MiniMax：

```bash
export MINIMAX_API_KEY=sk-api-...
python -m mmctx generate --live --generation-id gen-live
```

## 5. 验证样例（要改什么 / 哪些行为必须保持）

- 任务描述与必须出现的来源：[samples/task.json](samples/task.json)
- 有效规格：[materials/specs/pagination.spec.md](materials/specs/pagination.spec.md)（`PAGINATION-SPEC` v1）
- 规格变更样例：[materials/updates/pagination.spec.v2.md](materials/updates/pagination.spec.v2.md)（同 `spec-id`，v2 把 `page_size` 上限从 100 收紧到 50）
- 业务工程：[business/app/orderkit/pagination.py](business/app/orderkit/pagination.py)（基线，带缺陷）
- 目标测试（修改前失败、修改后通过）：[business/tests/test_pagination_target.py](business/tests/test_pagination_target.py)
- 回归测试（修改前后都必须通过）：[business/tests/test_pagination_regression.py](business/tests/test_pagination_regression.py)

要改什么：`paginate` 的 `page` 改 1 基、`page_size` 限制 1..100、超出末页返回 `[]`；
`page_count` 整除不多算一页、`total<0` 抛 `ValueError`。

必须保持：函数名/参数顺序/返回类型不变、不修改入参、返回新的 `list`、接受 tuple/range。

重置方法：`python -m mmctx reset`。

## 6. 测试

```bash
python -m mmctx test --which all     # 业务目标测试 + 回归测试
pytest tests -q                      # 上下文模块自身的单元测试（不依赖 seekdb）
python -m mmctx verify               # 修改前/后对照证据
```

## 7. 目录结构

```
minimax/
├── mmctx/                 # 上下文模块
│   ├── materials.py       # 规格/代码/测试 → 片段
│   ├── embed.py           # 离线确定性向量
│   ├── seekdb_store.py    # 嵌入式 seekdb：表结构、写入、向量+关键词检索
│   ├── context.py         # 选材、必需来源补位、状态回填
│   ├── prompting.py       # 渲染 prompt、解析模型 JSON
│   ├── minimax_client.py  # MiniMax 调用 + 调用记录
│   ├── state.py           # PowerContext scoped Memory 读写
│   └── pipeline.py        # 各子命令与演示流程
├── business/              # 被修改的业务工程（可独立运行）
├── materials/             # 规格与规格变更样例
├── samples/task.json      # 验证样例
├── tests/test_module.py   # 模块自测
└── records/               # MiniMax 记录、数据库查询、测试日志、前后快照与 diff
```

## 8. 技术使用记录

| 记录 | 文件 |
| --- | --- |
| MiniMax 开发记录（prompt / response / 耗时 / token） | `records/minimax-session.jsonl`、`records/generations/gen-001.json`、`records/prompts/gen-001.md` |
| seekdb 查询记录（逐条 SQL、行数、耗时） | `records/db-queries.log` |
| PowerContext 状态写入与复用记录 | `records/state-reuse.log`、`records/demo-run.log` 第 5–6 步 |
| 测试结果（命令、退出码、输出） | `records/test-before-*.log`、`records/test-after-*.log`、`records/verification.json` |
| 代码前后快照与 diff | `records/snapshots/pagination.before.py`、`records/snapshots/pagination.after.py`、`records/pagination.diff` |

## 9. 已知限制

- 嵌入式 `pylibseekdb` 只提供 Linux/macOS 轮子，Windows 无法运行本模块。
- 向量是离线的特征哈希向量（不下载模型、不调用 embedding 服务），检索质量针对
  「规格/代码/测试里是否出现任务领域词」这一目标调优，不追求通用语义检索。
- 默认回放已记录的 MiniMax 调用，不重新请求模型；只有设置 `MINIMAX_API_KEY` 并加
  `--live` 才会真实调用。仓库不包含任何密钥。
- `data/` 是可重建的运行时数据（seekdb 实例、PowerContext SQLite），不提交。

# 上下文模块：seekdb 检索 + MiniMax 改码 + PowerContext 状态

面向 AI 开发助手的上下文模块。给定一句任务描述，它从工程资料里检索出**适用的规格条目、需要修改的代码、相关测试**，把上下文交给 MiniMax 生成修改，跑测试验证，并把任务状态写进 PowerContext，供下一次会话读取。

## 三项技术的分工

| 技术 | 在本项目里的实际作用 |
|---|---|
| **seekdb** | 存储规格/代码/测试的片段与向量，检索用 `hybridSearch`（全文 + 向量 + RRF）在库内完成 |
| **MiniMax** | 收到上下文后生成完整的修正文件内容，是本模块唯一的代码生成来源 |
| **PowerContext** | 通过 HTTP 写入任务观察、决策、结果、下一步；重启进程后按 scope 读回 |

## 前置条件

- Node.js **22+**
- Python **3.11+**（PowerContext Server）
- MiniMax API Key（`sk-api...` / `sk-cp...`）

## 启动

### 1. PowerContext Server

```bash
python -m venv .venv-pc
.venv-pc\Scripts\pip install "powercontext[cli,server] @ git+https://github.com/oceanbase/powercontext.git@master"
.venv-pc\Scripts\powercontext server run --host 127.0.0.1 --port 8000
```

`curl http://127.0.0.1:8000/health/live` 返回 `{"status":"ok"}` 即可。

> Windows 上如遇 pip 缓存权限或路径过长，先执行 `git config --global core.longpaths true`，并把 `TEMP` 指到一个短路径目录。

### 2. MiniMax Key

任选一种：

```bash
set MINIMAX_API_KEY=sk-api-...
# 或把 key 写到项目根目录的 minimax-key.txt（只放一行）
```

### 3. 本模块

```bash
npm install
npm run ingest                     # 导入 demo/specs、demo/src、demo/test 到 seekdb
node src/cli.mjs context           # 只做检索，看上下文
node src/cli.mjs fix               # 检索 → MiniMax 改码 → 跑测试 → 写状态
node src/cli.mjs state             # 新进程读取同一 scope 的任务状态
npm start                          # HTTP 服务，127.0.0.1:8080
```

## 调用入口

| 入口 | 说明 |
|---|---|
| `node src/cli.mjs ingest` | 重建 seekdb 索引 |
| `node src/cli.mjs context --task "…"` | 返回检索到的规格/代码/测试 |
| `node src/cli.mjs fix --task "…"` | 完整闭环：检索 → MiniMax → 打补丁 → 测试 → 状态 |
| `node src/cli.mjs state` | 读取 PowerContext 中的任务状态 |
| `GET /api/health` | 服务、seekdb、PowerContext 状态 |
| `POST /api/ingest` | 触发重新导入 |
| `GET /api/context?task=…` | 上下文检索 |
| `GET /api/state` / `GET /api/state/search?q=…` | 状态读取 / 检索 |

## 测试

```bash
npm run test:demo     # demo 工程的 10 个用例；修复前应有失败
```

`node src/cli.mjs fix` 会自己跑一遍，并在 `docs/technical-usage.md` 记录前后结果、MiniMax 调用明细、检索命中与代码差异。

## 目录

```
src/vector.mjs       256 维特征哈希向量（离线、无外部依赖）
src/store.mjs        seekdb 连接、写入、混合检索
src/ingest.mjs       规格按标题切分、代码按 60 行切分
src/context.mjs      按 kind 分组，产出规格/代码/测试三份材料
src/minimax.mjs      MiniMax 客户端（模型降级、重试、剥离思维链）
src/powercontext.mjs scope 创建（幂等）、memory 写入/检索/列举
src/patch.mjs        写文件、跑 node --test、解析模型 JSON
src/cli.mjs          ingest / context / fix / state 四个命令
src/server.mjs       HTTP 入口
demo/                带缺陷的分页模块 + 规格 + 测试
```

## 已知限制

- 向量是本地特征哈希，不是语义模型；英文靠词、中文靠双字，足够做「领域词命中」，但不懂同义改写。
- `fix` 只允许写 `demo/src/` 下的文件，防止模型改到工具自身。
- 生成的内容必须能通过已有测试；连续两次失败会自动回滚并如实记录。
- PowerContext 未配置生成/embedding 模型，状态检索走它的文本模式。

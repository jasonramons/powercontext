# 记忆旅馆 Memory Inn —— 运行说明

> 一家会记住客人的旅馆。你每次来，老板都记得你上次说了什么、欠了什么。
> **Dify** 负责讲故事，**seekdb** 负责「这间房为什么是这样」，**PowerContext** 负责「你来过几次、说过什么」。

一句话玩法：你输入一句想做的事，Dify 先把行动交给后端判定、写入记忆，再从 29 条世界档案里向量检索出这一回合的房间/住客/传闻/物品，最后让 LLM 用「世界事实 + 你的记忆」写出一段 200 字以内的场景。**同一句话，玩得越久越不一样，因为老板记得你。**

## 0. 最快跑通（3 条命令）

```bash
npm install && pip install -r requirements.txt   # 依赖（Python 缺失也能继续，见 3.2 降级说明）
npm start                                        # 一条命令拉起记忆边车 + 世界服务（8789）
npm run verify                                   # 端到端断言；服务未启动时会自动拉起临时实例
```

跑通后再按第 3.4 节把 `memory-inn.dsl.yml` 导入 Dify，即可在对话页按 1.1 的三步体验。

---

## 1. 作品、玩法与体验方式

### 1.1 三分钟体验

导入 DSL 并发布后，在 Dify 的应用对话页依次输入：

| 顺序 | 输入 | 你应该看到 |
|---|---|---|
| 1 | `我问老板：你还记得我吗？` | 一段潮湿、安静的旅馆场景；结尾给一个可以立刻行动的选择提示 |
| 2 | `我去第七号信箱投一封信` | 新场景换了房间与住客，并且**提到第 1 回合你问过「记不记得」** |
| 3 | `我照了照镜子` | 又一次换场；叙述里会带上前面回合的记忆（由 Dify 的 LLM 节点写进场景） |

第 2、3 步能"被记住"，不是提示词里写死了例子，而是：

```
玩家输入 ──► /inn/act     把这一回合写进 PowerContext（记忆）
        ──► /inn/scene   PowerContext 按意图召回历史 + seekdb 按意图检索世界事实
        ──► LLM 节点     只负责把「事实 + 记忆」写成场景
```

### 1.2 核心机制

| 机制 | 体验 |
|---|---|
| 记忆债务 | 每个行动写一条记忆。第 N 回合的老板会引用第 1 回合你说的话 |
| 世界由检索生成 | 房间、住客、传闻、物品不是写死的分支，而是按你这回合的行动在 29 条档案里做向量检索选出来的：换个说法就会换房间、换住客；同一句话稳定命中同一条，便于复现 |
| 跨会话保留 | 记忆存在 PowerContext 的 SQLite 库里，关掉对话重开，老板仍然记得你（换 `player` 名则换一个人） |
| 行动有代价 | 每个行动都会被记成「第几回合、做了什么」，形成可回看的冒险记录 |

### 1.3 技术分工（必须说明的部分）

| 组成 | 在本作品中的实际作用 | 代码位置 |
|---|---|---|
| **Dify**（必选） | 应用入口与核心流程编排：开场白/建议问题、收集 `player`、顺序调用两个 HTTP 工具节点、LLM 叙述者节点、回答输出。DSL 见 `memory-inn.dsl.yml` | `memory-inn.dsl.yml` |
| **seekdb**（选一种） | 应用数据存储与向量检索：29 条世界档案（8 房间 / 8 住客 / 8 传闻 / 5 物品）写入 seekdb 集合 `inn_lore`，每回合用 384 维向量做 HNSW cosine 检索，取 top-k 作为「世界事实」 | `server/store.mjs`、`data/lore.json` |
| **PowerContext**（选一种） | 记忆与上下文：每条记忆以 `玩家「X」第 N 回合：…` 写入 scoped memory，换场时按意图检索、召回不到时按玩家名兜底，实现跨回合/跨会话记忆复用；使用 SQLite 持久化。边车不可用时自动改用本地 JSON 记忆库（规则不变） | `bridge/app.py`、`server/memory.mjs` |

Dify 与两个技术的分工不重叠：Dify 只做编排与叙述，事实来自 seekdb，记忆来自 PowerContext。

---

## 2. 运行环境与版本

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22（实测 v26.13.0；`@oceanbase/seekdb-node` 要求 ≥ 22） | 运行 `server/` 世界服务 |
| Python | ≥ 3.11（实测 3.13） | 运行 `bridge/app.py` 记忆边车 |
| Dify | 1.15.x（DSL `version: "0.6.0"`，应用模式 `advanced-chat` / Chatflow） | 承载应用与编排 |
| `@oceanbase/seekdb-node` | 1.4.0 | 嵌入式启动 seekdb 实例 |
| `seekdb`（npm） | 1.4.0 | seekdb 集合与向量检索客户端 |
| `express` | 4.22.3 | 世界服务 HTTP 框架 |
| `powercontext`（PyPI） | **1.2.0**，extra `[builtin]` | PowerContext 内置 runtime + SQLite 持久化 |
| `jieba` | 0.42.1 | PowerContext 全文检索的中文分词 |

### 2.1 模型服务

DSL 里「叙述者」节点默认使用：

- provider：`langgenius/tongyi/tongyi`，模型 `qwen-plus`，`temperature 0.9`、`max_tokens 512`；
- 需要在 Dify 中安装 **通义千问 / Tongyi** 模型插件（Dify 插件市场，插件名 `langgenius/tongyi`），并填入阿里云 DashScope 的 API Key；
- 若没有通义 Key：把「叙述者」节点的模型换成你已配置的任意对话模型（OpenAI / DeepSeek / 本地模型均可），**提示词和变量不用改**——模型只负责把 `http_act.body` 与 `http_scene.body` 的 JSON 写成场景。

> 叙述质量取决于所选模型；seekdb 与 PowerContext 的数据都不依赖模型，可离线验证。

---

## 3. 安装与启动（完整步骤）

### 3.1 安装依赖

```bash
# 1) Node 依赖（世界服务 + seekdb 客户端）
npm install

# 2) Python 依赖（PowerContext 边车）
python -m venv .venv
# Windows: .venv\Scripts\activate      Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
```

`requirements.txt` 只含两项：`powercontext[builtin]==1.2.0` 与 `jieba==0.42.1`。
**必须带 `[builtin]`**：`bridge/app.py` 用的是 `powercontext.builtin.runtime`（内置 runtime + SQLite 持久化），只装 `powercontext` 或 `[cli,server]` 会在 `open_builtin_runtime` 处报 `ModuleNotFoundError`。

### 3.2 启动（一条命令）

```bash
npm start
```

`npm start` 会**按可用性自动组装整条链路**并打印每一步：

1. 若 8767 上已有 PowerContext 边车则复用；否则在找到「已安装 `powercontext[builtin]` 的 Python」时自动拉起边车；
2. 启动世界服务（seekdb 嵌入式 + HTTP，监听 8789）。

预期输出（完整环境）：

```
[memory-inn] 启动记忆边车：python bridge/app.py
[bridge] ready scope=scp_xxxxxxxxxxxxxxxxxxxxx
[bridge] http://127.0.0.1:8767
[memory-inn] 记忆边车就绪
[memory-inn] http://127.0.0.1:8789  seekdb 127.0.0.1:59336  lore=29
```

也可以按老办法分两个终端起（便于看各自日志）：

```bash
npm run bridge   # 终端 1：记忆边车（PowerContext，8767）
npm run server   # 终端 2：世界服务（seekdb + HTTP，8789）
```

**降级行为**（评委环境可能缺 Python 或缺少 seekdb 原生二进制，这两种情况都不会让应用起不来）：

| 缺失 | 行为 |
|---|---|
| Python / `powercontext` | 记忆退回本地 JSON 库（`data/memory.json`），**写入/召回规则不变**，`/health` 的 `powercontext.backend="local"` |
| seekdb 原生二进制 | 自动退回纯 JS 内存检索（同一套向量与余弦相似度），`/health` 的 `seekdb.mode="memory"` |

也就是说：**任何一种降级都不会改变玩法**（每回合写记忆、下回合召回、房间由检索决定），只会换掉底层实现，`/health` 会如实标出当前后端。

首次启动 `npm start` 时 `@oceanbase/seekdb-node` 会在 `data/seekdb.db/` 下落地嵌入式实例（含本地 `seekdb` 可执行文件），需要几十秒；数据目录已在 `.gitignore` 中，不需要随仓库提交。

### 3.3 数据初始化

**不需要手工建表或导入数据**，两个服务启动时自动完成：

| 步骤 | 谁做 | 做了什么 |
|---|---|---|
| 世界档案入库 | `npm start` | 读取 `data/lore.json`，写入 seekdb 集合 `inn_lore`（`upsert` 29 条，`dimension=384`、`distance=cosine`、HNSW 索引） |
| 记忆作用域 | `npm start` 内的记忆边车 | 在 PowerContext 建立 `memory-inn` scope（幂等，重启复用同一个 scope） |

初始化是幂等的：重复启动不会重复插入（`upsert` 覆盖同 id）。

### 3.4 Dify 侧：导入 DSL 并发布

1. Dify → **工作室 / 应用** → **导入 DSL 文件**，选择 `memory-inn.dsl.yml`；
2. 打开应用 → **编排**，确认节点链路为 `start → http_act → http_scene → llm_narrate → answer`；
3. 打开 **环境变量**，确认 `INN_BASE_URL = http://127.0.0.1:8789`
   - Dify 跑在 Docker 里、服务跑在宿主机时改成 `http://host.docker.internal:8789`；
   - Dify 与服务在同一 docker network 时用服务名，例如 `http://memory-inn:8789`；
4. 把「叙述者」节点的模型换成你已配置的对话模型（见 2.1）；
5. **发布**，进入应用对话页，按 1.1 的三步开始玩。

**DSL 文件与导入顺序**：`memory-inn.dsl.yml` 是唯一 DSL（`mode: advanced-chat`，即 Chatflow），一次导入即可；本作品不依赖知识库、不依赖自定义插件、不依赖 Dify 内置工具，因此没有第二个 DSL 或额外导入顺序。

### 3.5 应用入口

- 主入口：Dify 应用对话页（DSL 内的 Chatflow 应用，带开场白与三条建议问题）；
- 调试入口：世界服务 `http://127.0.0.1:8789`（`/health`、`/inn/scene`、`/inn/act`、`/inn/recall`）。

---

## 4. 复现验证

```bash
npm run verify          # 核心链路断言；服务未启动时会自动拉起临时实例并在结束时关闭
npm run verify:strict    # 严格模式：要求 PowerContext 记忆链路也全过（11/11）
npm run usage            # 逐个接口记录真实调用，写入 docs/evidence/usage.json（需服务运行）
```

`npm run verify` 不需要先手动启动服务：脚本先探测 8789，未运行就自动拉起一个临时实例（并尝试拉起记忆边车），验证完自动关闭。

实测结果（2026-11-10，本机 Node 26.13.0 / Python 3.13.15，`--strict` 全量模式）：

```
ok   服务健康  (lore=29 seekdb=seekdb)
ok   PowerContext 在线  ({"ok":true,"base":"http://127.0.0.1:8767"})
ok   第 1 回合生成场景  (room=无声走廊 guest=雨中的旅人)
ok   场景由向量检索得出  (room_02)
ok   行动被接受  (turn=1)
ok   行动触发线索检索  (clues=2)
ok   行动写入记忆  (true)
ok   第 2 回合带回记忆  ("玩家「tester」第 3 回合：我照了照镜子")
ok   回忆接口命中  ({"text":"玩家「tester」第 1 回合：我问老板：你还记得我吗？","score":0.01639344262295082})
ok   多回合推进  (turn=3)
ok   不同行动命中不同线索  (有人说，只要在第七号信箱 vs 镜面餐厅)

pass: 11/11
```

没有 Python 的环境下同一条命令仍然 **11/11 通过**（记忆后端切到本地 JSON 库，玩法不变）：

```
ok   服务健康  (lore=29 seekdb=seekdb)
ok   记忆后端可用  (backend=local)
ok   第 1 回合生成场景  (room=无声走廊 guest=雨中的旅人)
ok   场景由向量检索得出  (room_02)
ok   行动被接受  (turn=1)
ok   行动触发线索检索  (clues=2)
ok   行动写入记忆  (backend=local)
ok   下一回合带回记忆  ("玩家「tester」第 1 回合：我问老板：你还记得我吗？")
ok   回忆接口命中  ({"text":"玩家「tester」第 1 回合：我问老板：你还记得我吗？","score":1})
ok   多回合推进  (turn=3)
ok   不同行动命中不同线索  (有人说，只要在第七号信箱 vs 镜面餐厅)

pass: 11/11
```

**声明与断言一一对应**（上面输出的每一条断言，都对应本文先前的一个规则声明）：

| 声明（见 1.2） | 对应断言 |
|---|---|
| 每回合的行动都会写入记忆 | `行动写入记忆` |
| 下一回合会把历史记忆带回来 | `下一回合带回记忆` + `回忆接口命中` |
| 房间/住客由检索决定、不是写死分支 | `场景由向量检索得出` |
| 换一种行动会命中不同线索 | `不同行动命中不同线索` |
| 多回合持续推进 | `多回合推进` |
| 服务与记忆后端可用 | `服务健康` + `记忆后端可用` + `第 1 回合生成场景` + `行动被接受` + `行动触发线索检索` |

完整输出、接口级调用记录与日志见：`docs/verification.md`、`docs/technical-usage.md`、`docs/evidence/`。

### 4.1 恢复初始状态

```bash
# 清空某个玩家的剧情状态（记忆仍保留）
curl -X POST http://127.0.0.1:8789/inn/reset -H "content-type: application/json" -d "{\"player\":\"tester\"}"

# 彻底回到初始状态：停掉两个服务，删除运行时数据
rm -rf data/seekdb.db data/state.json data/powercontext.db*
```

---

## 5. 外部服务、网络与资源

| 项 | 要求 |
|---|---|
| 网络 | 安装依赖时需要访问 npm registry 与 PyPI；运行期除 Dify 调用模型外**完全离线**（seekdb 本地实例、PowerContext 本地 SQLite） |
| 端口 | 8789（世界服务）、8767（记忆边车）；Dify 需能访问 8789 |
| 内存 | seekdb 默认 `memory_budget=2G`；两个服务合计实测常驻 < 300 MB |
| 磁盘 | 依赖约 350 MB（含 seekdb 本地二进制）；数据目录几十 MB |
| 凭据 | 仅 Dify 内的模型 API Key；仓库内不含任何真实 Key、密码或令牌 |

---

## 6. 目录与文件用途

```
dify/
├── memory-inn.dsl.yml        # Dify Chatflow DSL（唯一 DSL，直接导入）
├── README.md                 # 本文件：运行说明
├── TECH.md                   # 一页技术说明（架构、数据模型、取舍）
├── package.json              # Node 依赖清单（世界服务 + seekdb 客户端）
├── package-lock.json         # 锁定实际安装版本
├── requirements.txt          # Python 依赖清单（PowerContext 边车）
├── data/
│   └── lore.json             # 29 条世界档案（8 房间 / 8 住客 / 8 传闻 / 5 物品）
├── bridge/
│   └── app.py                # PowerContext 边车：/memory/remember、/memory/search、/health
├── server/
│   ├── index.mjs             # 世界服务：/inn/scene、/inn/act、/inn/recall、/inn/reset
│   ├── store.mjs             # seekdb：集合创建、29 条 upsert、HNSW 向量检索
│   ├── memory.mjs            # PowerContext HTTP 客户端
│   └── embed.mjs             # 离线确定性 384 维向量（不下载模型）
├── scripts/
│   ├── start.mjs             # 一条命令拉起边车 + 世界服务（缺 Python/seekdb 时自动降级）
│   ├── start-bridge.mjs      # 单独启动 PowerContext 边车（自动探测 python3/python/py）
│   ├── find-python.mjs       # 探测可用的 Python 解释器（跨 Windows/macOS/Linux）
│   ├── verify.mjs            # 端到端 11 条断言（服务未启动时自动拉起临时实例）
│   └── record-usage.mjs      # 接口级调用记录 → docs/evidence/usage.json
└── docs/
    ├── technical-usage.md    # 技术使用记录（seekdb / PowerContext 实际调用与结果）
    ├── verification.md       # 验证样例与运行证据
    └── evidence/             # 真实日志、转写与 JSON 记录
```

---

## 7. 已知限制

- `server/embed.mjs` 是**离线确定性哈希 n-gram** 向量（384 维），不依赖模型下载，代价是同义改写（"镜子" vs "明镜"）召回不稳；这是为了「无网络也能复现」做的取舍。
- 叙述文本由 Dify 内的模型生成，离线环境下无法产生真实叙述；离线验证覆盖的是事实与记忆两条链路（`npm run verify`）。
- 单机演示：`player` 只做字符串标识，没有账号体系；`/inn/reset` 只清剧情状态，不清记忆。
- `bridge/app.py` 的 `/memory/search` 使用 PowerContext 的 FTS 模式，中文依赖 `jieba` 分词；多词查询按「全部命中」处理，因此跨回合召回在意图词不匹配时靠 `player` 兜底（见 `server/index.mjs` 的 `recall` 回退逻辑）。
- 降级模式下（无 Python / 无 seekdb 二进制）应用与玩法规则都保持不变，只是底层实现换成本地 JSON 记忆库 / 内存向量检索；`docs/evidence/` 同时保留了完整模式与两种降级模式的实测转写（`verify-transcript.txt`、`verify-standalone-full.txt`、`verify-standalone-degraded.txt`、`verify-memory.txt`）。

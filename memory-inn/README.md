# 记忆旅馆 · Memory Inn

> 一家会记住客人的旅馆。你每次来，老板都记得你上次说了什么、欠了什么。
> Dify 负责讲故事，seekdb 负责"这间房为什么是这样"，PowerContext 负责"你来过几次"。

## 玩法（3 分钟）

打开 Dify 里的 Chatflow，开场白之后直接输入你想做的事：

```
我问老板：你还记得我吗？
```

系统会做三件事：判定这个行动、从档案里找出它触碰到的房间/住客/传闻/物品、把你这次行动写进记忆。然后叙述者用这些事实写出一段 200 字以内的场景。

再输入：

```
我去第七号信箱投一封信
```

你会发现老板记得你刚才问过"记不记得"——因为记忆被检索出来，塞进了这一回合的提示词。这就是这个游戏的核心：**你会被记住**。

## 为什么好玩

| 机制 | 体验 |
|---|---|
| 记忆债务 | 每回合的行动都会写入记忆。第 N 回合的老板会引用第 1 回合你说的话，甚至用"你上次也是这么说的"来噎你 |
| 世界由检索生成 | 房间、住客、传闻、物品不是写死的分支，而是按你的行动在 29 条档案里做向量检索选出来的，同一个动作在不同上下文中会撞见不同的人和事 |
| 跨局保留 | 记忆存在 PowerContext 里，关掉对话、换一个会话，老板仍然记得你 |
| 行动有代价 | 判定服务会给每个行动写一条"第几回合、做了什么"，形成可回看的冒险记录 |

## 技术分工

```
玩家 ──► Dify Chatflow ──► 记忆旅馆服务（Node）
                │                ├─ seekdb（嵌入式）：29 条档案的向量检索
                │                └─ PowerContext（Python 边车）：玩家记忆的写入与召回
                └─ LLM 叙述者：只负责把"事实 + 记忆"写成场景
```

- **Dify（必须）**：承载对话入口、LLM 叙述者节点、两个 HTTP 工具节点，是整个应用的编排层。DSL 见 `dify/memory-inn.dsl.yml`。
- **seekdb（选一种）**：`/inn/scene` 和 `/inn/act` 里所有"这回合遇到什么"都来自 seekdb 的 HNSW 向量检索（29 条档案：8 房间 / 8 住客 / 8 传闻 / 5 物品）。
- **PowerContext（选一种）**：每次行动写一条记忆（`玩家「X」第 N 回合：…`），每次换场按意图召回，召回不到就按玩家名兜底。

## 运行

需要 Node.js ≥ 20、Python ≥ 3.11。

```bash
# 1) 依赖
npm install
pip install "powercontext[cli,server]"

# 2) 记忆边车（终端 1）
npm run bridge          # http://127.0.0.1:8767

# 3) 世界服务（终端 2）
npm start               # http://127.0.0.1:8789

# 4) 端到端自检（终端 3）
npm run verify
```

Dify 侧：

1. 在 Dify 里 **导入 DSL**：`dify/memory-inn.dsl.yml`；
2. 打开应用 → 编排 → 环境变量，确认 `INN_BASE_URL = http://127.0.0.1:8789`（Dify 跑在容器里时改成 `http://host.docker.internal:8789`）；
3. 把「叙述者」节点的模型换成你自己可用的模型（默认写的是通义 qwen-plus）；
4. 发布，开始玩。

## DSL 阅读顺序

`dify/memory-inn.dsl.yml` 只有一个文件，按这个顺序读：

1. `app` 段：应用名、模式（chat）、开场白与建议问题；
2. `workflow.environment_variables`：`INN_BASE_URL`，改这里就能把 Dify 指向你自己的服务；
3. `workflow.graph.nodes`：五个节点
   - `start` —— 收集玩家名（`player`）
   - `http_act` —— 调 `/inn/act`，判定 + 写记忆
   - `http_scene` —— 调 `/inn/scene`，seekdb 检索场景 + PowerContext 召回记忆
   - `llm_narrate` —— 叙述者提示词，把两份 JSON 变成一段场景
   - `answer` —— 输出
4. `workflow.graph.edges`：线性链路 `start → http_act → http_scene → llm_narrate → answer`。

## 验证

`npm run verify` 会跑 11 条断言（真实输出见 `docs/verification.md`）：

- 服务健康、PowerContext 在线、seekdb 索引 29 条；
- 第 1 回合能生成房间/住客/传闻，且房间 id 来自检索；
- 行动被接受、写入记忆、触发线索检索；
- 第 2 回合能把上一回合的记忆带回来；
- 独立回忆接口命中；
- 多回合推进，不同行动命中不同线索。

## 目录

```
memory-inn/
├── bridge/app.py            # PowerContext 边车（记忆写入/召回）
├── data/lore.json           # 29 条世界档案（房间/住客/传闻/物品）
├── dify/memory-inn.dsl.yml  # Dify Chatflow DSL
├── scripts/verify.mjs       # 端到端验证
├── server/
│   ├── embed.mjs            # 离线确定性向量
│   ├── index.mjs            # /inn/scene /inn/act /inn/recall
│   ├── memory.mjs           # PowerContext 客户端
│   └── store.mjs            # seekdb 集合与检索
└── docs/verification.md
```

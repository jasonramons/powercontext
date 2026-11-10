# 记忆旅馆 —— 一页技术说明

## 1. 一句话

用 Dify 编排一个"会记住客人"的文字旅馆：**seekdb 决定这一回合你遇到什么，PowerContext 决定老板记得你什么，Dify 只负责把两者写成故事。**

## 2. 架构

```
玩家 ──对话──►
   │
   ▼
Dify 1.15.x（advanced-chat / Chatflow）
   start(player) ──► http_act ──► http_scene ──► llm_narrate ──► answer
                        │             │
                        ▼             ▼
            世界服务 server/（Node, :8789）
              ├─ /inn/act   ──► seekdb：线索检索（29 条档案 top-k）
              │                 PowerContext：写入这一回合的记忆
              └─ /inn/scene ──► seekdb：房间/住客/传闻/物品各 top-1
                                PowerContext：召回该玩家的历史记忆
                        │
                        ▼
            两段 JSON 作为提示词变量进入 llm_narrate，写成 200 字以内的场景
```

链路是**线性**的，没有条件分支：判定（写记忆 + 取线索）→ 取场景（检索 + 召回）→ 叙述 → 输出。

## 3. 一个回合发生了什么

| # | 执行者 | 输入 | 输出 | 用到的技术 |
|---|---|---|---|---|
| 1 | Dify `start` | 玩家一句话 + `player` 变量 | `sys.query` / `start.player` | Dify 变量系统 |
| 2 | Dify `http_act` → `POST /inn/act` | `{player, action}` | `{turn, accepted, memory_written, clues[]}` | 命中 seekdb（线索）+ PowerContext（写记忆） |
| 3 | Dify `http_scene` → `POST /inn/scene` | `{player, intent}` | `{room, guest, rumor, prop, memories[], visited}` | 命中 seekdb（4 类档案各 top-1）+ PowerContext（召回） |
| 4 | Dify `llm_narrate` | 上两步的 JSON + `sys.query` | 一段 200 字以内场景 | Dify LLM 节点 |
| 5 | Dify `answer` | `llm_narrate.text` | 回复玩家 | Dify 输出 |

两条 HTTP 的 body 与 `server/index.mjs` 的入参逐字段一致，见 `docs/technical-usage.md`。

## 4. 数据模型

### 4.1 seekdb：世界档案

- 集合：`inn_lore`，`configuration.hnsw = {dimension: 384, distance: cosine}`，`embeddingFunction: null`（向量由应用侧计算，避免依赖模型下载）；
- 主键：`<kind>:<id>`，例如 `rooms:room_05`；
- `document`：`name\ntext\nline/use\ntags`，用于检索与直接拼提示词；
- `metadata`：`{kind, key, name, tags}`，其中 `kind ∈ {rooms, guests, rumors, props}`，检索后按 `kind` 过滤，保证"房间/住客/传闻/物品"各取一条而不是四条同类；
- 规模：8 房间 + 8 住客 + 8 传闻 + 5 物品 = **29 条**（`data/lore.json`，原创内容）。

写入使用 `collection.upsert`，**幂等**：重复启动不会产生重复记录。

### 4.2 PowerContext：玩家记忆

- scope：`memory-inn`（`ScopeDraft(idempotency_key="memory-inn")`，重启复用同一个 `scope_id`）；
- 记忆条目：`kind="inn-event"`，文本形如 `玩家「tester」第 2 回合：我去第七号信箱投一封信`；
- 持久化：`SQLiteConfig(url="sqlite+aiosqlite:///data/powercontext.db")`，跨进程/跨会话保留；
- 检索：`SearchMemoryRequest(query, mode="fts", limit)`；多词查询为"全部命中"，因此召回为空时用 `player` 兜底再查一次。

## 5. 关键设计取舍

1. **向量自己算，不下载模型**：`server/embed.mjs` 用 FNV-1a 哈希 + 字符/双字 n-gram 生成 384 维单位向量。好处是离线、确定性、零模型依赖；代价是同义改写召回不稳。这是为了"评审在任何环境都能复现检索链路"做的取舍。
2. **房间由检索产生，不写分支**：同一句"我照了照镜子"与"我去第七号信箱投一封信"会命中不同 `kind` 的线索（实测 `镜面餐厅` vs `有人说，只要在第七号信箱`），说明场景不是脚本。
3. **Dify 不碰数据库**：Dify 只做编排，数据库细节全部收在 `server/` 与 `bridge/`。这样 DSL 可移植（换服务地址只需改环境变量 `INN_BASE_URL`），也让"技术是否真的起作用"可以用接口级证据核对。
4. **两个服务分离**：PowerContext（Python，重依赖）与世界服务（Node，轻依赖）拆开，任一服务挂掉时另一条链路仍可单独验证；`server/memory.mjs` 对记忆调用做了降级（`catch → []`），场景仍可返回，只是 `memories` 为空。
5. **幂等初始化**：`upsert` + `idempotency_key` 让"重启即恢复"成立，评审重复跑验证不会污染数据。
6. **一份代码三种形态，玩法规则恒定**：`npm start` 先探测已有的 PowerContext 边车、再探测 `python3/python/py` 里是否装了 `powercontext[builtin]`，有就拉起边车；边车缺失时记忆改走本地 JSON 库（`data/memory.json`，同样的写入/召回规则），世界服务优先用 seekdb 嵌入式实例，原生二进制不可用时退回同一套向量/余弦相似度的内存实现。`/health` 的 `seekdb.mode` 与 `powercontext.backend` 会如实标注当前形态，避免"看起来能跑但其实降级"的误判——**降级只换实现，不换规则**。

## 6. 性能（本机实测）

- 启动：约 6 s（含 seekdb 实例拉起、29 条 upsert）；
- 单回合：`/inn/act` 与 `/inn/scene` 均在 50 ms 内返回（本地 seekdb，无网络）；
- 端到端断言：三种形态均 11/11（完整模式约 1.3 s；本地 JSON 记忆库 / 内存向量检索的降级模式同样通过）。

## 7. 已知限制

- 检索质量受离线哈希向量限制，同义改写召回弱；接真实 embedding 服务即可提升，但会引入模型下载/网络依赖。
- 记忆召回是 FTS，不做语义重排；多词查询严格 AND。
- 单玩家字符串标识，无鉴权；`/inn/reset` 只重置剧情计数器，不删记忆。
- 叙述内容依赖 Dify 内配置的模型，离线评测不覆盖这一点（离线覆盖的是事实与记忆两条链路）。

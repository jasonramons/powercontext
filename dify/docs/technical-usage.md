# 技术使用记录

本文记录 **seekdb** 与 **PowerContext** 在本作品中的实际调用与返回结果，用于核对「指定技术是否真的在应用功能中发挥作用」。所有数据来自一次真实运行，原始记录见 `docs/evidence/usage.json`、`docs/evidence/verify-transcript.txt`、`docs/evidence/server.log`、`docs/evidence/bridge.log`。

- 记录时间：2026-11-10 19:21（本地，UTC+8）
- 环境：Windows 11 · Node v26.13.0 · Python 3.13.15 · `@oceanbase/seekdb-node` 1.4.0 · `seekdb` 1.4.0 · `powercontext[builtin]` 1.2.0 · `express` 4.22.3
- 复现命令：`npm run bridge` + `npm start` + `npm run usage`（见第 6 节）

---

## 1. 服务启动与自检

`GET /health`（`docs/evidence/usage.json` → `health`）：

```json
{
  "ok": true,
  "lore": 29,
  "seekdb": { "mode": "seekdb", "error": null },
  "powercontext": {
    "ok": true,
    "backend": "powercontext",
    "base": "http://127.0.0.1:8767",
    "bridge": { "ok": true, "scope": "scp_7jbtk11gpa0v6pmwp6w9fz5hrv" },
    "local_entries": 3
  }
}
```

这说明：seekdb 集合里已有 **29 条**档案（`seekdb.mode="seekdb"` 表示走的是嵌入式 seekdb，而不是内存回退）；记忆后端是 **PowerContext 边车**（`backend="powercontext"`）；`local_entries` 是本地兜底库的条目数（仅当边车不可用时才会被写入）。

两个服务的启动日志（`docs/evidence/server.log`、`docs/evidence/bridge.log`）：

```
[memory-inn] http://127.0.0.1:8789  seekdb 127.0.0.1:59336  lore=29
[bridge] ready scope=scp_6fbd7p3ac85je0mwav28hrtv46
[bridge] http://127.0.0.1:8767
```

- seekdb 以嵌入式实例运行在 `127.0.0.1:59336`（端口由 `@oceanbase/seekdb-node` 动态分配）；
- PowerContext 的 scope 是 `scp_6fbd7p3ac85je0mwav28hrtv46`，所有记忆都写在这个 scope 下。

---

## 2. seekdb 的实际作用：决定「这一回合遇到什么」

### 2.1 写入（启动时一次，幂等）

`server/store.mjs` 在启动时执行：

| 操作 | 参数 |
|---|---|
| `client.createCollection` | `name = inn_lore`，`configuration.hnsw = { dimension: 384, distance: cosine }`，`embeddingFunction = null` |
| `collection.upsert` | 29 条（`ids = <kind>:<id>`，`embeddings = embed(document)`，`documents`，`metadatas`） |
| `collection.count` | `29`（`/health` 中的 `lore` 字段） |

29 条档案的来源：`data/lore.json`（8 rooms / 8 guests / 8 rumors / 5 props，原创）。

### 2.2 检索：不同意图 → 不同房间（证明不是写死分支）

`POST /inn/scene`，同一个玩家、不同 `intent`（`docs/evidence/usage.json` → `calls[0]`、`calls[1]`）：

| 请求 `intent` | 命中的房间（seekdb top-1） | 命中的住客（seekdb top-1） |
|---|---|---|
| `镜 倒影 替身` | `room_05` 镜面餐厅 | `guest_04` 倒着走的人 |
| `雨 露台 等待` | `room_07` 雨夜露台 | `guest_07` 雨中的旅人 |

同一套代码、同一份档案，意图变了房间就变了，说明 `room` 来自 `collection.hybridSearch({ knn: { queryEmbeddings, nResults } })` 的向量检索结果，而非 `if/else` 分支。

### 2.3 检索：行动 → 线索（带距离）

`POST /inn/act`（`calls[2]`、`calls[3]`）：

| 行动 | 命中的线索 | `kind` | cosine 距离 |
|---|---|---|---|
| `我问老板：你还记得我吗？` | 记账的老妇人 | `guests` | 0.5102 |
| 同上 | 灯塔看守人 | `guests` | 0.7583 |
| `我去第七号信箱投一封信` | 有人说，只要在第七号信箱… | `rumors` | 0.5081 |
| 同上 | 第七号信箱 | `rooms` | 0.5233 |

`distance` 是 seekdb 返回的 cosine 距离（越小越接近）。不同行动命中不同 `kind` 的线索，是"世界由检索生成"的直接证据。

> 实现细节：按 `kind` 过滤发生在检索之后，所以代码会先取一个更宽的窗口（`fetchN = min(60, max(16, topK*8))`）再过滤，避免小窗口里恰好没有该类档案。

---

## 3. PowerContext 的实际作用：决定「老板记得你什么」

### 3.1 写记忆

`POST /inn/act` 每次成功都会写一条（`memory_written: true`，`memory_backend` 标明落到哪个后端），文本格式：

```
玩家「evaluator」第 1 回合：我问老板：你还记得我吗？
玩家「evaluator」第 2 回合：我去第七号信箱投一封信
```

写入走边车 `POST /memory/remember`，落到 `powercontext.builtin` 的 SQLite 持久化（`data/powercontext.db`），scope 见第 1 节。边车不可用时，同一个接口改写到本地 JSON 库 `data/memory.json`（`memory_backend: "local"`），**召回规则不变**。

### 3.2 召回记忆（下一回合被带进提示词）

第 3 回合 `POST /inn/scene`（`calls[4]`）返回体里出现了前两回合的记忆：

```json
"memories": [
  "玩家「evaluator」第 1 回合：我问老板：你还记得我吗？",
  "玩家「evaluator」第 2 回合：我去第七号信箱投一封信"
]
```

这两个字符串会被 Dify 的 `llm_narrate` 节点拼进 user prompt（DSL 中的 `{{#http_scene.body#}}`），所以"老板记得你"不是提示词里写死的示例，而是真实召回。

### 3.3 独立回忆

`POST /inn/recall`（`calls[5]`）：

```json
{ "ok": true, "hits": [ { "text": "玩家「evaluator」第 1 回合：我问老板：你还记得我吗？", "score": 0.01639344262295082 } ] }
```

`score` 为 PowerContext FTS 相关性分数。该接口只查记忆、不推进剧情，可用于"老板，你还记得我吗"这类纯回忆场景。

### 3.4 召回失败时的兜底

`SearchMemoryRequest(query, mode="fts")` 对多词查询是"全部命中"，因此 `intent="记忆 账本 欠"` 这类组合词可能召回为空。`server/index.mjs` 的处理是：

```js
let memories = await recall(query, 3).then((r) => r.hits ?? []).catch(() => []);
if (memories.length === 0) memories = await recall(player, 3).then((r) => r.hits ?? []).catch(() => []);
```

即"意图召回不到就按玩家名兜底"，保证第 2 回合之后一定能带回历史。这条回退在 `npm run verify` 的「第 2 回合带回记忆」断言里被覆盖。

---

## 4. Dify 节点 ↔ 后端接口映射

| DSL 节点 id | 节点类型 | 请求 | 请求体（与 DSL 中 `body.data` 一致） | 依赖的技术 |
|---|---|---|---|---|
| `start` | start | — | 变量 `player` | Dify |
| `http_act` | http-request | `POST {{env.INN_BASE_URL}}/inn/act` | `{"player":"{{#start.player#}}","action":"{{#sys.query#}}"}` | seekdb（线索）+ PowerContext（写记忆） |
| `http_scene` | http-request | `POST {{env.INN_BASE_URL}}/inn/scene` | `{"player":"{{#start.player#}}","intent":"{{#sys.query#}}"}` | seekdb（房间/住客/传闻/物品）+ PowerContext（召回） |
| `llm_narrate` | llm | — | system: 叙述规则；user: `sys.query` + `http_act.body` + `http_scene.body` | Dify |
| `answer` | answer | — | `{{#llm_narrate.text#}}` | Dify |

对照 `docs/evidence/usage.json` 中每个 `calls[i].payload`，可以看到与上表 body 字段完全一致（`evaluator` 即 `start.player` 的取值）。

---

## 5. 证据文件

| 文件 | 内容 |
|---|---|
| `docs/evidence/usage.json` | 6 次真实接口调用（请求 + 返回），本文第 2、3 节的原始数据 |
| `docs/evidence/verify-transcript.txt` | `npm run verify` 的 11 条断言与耗时（11/11，1306 ms） |
| `docs/evidence/server.log` | 世界服务启动日志（seekdb 端口、lore=29） |
| `docs/evidence/bridge.log` | PowerContext 边车启动日志（scope id、端口） |

## 6. 复现本文记录

```bash
npm install
pip install -r requirements.txt   # Python 缺失时整条链路仍可运行，只是记忆断言会被跳过
npm start                         # 一条命令拉起记忆边车 + 世界服务
npm run usage                     # 终端 2：重新生成 docs/evidence/usage.json
npm run verify:strict             # 终端 2：重新生成 11 条断言结果
```

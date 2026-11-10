# 验证样例与运行证据

本文件给出**一组可以按步骤执行的完整样例**：初始状态、输入顺序、预期表现、实际运行结果。

- 记录时间：2026-11-10 19:21（本地，UTC+8）
- 环境：Windows 11 · Node v26.13.0 · Python 3.13.15 · seekdb（嵌入式，`@oceanbase/seekdb-node` 1.4.0）· `powercontext[builtin]` 1.2.0
- 服务：世界服务 `http://127.0.0.1:8789`、PowerContext 边车 `http://127.0.0.1:8767`

---

## 1. 初始状态

| 项 | 初始值 |
|---|---|
| seekdb 集合 `inn_lore` | 29 条世界档案（启动时 upsert） |
| PowerContext scope | `memory-inn`（启动时创建，重启复用） |
| 玩家 `player` | 新的字符串即可（示例用 `evaluator`；`npm run verify` 内部用 `tester`） |
| 剧情计数器 | `turn = 0`，`visited = 0` |
| Dify | 已导入 `memory-inn.dsl.yml`、已配置模型、`INN_BASE_URL = http://127.0.0.1:8789`、已发布 |

恢复到该状态：

```bash
curl -X POST http://127.0.0.1:8789/inn/reset -H "content-type: application/json" -d "{\"player\":\"evaluator\"}"
```

---

## 2. 样例一：三回合，验证「会被记住」

### 2.1 操作顺序与预期

在 Dify 应用对话页依次输入（`player` 保持同一个值）：

| 回合 | 用户输入 | 预期表现 |
|---|---|---|
| 0 | （发布后打开应用） | 出现开场白与三条建议问题：`我问老板：你还记得我吗？` / `我去第七号信箱投一封信` / `我照了照镜子` |
| 1 | `我问老板：你还记得我吗？` | 返回一段 200 字以内的旅馆场景；应出现**房间/住客/传闻/物品**中的至少两项；结尾有一句可执行的行动提示 |
| 2 | `我去第七号信箱投一封信` | 场景换到与"信"相关的房间（第七号信箱），并且**叙述里引用第 1 回合你问过"记不记得"** |
| 3 | `我照了照镜子` | 再次换场；叙述里同时引用第 1、2 回合的行为 |

判断标准：开放式创作**不要求唯一文本**，只需满足「换场由输入驱动」「后续回合引用先前回合」两条。

### 2.2 实际结果（接口层，`evaluator` 玩家）

一次真实运行的关键返回（完整 JSON 见 `docs/evidence/usage.json`）：

| 步骤 | 接口返回（节选） |
|---|---|
| 第 1 次换场 `intent="镜 倒影 替身"` | `room=room_05 镜面餐厅`、`guest=guest_04 倒着走的人`、`visited=1` |
| 换场 `intent="雨 露台 等待"` | `room=room_07 雨夜露台`、`guest=guest_07 雨中的旅人`、`visited=2` |
| 行动 1 | `turn=1`、`accepted=true`、`memory_written=true`、`clues=[记账的老妇人(d=0.5102), 灯塔看守人(d=0.7583)]` |
| 行动 2 | `turn=2`、`accepted=true`、`memory_written=true`、`clues=[有人说，只要在第七号信箱(d=0.5081), 第七号信箱(d=0.5233)]` |
| 第 3 回合换场 `intent="记忆 账本 欠"` | `room=room_02 无声走廊`、`memories=["玩家「evaluator」第 1 回合：…","玩家「evaluator」第 2 回合：…"]` |
| 独立回忆 `query="老板"` | `hits=[{text:"玩家「evaluator」第 1 回合：我问老板：你还记得我吗？", score:0.01639}]` |

第 3 回合的 `memories` 非空，说明**记忆真的被保存并在后续回合复用**——这是本样例最关键的验证点。

---

## 3. 样例二：自动化自检（11 条断言）

### 3.1 执行

```bash
npm run verify           # 服务未运行时会自动拉起临时实例，验证完自动关闭
npm run verify:strict    # 严格模式：PowerContext 记忆链路也必须全过
```

`scripts/verify.mjs` 覆盖 11 条断言：服务健康、PowerContext 在线、场景生成、场景来自向量检索、行动被接受、行动写入记忆、线索检索、跨回合记忆、独立回忆、多回合推进、不同行动命中不同线索。

### 3.2 实际输出（`--strict` 全量模式）

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

- 完整转写：`docs/evidence/verify-transcript.txt`（含逐条 JSON，`elapsedMs: 1306`）
- `npm run verify:strict` 退出码 0。

### 3.3 无 Python 的环境（记忆走本地 JSON 库，规则不变）

同一套代码在没有 `powercontext` 的机器上仍然 **11/11 通过**：记忆后端切到本地 JSON 库（`data/memory.json`），写入/召回规则与边车模式一致。

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

转写：`docs/evidence/verify-standalone-degraded.txt`；对应服务日志：`docs/evidence/run-degraded.log`。
seekdb 原生二进制不可用时的内存检索回退同样 11/11，`/health` 中 `seekdb.mode="memory"`：转写 `docs/evidence/verify-memory.txt`，日志 `run-memory.log`。

### 3.3 逐条说明

| 断言 | 在验证什么 |
|---|---|
| 服务健康 | seekdb 已索引 29 条，PowerContext 已就绪 |
| 场景由 seekdb 检索得出 | `room.id` 形如 `room_02`，来自集合而非硬编码 |
| 行动写入记忆 | `/inn/act` 返回 `memory_written=true`，对应 PowerContext 写入成功 |
| 第 2 回合带回记忆 | `/inn/scene` 的 `memories` 含上一回合文本（召回成功或玩家名兜底） |
| 回忆接口命中 | `/inn/recall` 返回至少一条带 `score` 的记忆 |
| 多回合推进 | 三回合后 `turn` 递增为 3 |
| 不同行动命中不同线索 | 两个行动的 top-1 线索不同（`第七号信箱` vs `镜面餐厅`） |

---

## 4. 截图 / 日志替代说明

本作品的"运行证据"以**可复现的日志与 JSON** 为主（`docs/evidence/` 下四个文件），原因：

- 叙述文本由 Dify 内的模型生成，离线环境下无法产出真实叙述截图；
- 事实与记忆两条链路可以完全离线复现，日志比截图更便于评审核对字段级差异（例如 `distance`、`score`、`memories`）。

---

## 5. 已知限制（与验证相关）

1. 离线哈希向量对同义改写召回不稳，`intent` 用词越贴近 `data/lore.json` 的 tags，命中越准。
2. `memories` 在"意图词与历史文本无公共词"时依赖玩家名兜底，因此不同 `player` 之间记忆互不可见（这是设计目标：一个玩家一份记忆）。
3. 首次 `npm start` 需要几十秒拉起 seekdb 嵌入式实例；`data/seekdb.db/` 已加入 `.gitignore`，不随仓库提交。

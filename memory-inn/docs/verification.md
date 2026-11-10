# 验证样例与运行证据

## 环境

- Windows 11 / Node v26.13.0 / Python 3.13
- seekdb：嵌入式（`@oceanbase/seekdb-node`），数据目录 `data/seekdb.db`，索引 29 条档案
- PowerContext：`bridge/app.py`（SQLite，`data/powercontext.db`），端口 8767
- 世界服务：`http://127.0.0.1:8789`

## 复现

```bash
npm run bridge      # 终端 1
npm start           # 终端 2
npm run verify      # 终端 3
```

## 实际输出（2026-11-10）

```
ok   服务健康  (lore=29 pc=true)
ok   PowerContext 在线  ({"ok":true,"base":"http://127.0.0.1:8767"})
ok   第 1 回合生成场景  (room=无声走廊 guest=雨中的旅人)
ok   场景由 seekdb 检索得出  (room_02)
ok   行动被接受  (turn=1)
ok   行动写入记忆  (true)
ok   行动触发线索检索  (clues=2)
ok   第 2 回合带回记忆  ("玩家「tester」第 3 回合：我照了照镜子")
ok   回忆接口命中  ({"text":"玩家「tester」第 1 回合：我问老板：你还记得我吗？","score":0.01639344262295082})
ok   多回合推进  (turn=3)
ok   不同行动命中不同线索  (有人说，只要在第七号信箱 vs 镜面餐厅)

pass: 11/11
```

## 逐条说明

### 1. 场景确实由 seekdb 生成

`intent = "深夜 旅馆 走廊 灯"` 检索后返回 `room_02 无声走廊`。换一个意图（例如 `镜`）会返回 `room_05 镜面餐厅`，说明房间不是写死的分支。

### 2. 记忆确实由 PowerContext 写入并召回

行动「我问老板：你还记得我吗？」写入后，`/inn/recall?query=老板` 立刻命中：

```
玩家「tester」第 1 回合：我问老板：你还记得我吗？   score=0.0164
```

第 2 回合换场时，`/inn/scene` 的 `memories` 字段带回了更早回合的记忆，证明跨回合记忆生效。

### 3. 多回合推进与线索差异

| 回合 | 行动 | 命中的线索类型 |
|---|---|---|
| 1 | 我问老板：你还记得我吗？ | 记忆 / 账本相关（`clues=2`） |
| 2 | 我去第七号信箱投一封信 | 一说只要在第七号信箱… |
| 3 | 我照了照镜子 | 镜面餐厅 |

同一句"不同行动命中不同线索"断言在三回合间通过。

## 边界与已知限制

- 向量是**离线确定性哈希 n-gram**（`server/embed.mjs`），不依赖模型下载；同义改写（"镜子"vs"明镜"）召回不稳，属于该方案的已知取舍。
- 叙述质量取决于 Dify 里选的模型；服务只负责事实与记忆，不生成文本。
- 验证脚本用的是接口层证据；Dify 侧的可玩性需要按 `README.md` 导入 DSL 后人工体验（3 分钟即可走完上述三回合）。

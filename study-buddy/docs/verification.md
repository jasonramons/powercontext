# 验证样例

## 环境

- Windows 11 / Node v26.13.0 / Python 3.13
- seekdb：嵌入式启动（`@oceanbase/seekdb-node`），数据目录 `data/seekdb.db`
- PowerContext：`bridge/app.py`（SQLite，`data/powercontext.db`）

## 复现步骤

```bash
npm install
npm run bridge      # 终端 1
npm start           # 终端 2
npm run seed        # 终端 3
npm run smoke       # 终端 4
```

## 实际输出（2026-11-07）

```
ok   health  (indexed=24)
ok   powercontext online  ({"ok":true,"base":"http://127.0.0.1:8766"})
ok   seed  (added=24)
ok   items registered  (count=24)
ok   search "洛必达法则求极限"  (rank=1)
ok   search "TCP 三次握手"  (rank=1)
ok   search "虚拟语气 与过去事实相反"  (rank=1)
ok   search "特征值 相似对角化"  (rank=2)
ok   search "B+ 树索引"  (rank=1)
ok   recall@1 >= 4/5  (hits=4/5)
ok   plan generated  (cards=10)
ok   plan ordered by priority  (0.565 >= 0.565 >= ...)
ok   plan fits budget  (10 x 2min <= 20min)
ok   wrong answer lowers mastery  (0.252 -> 0.402)
ok   wrong answer stored in PowerContext  ({"ok":true,"stored":1})
ok   weak point recalled  (薄弱点：洛必达法则（高等数学）最近答错，题目「洛必达法则求极限」)
ok   three correct answers raise mastery  (mastery=0.98)
ok   correct answers push due date out  (interval=8d)

pass: 18/18  elapsed: 346ms
```

## 逐条说明

### 1. 检索命中（seekdb）

| 查询 | 期望题 | 实际排名 |
|---|---|---|
| 洛必达法则求极限 | q_math_001 | 1 |
| TCP 三次握手 | q_cs_001 | 1 |
| 虚拟语气 与过去事实相反 | q_eng_001 | 1 |
| 特征值 相似对角化 | q_linalg_001 | 2 |
| B+ 树索引 | q_cs_005 | 1 |

召回@1 = 4/5，召回@5 = 5/5。第 4 组排第二是因为「相似对角化」命中了 q_linalg_002（同章节），属于合理结果。

单次检索耗时 3~10 ms（24 条数据、384 维、HNSW）。

### 2. 复习计划

20 分钟预算 → 10 张卡片（每题 2 分钟），按优先级降序，逾期卡片优先。初始状态下所有题都未复习，优先级并列 0.565，属于预期。

### 3. 错题 → 记忆 → 召回（PowerContext）

对 q_math_001 答错后：

- 掌握度下降，薄弱度 `0.252 → 0.402`；
- PowerContext 写入成功（`{"ok":true,"stored":1}`）；
- 用「洛必达法则」检索记忆，命中刚写入的那条，score 0.0164（FTS 的 BM25 分值）。

### 4. 连续答对

再答对 3 次后掌握度 `0.98`，复习间隔 `8d`，即下次到期时间被推后——这正是"越熟越少复习"的行为。

## 已知边界

- 示例数据是 24 道题，规模小，检索延迟不代表大数据集表现；
- 向量是哈希 n-gram，同义改写（如"洛必达"vs"洛比达"）召回不稳，属于该方案的已知取舍；
- 中文分词依赖二元组，英文依赖整词。

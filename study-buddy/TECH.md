# 技术方案

## 1. 整体结构

```
浏览器 (web/)
   │  fetch /api/*
   ▼
Node/Express (server/index.mjs)
   ├── seekdb 嵌入式实例  ← 题目索引：文档 + 384 维向量 + 元数据
   └── HTTP ──► PowerContext 记忆桥 (bridge/app.py)  ← 学习者薄弱点记忆
```

两个存储各司其职，谁也不是装饰：

- **seekdb**：所有检索都走它。写入时把 `标题+题干+答案+知识点` 拼成文档、算出向量、连同 `subject/knowledge/source/item_id` 一起 upsert；查询时用 HNSW 近邻排序，可选叠加关键词子句。
- **PowerContext**：所有"这个学习者反复错在哪"的信息都走它。每次作答写一条记忆，复习计划生成前按科目/知识点检索一遍，把命中的薄弱点作为提醒带回前端。

## 2. seekdb 的用法

```js
// 启动：嵌入式实例，零外部依赖
handle = await seekdb.open(DB_PATH, { parameters: { memory_budget: '2G' } });
const endpoint = handle.connectionOptions();      // { transport:'tcp', host, port, user }

// 集合：HNSW + cosine
collection = await client.createCollection({
  name: 'study_items',
  configuration: { hnsw: { dimension: 384, distance: 'cosine' } },
  embeddingFunction: null,                        // 向量由应用侧计算
});

// 检索：向量近邻，必要时叠加关键词子句
await collection.hybridSearch({
  knn: { queryEmbeddings: embed(query), nResults },
  query: { whereDocument: { $contains: keyword } },  // 可选
  rank: { rrf: { rankWindowSize: 60 } },             // 两路融合
  include: ['documents', 'metadatas', 'distances'],
});
```

要点：

- `embeddingFunction: null`：向量必须由应用计算，避免 SDK 回退到服务端 embedding。
- 首次 `createCollection` 失败（集合已存在）时回退到 `getCollection`，重启幂等。
- 单条 `upsert` 与批量 `upsert` 共用同一路径，因此"录入一道题"和"载入 24 道题"没有两套代码。

## 3. 向量方案

`server/embed.mjs` 用哈希 n-gram 生成 384 维单位向量：

- 英文/数字按词切分（`w:` 前缀）；
- 中文按单字（`c:`）与二元组（`b:`）切分，保证「洛必达法则」和「用洛必达求极限」共享大量特征；
- 每个 token 做 FNV-1a 哈希后落到两个维度上，最后 L2 归一化。

这样做的取舍很明确：**不下载模型、不需要 API Key、毫秒级**，对"短题干找相似题"这类任务足够；真要更强语义可以整体替换 `embed()`，其余代码不动。

## 4. 复习调度

每道题带一份 `stats`：

| 字段 | 含义 |
|---|---|
| `mastery` | 掌握度 0~1 |
| `attempts` / `correct` / `streak` | 作答统计与连对次数 |
| `intervalDays` | 当前间隔（答对翻倍，答错归 1） |
| `dueAt` | 下次到期时间 |

优先级 = `weakness × urgency`：

- `weakness` 由掌握度、正确率、作答次数（不确定性）加权；
- `urgency` 由逾期天数决定；
- 先排逾期卡片，再按优先级补足剩余名额，名额 = 预算分钟 / 每题 2 分钟。

## 5. PowerContext 集成

`bridge/app.py` 是一个 30 行的 HTTP 边车，内部持有真实 PowerContext Runtime：

```python
runtime_cm = open_builtin_runtime(BuiltinConfig(database=SQLiteConfig(url=...)))
runtime = await runtime_cm.__aenter__()     # 必须保留 cm 引用，否则 GC 会关闭 runtime
scope = await runtime.scopes.create(ScopeDraft(..., idempotency_key="study-buddy-learner"))
memory = runtime.memory.for_scope(scope.scope_id)
memory.remember(RememberMemoryRequest(entries=(MemoryEntryInput(kind=..., text=...),)))
page = await memory.search(SearchMemoryRequest(query=..., mode="fts", limit=...))
```

- 记忆文本形如：`薄弱点：洛必达法则（高等数学）最近答错，题目「洛必达法则求极限」`，答对则记 `最近答对`。
- 检索用 `mode="fts"`，因为要的是"包含这个知识点"的精确召回，不是语义泛化。
- scope 用 `idempotency_key` 固定，重启后自动复用同一个 scope，历史记忆不丢。

为什么用边车而不是在 Node 里调 Python：Node 侧保持纯 JS，PowerContext 保持一个**长生命周期**的服务（而不是每次请求起停 Runtime），两边通过 HTTP 解耦，任一侧挂了另一侧还能降级运行。

## 6. 降级行为

- PowerContext 不可用：`/api/health` 显示离线，复习计划不带记忆提醒，作答仍会更新本地统计（记忆写入失败被 `catch` 住）。
- seekdb 打不开：服务直接启动失败并打印原因（这是核心依赖，不做静默降级）。

## 7. 验收方式

`scripts/smoke.mjs` 对运行中的实例跑 18 项断言：健康检查、种子导入、5 组检索命中、计划排序与预算、答错→掌握度下降→记忆写入→记忆召回、连对→掌握度上升→间隔变长。任何一项失败脚本以非零码退出，可直接接 CI。

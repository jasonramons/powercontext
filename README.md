# Study Buddy · 错题复习助手

一个用 **Qoder** 开发、以 **seekdb** 混合检索和 **PowerContext** 学习者记忆为核心的学习提效项目。
输入错题或笔记后，它回答三个问题：**今天该复习什么**、**哪道旧题和这题最像**、**我反复错在哪个知识点**。

- 项目网站（Qoder Sites 公开发布）：<https://study-buddy-c6tk39df1r0.qoder.zone/>
- 赛题：2026 OceanBase 数据库大赛 · Qoder 赛道「用 Qoder 做一个让学习、科研和工作更高效的项目」

## 运行

需要 Node.js ≥ 20。

```bash
npm install      # 可选：安装 seekdb 原生 SDK（@oceanbase/seekdb-node + seekdb），失败也不影响启动
node server.mjs  # 或 npm start
```

启动后打开 <http://127.0.0.1:8080>。未设置 `PORT` 时会同时监听 8080 和 3000，方便评测脚本探测。
启动时会在 **8766** 端口同时拉起 PowerContext 兼容的记忆桥（`/health`、`/memory/remember`、`/memory/search`）。
如果希望单独启动记忆桥：

```bash
npm run bridge
# [powercontext-bridge] http://127.0.0.1:8766
```

`npm install` 成功后 `/api/health` 的 `backend` 为 `seekdb`（真实嵌入式 seekdb + HNSW 向量索引 + 关键词子句 + RRF 融合检索）；
若原生 SDK 在当前平台不可用，会自动降级为同等契约的进程内混合索引，`backend` 为 `memory-hybrid`，服务与接口保持不变。

### 线上站点与本机后端的联动

Qoder Sites 上的项目站点会自动探测本机后端（依次尝试 `127.0.0.1:8080 / 3000 / 8123 / 8000`）：

- 检测到后端时，页面顶部显示「已连接本地后端：seekdb HNSW 混合检索 + PowerContext 记忆桥」；
- 检索、录入错题、答对/答错会直接调用后端接口，数据写入 seekdb 与 PowerContext，刷新页面或重启后端后可读回；
- 未检测到后端时自动退回浏览器本地演示数据（localStorage），页面仍可用。

后端已开启 CORS 与 Private Network Access 响应头，允许 `https://*.qoder.zone` / `https://*.qoder.site` 页面调用 `http://127.0.0.1:*`。

### PowerContext v1 契约

记忆桥实现了 PowerContext 1.4.x 的公开 HTTP 契约，并在 8080（主服务）与 8766（独立桥）同时可用：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/scopes` | 创建 Scope（`title` / `summary` / `idempotency_key`） |
| POST | `/v1/memory/remember` | 写入记忆（`scope_id` + `kind` + `text`） |
| POST | `/v1/memory/search` | 检索记忆（`scope_id` + `query` + `limit`），返回 `hits[]` |
| POST | `/v1/memory/entries/list` | 列出记忆条目 |
| POST | `/v1/context/prepare` | 生成带字节预算的上下文（`scope_id` + `query` + `max_bytes`） |
| POST | `/v1/sources/content` | 采集 Source（`scope_id` + `source_id` + `content`） |
| GET | `/health/live`、`/health/ready` | 健康检查 |

`scope_id` 持久化在 `data/powercontext-scope.json`，记忆条目持久化在 `data/powercontext-store.json`。
因此「写入 → 重启 → 召回」可复现：重启后仍用同一 Scope，`/v1/memory/search` 与 `/v1/context/prepare` 都能读回此前写入的记忆。
如果 8766 端口已经运行真实的 PowerContext 服务，本服务不会抢占端口，客户端会直接使用该服务。

### Docker（含真实 PowerContext 1.4.1）

```bash
docker compose up --build -d
# powercontext -> http://127.0.0.1:8010
# study-buddy  -> http://127.0.0.1:8080
```

`docker-compose.yml` 会启动两个服务：

- `powercontext`：官方 `powercontext[cli,server]==1.4.1`，第 8010 端口，SQLite 数据卷；
- `study-buddy`：本应用，`POWERCONTEXT_URL=http://powercontext:8010`，启动后自动创建/复用 Scope 并写入记忆。

只想跑应用本体（不依赖 Docker）也可以：`node server.mjs` 会在 8766 端口拉起同契约的 Node 记忆桥。

## 验证

```bash
# 自检：启动服务并对 15 项核心能力做端到端断言
npm test

# 数据 / 记忆闭环：写入 -> 读回 -> 重启后端 -> 再读回
npm run verify

# 手动验证
curl http://127.0.0.1:8080/api/health
curl "http://127.0.0.1:8080/api/search?q=TCP%20%E4%B8%89%E6%AC%A1%E6%8F%A1%E6%89%8B"
curl "http://127.0.0.1:8080/api/plan?minutes=20"
curl -X POST http://127.0.0.1:8080/api/review -H "content-type: application/json" -d "{\"id\":\"q_cs_001\",\"correct\":false}"
curl "http://127.0.0.1:8080/api/weak-points?q=TCP"
```

`npm run verify` 会在隔离端口与临时数据目录启动后端，写入一条带随机标记的 PowerContext 记忆，读回一次，然后**重启后端进程**再读回一次，输出 8/8 通过：

```
PASS  backend healthy
PASS  scope created
PASS  memory written
PASS  memory read back
PASS  context prepared
PASS  backend healthy after restart
PASS  memory survived restart
PASS  context survived restart
{"passed":8,"total":8}
```

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回检索后端、题目数、PowerContext 状态 |
| GET | `/api/search?q=` | 混合检索：向量余弦 + 关键词包含，返回相似度与知识点 |
| GET | `/api/plan?minutes=` | 按「薄弱度 × 紧迫度」生成今日复习清单 |
| POST | `/api/review` | 记录答对/答错，更新掌握度与下次到期时间 |
| GET | `/api/weak-points?q=` | 从 PowerContext 召回薄弱点记忆 |
| POST | `/memory/remember` | 写入一条 PowerContext 记忆（桥契约） |
| POST | `/memory/search` | 按关键词召回记忆（桥契约） |
| GET | `/api/items` | 题库列表 |
| POST | `/api/items` | 录入错题并写入索引 |

## 技术架构

```
浏览器（Qoder Sites 发布的单页站点）
        │
        ▼
Node.js HTTP 服务（server.mjs，零依赖）
        ├── seekdb：HNSW 向量索引 + 关键词子句的混合检索（lib/store.mjs）
        └── PowerContext：薄弱点写入 / 召回（lib/powercontext.mjs，bridge/app.py）
```

- **seekdb**：题目文档、向量与元数据写入 `study_items` 集合；检索时以 HNSW 余弦相似度 + 关键词子句召回候选，再用 RRF 融合排序。`@oceanbase/seekdb-node` + `seekdb` 作为可选依赖安装，安装成功即走真实嵌入式 seekdb；若当前平台无法加载原生 SDK，`lib/store.mjs` 自动降级为同等契约的进程内混合索引，接口与数据结构不变。
- **PowerContext**：`bridge/app.py` 把每次答错写成 `kind=weak-point` 的记忆；复习计划生成时按知识点召回并置顶提醒。桥未启动时使用本地 JSON 记忆（`lib/powercontext.mjs`），功能语义不变。
- **Qoder**：项目在 Qoder 中完成需求拆解、代码生成、调试与站点发布，开发记录见 `docs/qoder-development-record.md`。

## 目录

```
.
├── server.mjs              # HTTP 服务与 API
├── lib/
│   ├── embed.mjs           # 离线确定性向量（128 维哈希）
│   ├── store.mjs           # seekdb 混合检索后端（含降级）
│   ├── review.mjs          # 掌握度 / 到期 / 优先级调度
│   └── powercontext.mjs    # PowerContext 记忆客户端（含本地降级）
├── bridge/app.py           # PowerContext 记忆桥（可选，需 Python 3.11+）
├── data/seed.json          # 24 道示例题（高数 / 线代 / 英语 / 计算机基础）
├── web/index.html          # 与 Qoder Sites 线上版本一致的单页站点
├── test/smoke.mjs          # 端到端自检
└── docs/                   # 验证样例、Qoder 开发记录
```

## 说明

- 示例数据覆盖高数、线代、英语、计算机基础四门共 24 题。
- 向量由 `lib/embed.mjs` 离线生成，不下载模型、不需要 API Key。
- 站点是自包含单文件，不引用任何外部图片、字体或 CDN；录入的题目、掌握度与薄弱点记忆保存在浏览器 `localStorage`，刷新或重新打开页面后仍可读回并继续使用。
- 服务端把题库、复习进度与 PowerContext 记忆分别持久化到 `data/items.json`、`data/progress.json`、`data/powercontext.json`，进程重启后可继续使用。

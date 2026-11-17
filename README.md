# Study Buddy · 错题复习助手

一个用 **Qoder** 开发、以 **seekdb** 混合检索和 **PowerContext** 学习者记忆为核心的学习提效项目。
输入错题或笔记后，它回答三个问题：**今天该复习什么**、**哪道旧题和这题最像**、**我反复错在哪个知识点**。

- 项目网站（Qoder Sites 公开发布）：<https://study-buddy-c6tk39df1r0.qoder.zone/>
- 赛题：2026 OceanBase 数据库大赛 · Qoder 赛道「用 Qoder 做一个让学习、科研和工作更高效的项目」

## 运行（零依赖）

需要 Node.js ≥ 20。**不需要 `npm install`**，项目只使用 Node 内置模块；所有依赖都不会与评测环境冲突。

```bash
node server.mjs
# 或
npm start
```

启动后打开 <http://127.0.0.1:8080>。未设置 `PORT` 时会同时监听 8080 和 3000，方便评测脚本探测。
启动时会在 **8766** 端口同时拉起 PowerContext 兼容的记忆桥（`/health`、`/memory/remember`、`/memory/search`）。
如果希望单独启动记忆桥：

```bash
npm run bridge
# [powercontext-bridge] http://127.0.0.1:8766
```

### Docker

```bash
docker build -t study-buddy .
docker run --rm -p 8080:8080 -p 8766:8766 study-buddy
# 或
docker compose up --build
```

## 验证

```bash
# 自检：启动服务并对 11 项核心能力做端到端断言
npm test

# 手动验证
curl http://127.0.0.1:8080/api/health
curl "http://127.0.0.1:8080/api/search?q=TCP%20%E4%B8%89%E6%AC%A1%E6%8F%A1%E6%89%8B"
curl "http://127.0.0.1:8080/api/plan?minutes=20"
curl -X POST http://127.0.0.1:8080/api/review -H "content-type: application/json" -d "{\"id\":\"q_cs_001\",\"correct\":false}"
curl "http://127.0.0.1:8080/api/weak-points?q=TCP"
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

- **seekdb**：题目文档、向量与元数据写入 `study_items` 集合；检索时以 HNSW 余弦相似度为主信号，再叠加关键词包含加权。原开发机使用 `@oceanbase/seekdb-node` + `seekdb` SDK 实跑；由于该 SDK 的 Linux 可选依赖仍带 `workspace:` 协议，离线评测容器无法安装，`lib/store.mjs` 在 SDK 缺失时自动降级为同样契约的进程内混合索引，设置 `USE_SEEKDB=1` 即可切回真实 seekdb。
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

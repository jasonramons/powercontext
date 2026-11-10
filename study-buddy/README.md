# Study Buddy · 错题/笔记复习助手

一个给自己用的复习工具：把错题和笔记丢进去，它告诉你**今天该复习什么**、**哪道题和当前这题最像**、以及**你反复错在哪个知识点**。

- 存储与检索：**seekdb**（嵌入式实例 + HNSW 向量索引 + 关键词子句的混合检索）
- 学习者记忆：**PowerContext**（把「反复答错的知识点」写成可检索的记忆，复习时自动带回提醒）
- 前端：单页 Web（零构建，Express 直接托管）

## 为什么做这个

备考时最痛的不是"没有题"，而是：

1. 错题本越记越厚，**不知道今天该翻哪几页**；
2. 遇到新题，想找"以前做过类似的"，靠翻标签翻不到；
3. 同一个知识点错了三次，**没有任何东西提醒你**它已经错三次了。

前两个是检索问题（seekdb 解决），第三个是记忆问题（PowerContext 解决）。

## 快速开始

需要 Node.js ≥ 20 和 Python ≥ 3.11。

```bash
# 1) 安装依赖
npm install

# 2) 启动 PowerContext 记忆桥（需要先安装 PowerContext）
pip install "powercontext[cli,server]"
npm run bridge            # 默认 127.0.0.1:8766

# 3) 另开一个终端启动应用
npm start                 # 默认 http://127.0.0.1:8788

# 4) 载入 24 道示例题（首次运行）
npm run seed

# 5) 端到端自检
npm run smoke
```

打开 <http://127.0.0.1:8788> 即可使用。

## 功能

| 页面 | 做什么 |
|---|---|
| 今日复习 | 选时长（10/20/40 分钟）和科目，生成按「薄弱度 × 紧迫度」排序的复习卡片；页面顶部显示 PowerContext 带回来的薄弱点提醒 |
| 相似题检索 | 输入题干或关键词，走 seekdb 混合检索，返回最相似的题及相似度 |
| 题库 | 浏览/过滤/删除题目，显示每题掌握度 |
| 录入错题 | 新增题目并立即写入 seekdb 索引 |
| 右侧栏 | 查询 PowerContext 里记录的薄弱点 |

复习时点「答对了 / 答错了」：更新掌握度与下次到期时间，并把这次结果写入 PowerContext 记忆。

## 用 Docker 运行（可选，当前有已知限制）

镜像里同时打包了 Node 应用和 PowerContext 记忆桥，一个容器即可跑起来：

```bash
docker compose up --build -d        # 构建并后台启动
docker compose logs -f              # 看日志
curl http://127.0.0.1:8788/api/health
docker compose down                 # 停止
```

数据持久化在 `./data`（`items.json`、`seekdb.db/`、`powercontext.db`）。

推到你自己的 Docker Hub 供他人拉取：

```bash
docker build -t jasonramon/study-buddy:1.0.0 .
docker push jasonramon/study-buddy:1.0.0
docker run -p 8788:8788 -v study-data:/data jasonramon/study-buddy:1.0.0
```

### 已知限制（重要）

在 **Linux** 上执行 `npm install` 会报：

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

这是 seekdb SDK 的 **Linux 平台可选依赖**在发布时带了 monorepo 的 `workspace:` 协议导致的（Windows/macOS 不受影响，本项目在 Windows 上已跑通）。因此容器镜像暂时无法在纯 Linux 环境构建。

绕开方式（任选）：

1. **不用 Docker**：按上面的「快速开始」在宿主机运行（已验证）；
2. **外部 seekdb**：用官方 Linux 版 seekdb 起一个服务，把 `store.mjs` 改成连接已存在的 TCP 端点（需要小改，尚未实现）；
3. **在 macOS/Windows 上构建镜像**：`docker build --platform=linux/amd64` 同样会触发该依赖解析，仍可能失败。

> Docker 只是运行方式之一；Qoder 赛题要求的「网站」仍然要在 Qoder Sites 上发布（见 `docs/qoder-checklist.md`），静态演示页 `web/demo.html` 不需要任何后端。

## 静态演示页

`web/demo.html` 是**单文件、自包含**的演示页（24 道示例题 + 同样的哈希向量检索，无外部依赖），适合直接发布到 Qoder Sites：

```bash
npm run demo          # 重新生成 web/demo.html
```

双击打开或用任意静态服务器托管即可；输入"TCP 三次握手"应命中 TCP 那题。

## 验证结果

`npm run smoke` 在 24 道示例题上跑完整链路，**18/18 通过**：

```
ok  health                      (indexed=24)
ok  powercontext online
ok  seed                        (added=24)
ok  items registered            (count=24)
ok  search "洛必达法则求极限"      (rank=1)
ok  search "TCP 三次握手"          (rank=1)
ok  search "虚拟语气 与过去事实相反" (rank=1)
ok  search "特征值 相似对角化"      (rank=2)
ok  search "B+ 树索引"             (rank=1)
ok  recall@1 >= 4/5             (hits=4/5)
ok  plan generated              (cards=10)
ok  plan ordered by priority
ok  plan fits budget
ok  wrong answer lowers mastery (0.252 -> 0.402)
ok  wrong answer stored in PowerContext
ok  weak point recalled         (薄弱点：洛必达法则…)
ok  three correct answers raise mastery (mastery=0.98)
ok  correct answers push due date out   (interval=8d)
```

## 目录结构

```
study-buddy/
├── bridge/app.py        # PowerContext 记忆桥（薄弱点写入 / 检索）
├── data/seed.json       # 24 道示例题（高数/线代/英语/408）
├── scripts/
│   ├── seed.mjs         # 载入示例数据
│   └── smoke.mjs        # 端到端验收
├── server/
│   ├── embed.mjs        # 离线确定性向量（可替换为真实 embedding）
│   ├── index.mjs        # Express API + 静态站点
│   ├── powercontext.mjs # PowerContext 客户端
│   ├── review.mjs       # 复习调度（掌握度/到期/优先级）
│   └── store.mjs        # seekdb 集合与混合检索
└── web/                 # 单页前端（index.html / app.js / style.css）
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8788` | Web 服务端口 |
| `POWERCONTEXT_URL` | `http://127.0.0.1:8766` | 记忆桥地址 |
| `PC_DB` | `data/powercontext.db` | PowerContext 的 SQLite 路径 |
| `SEEPDB_PATH` | `data/seekdb.db` | seekdb 数据目录 |
| `STUDY_DATA_DIR` | `data/` | 题库注册表（items.json）所在目录 |

## 说明

- 向量是**离线确定性哈希向量**（`server/embed.mjs`），不依赖模型下载或 API Key；换成任意真实 embedding 只需替换 `embed()`。
- seekdb 是嵌入式启动（`seekdb.open()`），不需要额外安装服务端。
- 题库正文存在 `data/items.json`，seekdb 负责**索引与检索**（文档、向量、元数据都在 seekdb 里）。

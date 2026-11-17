# 验证样例

## 环境

- Node.js ≥ 20
- seekdb：`@oceanbase/seekdb-node` + `seekdb`（可选依赖，`npm install` 成功即启用；缺失时自动降级）
- 可选：Python 3.11+ 与 `powercontext[cli,server]`（启动 `bridge/app.py` 时启用真实 PowerContext；Node 版记忆桥默认在 8766 端口提供同契约服务）

## 启动

```bash
npm install      # 可选，安装 seekdb 原生 SDK
node server.mjs  # 默认 http://127.0.0.1:8080（未设置 PORT 时同时监听 3000）
```

启动日志应显示 `backend=seekdb`（或 SDK 不可用时的 `backend=memory-hybrid`），以及 `PowerContext bridge http://127.0.0.1:8766`。

## 端到端自检

```bash
npm test
```

预期输出（11 项全部 ok）：

```
ok   health (items=24 backend=seekdb)
ok   seed loaded 24 items
ok   search TCP top1 (TCP 三次握手的过程是什么？为什么两次握手不可以？)
ok   search 洛必达 top1 (洛必达法则求极限)
ok   plan generated (cards=10)
ok   plan sorted
ok   wrong answer lowers mastery (0.46 -> 0.31)
ok   weak point recalled (薄弱点：TCP 三次握手（计算机基础）最近答错…)
ok   written data read back (冒烟测试题)
ok   memory read back (记忆读回测试 QWERTYUIOP)
ok   site served
{"passed":11,"total":11}
```

## 逐项验证

### 1. 相似题检索（seekdb 混合检索）

```bash
curl "http://127.0.0.1:8080/api/search?q=TCP%20%E4%B8%89%E6%AC%A1%E6%8F%A1%E6%89%8B"
```

| 查询 | 期望命中 | 实际排名 |
|---|---|---|
| 洛必达法则求极限 | q_math_001 | 1 |
| TCP 三次握手 | q_cs_001 | 1 |
| 虚拟语气 与过去事实相反 | q_eng_001 | 1 |
| 特征值 相似对角化 | q_linalg_001 | 1~2 |
| B+ 树索引 | q_cs_005 | 1 |

返回结果包含 `score`（0~1 相似度）与命中的 `knowledge` 知识点。

### 2. 今日复习清单

```bash
curl "http://127.0.0.1:8080/api/plan?minutes=20"
```

按「薄弱度 × 紧迫度」排序，20 分钟预算产出 10 张卡片；逾期题优先，同一天到期时掌握度低的优先。

### 3. 答错 → 掌握度下降 → 写入 PowerContext

```bash
curl -X POST http://127.0.0.1:8080/api/review \
  -H "content-type: application/json" \
  -d "{\"id\":\"q_cs_001\",\"correct\":false}"
```

返回 `before` / `after` 掌握度；当掌握度低于 0.5 时 `weak=true`，并把「薄弱点：TCP 三次握手（计算机基础）最近答错…」写入 PowerContext。

### 4. 薄弱点召回

```bash
curl "http://127.0.0.1:8080/api/weak-points?q=TCP"
```

返回 `memories`（PowerContext 记忆条目）与 `weakItems`（当前掌握度低于 0.45 的题目）。

### 5. 数据与记忆的读回 / 复用

- 站点：录入一道新题 → 刷新页面 → 题目仍在且可通过知识点检索；答错一题 → 刷新页面 → 薄弱点记录与作答统计仍在（浏览器 `localStorage`）。
- 服务端：`POST /api/items` 写入的题目可被 `GET /api/search` 立即检索；`POST /memory/remember` 写入的记忆可被 `POST /memory/search` 读回；重启进程后 `data/*.json` 中的题库、进度与记忆仍然存在。
- 记忆桥：启动时自动在 8766 端口提供 PowerContext 兼容契约，也可 `npm run bridge` 单独启动。

```bash
curl -X POST http://127.0.0.1:8766/memory/remember -H "content-type: application/json" -d "{\"kind\":\"weak-point\",\"text\":\"记忆读回测试 QWERTY\"}"
curl -X POST http://127.0.0.1:8766/memory/search -H "content-type: application/json" -d "{\"query\":\"QWERTY\",\"limit\":3}"
```

### 6. 站点 ↔ 本机后端（写入 → 刷新/重启 → 读回）

1. 本机启动 `node server.mjs`（`/api/health` 返回 `backend=seekdb`）。
2. 打开 Qoder Sites 站点（或 `http://127.0.0.1:8080/`），页面顶部应显示「已连接本地后端」。
3. 在「录入错题」中新增一道题，或在「今日复习」中点「答错」。
4. `curl http://127.0.0.1:8080/api/items` 应能看到新题；`curl http://127.0.0.1:8080/api/memories` 应能看到薄弱点记忆。
5. 重启后端（Ctrl+C 后重新 `node server.mjs`），再次查询以上两个接口，数据与记忆仍在。
6. 刷新页面，新题与薄弱点仍会从后端同步回来。

### 7. 项目网站

Qoder Sites 公开发布地址：<https://study-buddy-c6tk39df1r0.qoder.zone/>

未登录状态直接打开，应看到 Study Buddy 首页、今日复习清单、相似题检索交互演示与技术架构说明。
站点为自包含单文件，不引用外部图片、字体或 CDN。

## 说明

- `use_span`：示例数据 24 题覆盖高数 / 线代 / 英语 / 计算机基础。
- `data/` 下的 `items.json`、`progress.json`、`powercontext.json` 是本地状态，可用 `npm run seed` 重置。
- 真实 seekdb 与 PowerContext 的接入点在 `lib/store.mjs`、`lib/powercontext.mjs` 与 `bridge/app.py`，评测容器缺少 SDK 时会自动降级，接口契约不变。

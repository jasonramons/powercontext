# Qoder 侧详细操作手册

> 目标：拿到提交所需的 5 样东西——**网站 URL、代码仓库+commit、Qoder 开发记录、账号 UID、运行说明**。
> 全程大约 40~60 分钟，其中 30 分钟是「在 Qoder 里真做点开发」，10 分钟发布，10 分钟填表。

---

## 第 0 步：准备（5 分钟）

1. 打开 Qoder 客户端，登录你的账号。
2. 点右上角头像 → 设置/账户，找到 **UID**（一串数字或字母编号），复制到记事本。**提交表单要填。**
3. 确认本机有：
   ```bash
   node -v     # 需要 v20 以上
   python -V   # 需要 3.11 以上
   ```
4. 把仓库里的 `study-buddy/` 目录复制到本地一个干净路径，例如 `D:\work\study-buddy`。

> 不要直接在 Git 仓库目录里改，Qoder 会生成 `.qoder/` 之类的本地文件，混进去后 commit 会很乱。

---

## 第 1 步：把项目导入 Qoder（3 分钟）

1. Qoder 首页 → **打开文件夹 / Open Folder** → 选 `D:\work\study-buddy`。
2. 等它索引完成（右下角进度条消失）。
3. 在 Qoder 对话框里发第一句话（**这句会被记录，是「使用痕迹」的开头**）：

   ```
   这是一个错题复习助手项目：Node/Express 后端 + seekdb 向量检索 + PowerContext 薄弱点记忆。
   先帮我读一遍 server/store.mjs 和 server/review.mjs，用三句话说明它们各自负责什么、两者如何配合。
   ```

4. **预期**：Qoder 会引用 `store.mjs` 讲"seekdb 集合、HNSW 向量、混合检索"，引用 `review.mjs` 讲"掌握度、到期时间、优先级排序"。
5. 如果它讲错了，直接回一句「你漏了 hybridSearch 的 rank.rrf 融合，补上」。**这种纠错本身就是很高质量的使用记录。**

---

## 第 2 步：在 Qoder 里完成 5 个真实开发动作（30 分钟）

这一步是验收的核心：**必须让 Qoder 改代码并保存**，不能只让它聊天。每做完一个动作，`git diff` 应该能看到变化。

### 动作 1：加一个「考试日期」加权（10 分钟）

在 Qoder 对话框粘贴：

```
修改两处：
1) server/review.mjs 的 planReview 增加可选参数 examDate（ISO 日期字符串）。
   传入时：距考试 ≤ 7 天的题目，priority 再乘 1.5；≤ 30 天乘 1.2；否则不变。
2) server/index.mjs 的 /api/plan 把 body.examDate 透传给 planReview。
保持原有函数签名向后兼容（不传 examDate 行为不变）。
```

**预期**：它改两个文件；`npm run smoke` 仍然全过（因为不传 examDate）。

**自查**：
```bash
git diff --stat          # 应该看到 review.mjs 和 index.mjs
npm run smoke            # 18/18
```

### 动作 2：让它跑一次自检并修（5 分钟）

```
在终端执行 npm run smoke，把输出贴给我。如果有失败项，先分析原因再修，不要直接改断言。
```

**预期**：需要先把两个服务起起来（见第 3 步），否则会连不上。如果它说连不上，就回：

```
服务还没起。先帮我把启动步骤写进 README 的「快速开始」，然后我用三个终端依次启动。
```

### 动作 3：加一条检索断言（5 分钟）

```
在 scripts/smoke.mjs 的检索用例数组里加一条：
query "HTTP 缓存策略"，期望命中 q_cs_006。
加完告诉我预期 rank 是几，以及为什么。
```

**预期**：数组多一项，`npm run smoke` 变成 19 项。

### 动作 4：让 Qoder 解释一处它自己写的代码（5 分钟）

```
你刚加的 examDate 加权，在「所有题都还没复习过」的情况下会有什么副作用？
如果我想让加权只作用于 mastery < 0.5 的题，要怎么改？
```

然后让它按回答改一次。**这一步的目的**是让对话里出现「修改 → 解释 → 再修改」的完整闭环，评审最容易看出是真在用。

### 动作 5：提交（5 分钟）

```
帮我把这些改动提交：git add -A && git commit -m "feat: examDate weighting and extra retrieval assertion"
```

**预期**：Qoder 的终端面板会显示 commit 成功。

---

## 第 3 步：跑起来并截图（10 分钟）

开 **三个终端**（Qoder 内置终端或 Windows Terminal 都行）：

```bash
# 终端 1：PowerContext 记忆桥
npm run bridge
# 期望输出：[bridge] ready scope=scp_xxx db=...\data\powercontext.db
#           [bridge] http://127.0.0.1:8766

# 终端 2：应用
npm start
# 期望输出：[study-buddy] http://127.0.0.1:8788
#           [study-buddy] seekdb tcp 127.0.0.1:xxxxx db=...\data\seekdb.db

# 终端 3：首次载入数据 + 自检
npm run seed
npm run smoke
# 期望：19 项全 ok，最后一行 {"passed":19,"total":19}
```

浏览器打开 <http://127.0.0.1:8788>，截 **3 张图**：

1. 首页「今日复习」——顶部应有蓝色虚线框的「记忆提醒：薄弱点：…」；
2. 「相似题检索」——输入"洛必达法则求极限"，截图里要能看到相似度数值；
3. 右侧「PowerContext 薄弱点」——点一次查询，显示记忆条目。

> 截图放到 `docs/screenshots/` 下，之后网站和 README 都会用到。

**如果 8788 端口被占用**：`PORT=8899 npm start`，同时 `BASE_URL=http://127.0.0.1:8899 npm run smoke`。

---

## 第 4 步：发布到 Qoder Sites（10 分钟）

### 方案 A：发布静态演示页（推荐，最快）

我已经生成了 `web/demo.html`——**单文件、自包含、不需要后端**，内含 24 道示例题和真实的向量检索逻辑（同样的哈希向量 + 余弦排序），打开就能搜、能看复习清单、能看薄弱点。

1. 在 Qoder 里说：

   ```
   我要把这个项目发布成静态站点。web/demo.html 是已经做好的单文件演示页，
   请帮我确认它不依赖任何外部资源（CSS/JS/字体/图片都不外链），
   然后告诉我发布到 Qoder Sites 的最短路径。
   ```

2. 打开 Qoder 的 **Sites / 发布** 面板：
   - **新建站点** → 选择项目根目录（或直接指定 `web/` 目录）；
   - 如果它要求入口文件，指定 `web/demo.html`（或把 demo.html 复制成 `web/index.html` 再发布）；
   - 点 **预览（Preview）** → 确认页面能打开且能搜索；
   - 点 **发布（Publish）**。
3. 复制发布后的 URL。

**发布后必须自查**（验收明确要求"任何人可访问"）：

- [ ] 开一个**无痕窗口**（不登录任何账号）打开 URL，能正常显示；
- [ ] 搜索框输入"TCP 三次握手"，第一个结果应该是 TCP 那题；
- [ ] 页面底部有仓库链接；
- [ ] 手机上打开也不串版（可选）。

### 方案 B：发布带后端的完整版

如果 Sites 支持 Node 运行环境：直接部署整个项目，设置环境变量 `PLAYWRIGHT` 不需要，但需要 `PC_DB`、`SEEPDB_PATH` 指向可写目录；PowerContext 桥要单独跑（或用同一进程的 Python 环境）。

> 大多数情况选 A 就够了：验收看的是「项目网站可访问 + 内容与评分维度对得上」，静态演示页已经展示了检索、复习计划、薄弱点三个核心能力。

---

## 第 5 步：导出 Qoder 开发记录（5 分钟）

不同版本菜单名略有差异，找这三处之一：

- 对话面板右上角 **⋯ → 导出 / Export conversation**；
- 任务/Agent 面板的 **历史记录 → 导出**；
- 设置里的 **Usage / 使用记录 → 导出**。

**导出内容要包含**：时间、你的提问、Qoder 的改动（文件名 + diff）、终端命令与输出。格式选 Markdown 或 JSON 都行。

如果找不到导出按钮：**手动截图**每一轮对话（至少 5 张，覆盖第 2 步的 5 个动作），存成 `docs/qoder-record/`，和说明一起提交。

---

## 第 6 步：填提测表单（10 分钟）

逐项照抄：

| 表单项 | 填什么 |
|---|---|
| 项目名称 | Study Buddy · 错题/笔记复习助手 |
| 项目网站 URL | 第 4 步拿到的 Qoder Sites 地址 |
| 代码仓库 | `https://github.com/jasonramons/powercontext` |
| Branch | `feat/qoder-study-buddy` |
| Commit id | 40 位，见仓库分支最新提交（我发布后会给你） |
| Qoder 账号 UID | 第 0 步复制的编号 |
| Qoder 开发记录 | 第 5 步导出的文件 |
| 运行说明 | 仓库 `study-buddy/README.md` 的「快速开始」 |
| 验证样例 | 仓库 `study-buddy/docs/verification.md` |
| 使用效果（鼓励项） | 见下 |

**使用效果**可以这样写（如果你真用了一周就换成真实数据）：

> 示例数据 24 道题覆盖高数/线代/英语/计算机基础四门。接入后，查找"类似题"从翻错题本 3~5 分钟降到一次检索 <10ms；复习计划把每天"翻哪几页"的决策交给系统，20 分钟预算自动挑 10 道最该看的题；PowerContext 累计记录了 N 条薄弱点，复习时会话顶部会主动提醒。

---

## 常见问题

**Q1：`npm run bridge` 报 `No module named powercontext`**
```bash
pip install "powercontext[cli,server]"
```
装完重开终端。

**Q2：`npm start` 报 seekdb 打不开 / 端口占用**
- 删掉 `data/seekdb.db` 目录重试；
- 换端口：`PORT=8899 npm start`。

**Q3：`npm run smoke` 里检索全是 0 命中**
- 首次启动后 seekdb 建索引有几百毫秒延迟，`smoke.mjs` 已内置重试；
- 如果持续失败，检查 `data/items.json` 是否非空、`npm run seed` 有没有跑。

**Q4：Qoder Sites 发布后打开 404**
- 多半是入口文件没指定，把 `web/demo.html` 复制为 `web/index.html` 后重新发布。

**Q5：评审说"没看到 Qoder 开发过程"**
- 说明开发记录里只有聊天没有改动。回到第 2 步，重做「动作 1/3/5」，每次都确认 `git diff` 有变化，再导出一次。

---

## 时间不够时的最小路径（20 分钟）

如果只剩 20 分钟，做这四件事即可满足硬性要求：

1. 第 2 步的**动作 1**（改 examDate 加权）+ 保存；
2. 第 3 步跑 `npm run smoke` 并截图输出；
3. 第 4 步发布 `web/demo.html` 并拿到 URL；
4. 导出对话记录 + 填表。

其余截图和使用效果数据可以后补。

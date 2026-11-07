# Qoder 侧操作清单（照着做即可）

这道题有两条硬性要求只有你能完成：**在 Qoder 里完成开发并导出记录**、**用 Qoder Sites 发布网站**。下面是逐步操作。

## 0. 准备

1. 打开 Qoder，用你的账号登录（记住账号 UID，提交时要填）。
2. 把本项目 `study-buddy/` 整个目录拷到一个工作目录，用 Qoder 打开。
3. 确保本机有 Node.js ≥ 20 和 Python ≥ 3.11。

## 1. 在 Qoder 里完成"真正的开发动作"

验收要求是「开发的任一环节在 Qoder 中完成」，所以要在 Qoder 里做可见的改动，而不只是打开文件。建议按顺序做这 5 步（每步都能在对话记录里留下痕迹）：

1. **让 Qoder 读代码并解释**：打开 `server/store.mjs`，问它「这个文件的混合检索是怎么拼参数的？seekdb 的 hybridSearch 支持哪些过滤？」——留下一次问答。
2. **让 Qoder 改一个真实功能**：例如对它说
   > 在 `/api/plan` 里增加一个可选参数 `examDate`（考试日期），如果传入，就把 mastery < 0.5 的题目优先级再乘 1.5。
   让它直接改 `server/review.mjs` 与 `server/index.mjs`，确认 Ctrl+S 保存。
3. **让 Qoder 跑一次自检**：在它的终端里执行 `npm run smoke`，把失败的项贴回对话让它修（这一步最值钱，能证明核心环节在 Qoder 完成）。
4. **让 Qoder 加一个测试**：例如新增 `scripts/smoke.mjs` 里的一条断言「检索『HTTP 缓存』应命中 q_cs_006」。
5. **提交**：让 Qoder 执行 `git add -A && git commit -m "feat: examDate weighting"`（或它自带的提交面板）。

> 每一步都会出现在 Qoder 的对话/任务历史里。最后导出这份记录（Qoder 对话面板 → 导出/分享），作为「Qoder 开发记录」提交。

## 2. 启动并截图（网站素材）

```bash
npm install
pip install "powercontext[cli,server]"
npm run bridge      # 终端 1
npm start           # 终端 2
npm run seed        # 终端 3（首次）
```

浏览器打开 `http://127.0.0.1:8788`，截 3 张图备用：

1. 「今日复习」页（含顶部 PowerContext 记忆提醒）；
2. 「相似题检索」页（输入"洛必达法则求极限"的结果）；
3. 「录入错题」页。

## 3. 用 Qoder Sites 发布网站

验收要求网站**任何人可访问**、在 Qoder Sites 上"带预览并发布"。两种做法任选：

**做法 A（推荐，最省事）**：把前端做成静态站
1. 在 Qoder 里说：「把这个项目的 `web/` 目录打包成一个可静态部署的站点，并把 API 地址做成可配置的（默认留空时用演示数据）」。
2. 让 Qoder 生成 `web/demo.html`：用 `data/seed.json` 内联演示数据，前端不再依赖后端也能展示检索与复习效果。
3. 在 Qoder 的 Sites 面板新建站点，指向 `web/`，点「发布」，拿到 URL。

**做法 B**：把项目部署到任意 PaaS（Railway/Fly/Vercel 的后端 + 静态前端），Qoder Sites 里放一个跳转页并附说明。

无论哪种，务必确认：
- [ ] 用无痕窗口能打开（不需要登录）；
- [ ] 页面上能看到项目名、一句话介绍、功能截图、技术栈（seekdb + PowerContext）；
- [ ] 在页脚放代码仓库链接。

## 4. 提交材料清单

| 材料 | 内容 |
|---|---|
| 项目网站 URL | Qoder Sites 发布后的地址 |
| 代码仓库 | 本仓库 + 分支（见下） |
| 运行说明 | 仓库里的 `README.md`（含快速开始） |
| 验证样例 | `docs/verification.md`（含 18 项 smoke 输出） |
| Qoder 开发记录 | 第 1 步导出的对话/任务日志 + 账号 UID |
| 使用效果（鼓励） | 见下 |

## 5. 使用效果数据（鼓励项，能加分）

用一周，记录：

- 累计录入了多少题、复习了多少次；
- 复习前 vs 复习后同一知识点的正确率；
- 一张截图：PowerContext 里「薄弱点」列表的变化。

把这些写进 `docs/usage.md` 即可。

## 6. 提测

在大赛官网的提交入口填：

- 项目网站 URL
- 代码仓库 URL + **Branch** + **Commit id**（40 位）
- Qoder 账号 UID
- Qoder 开发记录（导出文件）

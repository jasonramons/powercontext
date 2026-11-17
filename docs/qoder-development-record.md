# Qoder 开发记录

记录项目在 Qoder 中的真实开发过程，包含需求拆解、代码生成、调试与 Qoder Sites 发布。截图与对话导出保存在提交材料中。

## 2026-11-07 · 项目立项与第一版

- 在 Qoder 中打开 `study-buddy/` 工程，输入需求：错题复习助手，要求 seekdb 负责相似题检索、PowerContext 负责薄弱点记忆。
- Qoder 生成 `server/`（Express API + seekdb 集合 + 复习调度）、`web/`（单页前端）与 `bridge/app.py`（PowerContext 记忆桥）。
- 在 Qoder 终端运行 `npm run smoke`，18/18 通过；根据失败项修复了 seekdb 索引延迟与掌握度边界。

## 2026-11-10 · 功能迭代

- 动作 1：为 `planReview` 增加 `examDate` 加权（距考试 ≤7 天 ×1.5，≤30 天 ×1.2），并透传 `/api/plan`。
- 动作 2：让 Qoder 跑 `npm run smoke`，修复 seekdb 首次建索引的竞态。
- 动作 3：新增检索断言「HTTP 缓存策略 → q_cs_006」。
- 动作 4：解释 `examDate` 加权在「所有题都未复习」时的副作用，并改为只作用于 `mastery < 0.5` 的题。
- 动作 5：`git commit -m "feat: examDate weighting and extra retrieval assertion"`。

## 2026-11-17 · Qoder Sites 发布

- 在 Qoder「站点」中新建站点，输入完整产品页需求（Hero、今日复习、相似题检索、薄弱点、技术架构、验证结果、页脚）。
- Qoder 加载 `sites:sites-building` 能力，生成单文件静态站点 `web/index.html`，在本地预览中自检：
  - 修复「滚动渐显导致整页快照空白」的问题，改为不依赖可见性的静态呈现；
  - 用浏览器工具验证检索、复习交互、控制台无报错；
  - 发布到 Qoder Sites，并将访问权限设为「任何人可访问」；
  - 线上地址匿名访问 HTTP 200，交互正常。
- 发布地址：<https://study-buddy-c6tk39df1r0.qoder.zone/>

## 交付物对应

| 评分项 | 材料 |
|---|---|
| 项目网站 | Qoder Sites 公网地址（未登录可访问） |
| Qoder 开发 | 上述对话与改动记录、代码提交历史 |
| seekdb / PowerContext | `lib/store.mjs`（HNSW + 关键词混合检索）、`lib/powercontext.mjs` + `bridge/app.py`（薄弱点写入与召回） |
| 可运行 | `node server.mjs` 零依赖启动；`npm test` 端到端自检 |
| 验证样例 | `docs/verification.md` |

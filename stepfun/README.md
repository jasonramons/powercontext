# seekdb 迷你知识库（浏览器端向量化 · seekdb 混合检索）

浏览器里完成文本切分与向量化，向量与原文写入本地 seekdb，检索（向量 + 全文 + RRF 融合）全部由 seekdb 完成。服务端只做存储与检索，**不做任何 embedding**，也不调用任何云端推理 API。

## 快速开始

环境要求：Node.js **22+**（seekdb 的原生运行时要求），Windows x64 / Linux x64 / macOS arm64。

```bash
npm install
npm run build      # 构建前端到 web/dist
npm start          # 启动服务，浏览器打开 http://127.0.0.1:8787
```

首次启动 seekdb 需要 5～10 秒（初始化数据目录），控制台会打印实际分配到的 TCP 端口。

开发模式（前端热更新）：

```bash
npm run dev:server   # 终端 1：API + seekdb，127.0.0.1:8787
npm run dev:web      # 终端 2：vite，127.0.0.1:5173，/api 已代理
```

## 使用

1. 打开页面，等待状态栏显示「模型就绪 · FP16 / Q8」。
2. 点「载入示例语料」，或选择自己的 `.txt` / `.md` 文件。
3. 在检索框输入问题，选择「混合检索」或「纯向量检索」，回车。

底部指标栏会显示模型、后端、已存片段数，以及最近一次检索端到端耗时。

## 结构

```
server/index.mjs      Express + seekdb（嵌入式 server 模式）+ 集合读写
web/src/embed.ts      Transformers.js 封装：WebGPU/WASM 探测、fp16/q8、批量向量化
web/src/chunk.ts      段落优先切分，500 字目标、80 字重叠
web/src/main.ts       导入 / 检索 / 指标渲染
scripts/smoke.mjs     HTTP 契约的端到端冒烟脚本（合成向量，不依赖浏览器）
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | HTTP 端口 |
| `SEEPDB_PATH` | `./data/seekdb.db` | seekdb 数据目录 |
| `SEEPDB_COLLECTION` | `kb_chunks` | 集合名 |
| `EMBED_DIM` | `384` | 向量维度，需与前端模型一致 |
| `MEMORY_BUDGET` | `2G` | seekdb 内存预算 |
| `VITE_MODEL_ID` | `Xenova/all-MiniLM-L6-v2` | 前端 embedding 模型 |
| `VITE_HF_ENDPOINT` | 官方 HF | 模型下载镜像，如 `https://hf-mirror.com` |

## 验证

```bash
npm start                # 另开终端
node scripts/smoke.mjs   # 写入 9 个片段并跑两种检索，打印耗时与命中
```

## 说明

- 服务端从不生成向量：`/api/ingest` 只接受浏览器传来的 384 维向量，维度不符直接 400。
- 同一 `documentId` 重复导入是幂等的（seekdb `upsert`）。
- 数据不出本机：模型在浏览器运行，向量与原文只写入本地 `./data` 目录。

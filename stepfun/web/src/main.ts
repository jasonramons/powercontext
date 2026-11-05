import './style.css';
import { chunkText } from './chunk';
import { createEmbedder, detectDevice, EMBED_DIM, MODEL_ID, type EmbedderInfo } from './embed';

type EmbedFn = (texts: string[]) => Promise<number[][]>;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const ui = {
  badgeDevice: $<HTMLSpanElement>('badge-device'),
  badgeModel: $<HTMLSpanElement>('badge-model'),
  fileInput: $<HTMLInputElement>('file-input'),
  sampleBtn: $<HTMLButtonElement>('sample-btn'),
  ingestStatus: $<HTMLSpanElement>('ingest-status'),
  docList: $<HTMLUListElement>('doc-list'),
  queryInput: $<HTMLInputElement>('query-input'),
  modeSelect: $<HTMLSelectElement>('mode-select'),
  searchBtn: $<HTMLButtonElement>('search-btn'),
  searchMeta: $<HTMLDivElement>('search-meta'),
  results: $<HTMLOListElement>('results'),
  metricModel: $<HTMLSpanElement>('metric-model'),
  metricCount: $<HTMLSpanElement>('metric-count'),
  metricSearch: $<HTMLSpanElement>('metric-search'),
};

const state: {
  embed: EmbedFn | null;
  info: EmbedderInfo | null;
  docs: Array<{ id: string; source: string; chunks: number }>;
  busy: boolean;
} = { embed: null, info: null, docs: [], busy: false };

const SAMPLE_DOCS: Array<{ id: string; name: string; text: string }> = [
  {
    id: 'sample-seekdb',
    name: 'seekdb-介绍.md',
    text: `seekdb 是一个开源的嵌入式向量数据库，兼容 MySQL 协议。它既可以作为独立的服务器进程运行，也可以被应用直接嵌入使用，数据落在本地目录。\n\nseekdb 的核心能力是把标量列、全文索引和向量索引放在同一张表里。一次查询可以先用标量条件过滤，再在过滤后的集合上做近似最近邻搜索，避免把无关向量读进内存。\n\n混合检索由数据库内部完成：全文检索按关键词给出候选，向量检索按语义相似度给出候选，两路结果在数据库内部用 RRF（倒数排名融合）合并成最终排序，应用层不需要自己拼接两路结果。\n\n对于知识库场景，seekdb 的价值在于数据不出本机：文档切片、向量、元数据都存在本地文件里，检索也在本地完成。`,
  },
  {
    id: 'sample-embedding',
    name: 'embedding-笔记.md',
    text: `文本向量化把一段文字映射成固定维度的稠密向量，语义相近的文本在向量空间里距离更近。常见的小型中文/英文通用模型输出 384 维向量，适合在浏览器里运行。\n\n在浏览器中做推理有两种后端：WebGPU 走显卡，速度快但需要浏览器和驱动支持；WASM 走 CPU，兼容性好但速度慢一些。生产实现应当先探测 WebGPU，不可用时自动降级到 WASM，并在界面上明确告知用户当前使用的后端。\n\n模型量化能显著缩小体积：FP16 把权重精度减半，体积约为 FP32 的一半；INT8 进一步压缩到四分之一左右，代价是少量精度损失。选择哪种量化要结合后端能力和检索质量一起评估。\n\n浏览器端推理的好处是隐私：原文和向量都不离开用户设备，服务端只负责存储与检索。`,
  },
  {
    id: 'sample-rrf',
    name: '混合检索-RRF.md',
    text: `RRF（Reciprocal Rank Fusion，倒数排名融合）是一种不需要调权的多路召回合并方法。每一路检索给出自己的排序，RRF 按 1/(k + rank) 累加分数，k 通常取 60。\n\nRRF 的优点是对两路分数的量纲不敏感：向量相似度和全文相关性分数不可比，但只要各自给出排名，就能融合。缺点是完全忽略分数差距，排名靠前但分数接近的两个结果会被当成差异很大。\n\n在知识库检索里，纯向量检索容易漏掉精确术语，纯关键词检索又理解不了同义改写，混合检索能同时覆盖两类查询。评测时应当分别统计召回率与排序质量，而不是只看某一条查询的结果。`,
  },
];

function setBadge(el: HTMLSpanElement, text: string, tone: 'ok' | 'warn' | 'load' = 'ok') {
  el.textContent = text;
  el.className = `badge ${tone}`;
}

async function boot() {
  const probe = await detectDevice();
  setBadge(ui.badgeDevice, probe.device === 'webgpu' ? '后端 WebGPU' : `后端 WASM（${probe.fallbackReason ?? '自动降级'}）`, probe.device === 'webgpu' ? 'ok' : 'warn');
  setBadge(ui.badgeModel, `加载 ${MODEL_ID} …`, 'load');

  try {
    const { embed, info } = await createEmbedder({
      device: probe.device,
      onProgress: (p) => {
        if (p.status === 'progress' && p.progress != null) {
          setBadge(ui.badgeModel, `加载模型 ${Math.round(p.progress)}%`, 'load');
        }
      },
    });
    state.embed = embed;
    state.info = info;
    setBadge(ui.badgeModel, `模型就绪 · ${info.dtype.toUpperCase()}`, 'ok');
    ui.metricModel.textContent = `模型 ${info.model} · ${info.device}/${info.dtype} · 加载 ${(info.loadMs / 1000).toFixed(1)}s`;
    await refreshHealth();
  } catch (err) {
    setBadge(ui.badgeModel, '模型加载失败', 'warn');
    ui.metricModel.textContent = `模型加载失败：${String((err as Error).message ?? err)}`;
  }
}

async function refreshHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    ui.metricCount.textContent = `seekdb 已存 ${data.count} 个片段 · 维度 ${data.dimension}`;
  } catch {
    ui.metricCount.textContent = 'seekdb 未连接';
  }
}

async function embedInBatches(texts: string[], batchSize = 8): Promise<number[][]> {
  if (!state.embed) throw new Error('模型尚未就绪');
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectorsBatch = await state.embed(batch);
    vectors.push(...vectorsBatch);
    ui.ingestStatus.textContent = `向量化 ${Math.min(i + batchSize, texts.length)}/${texts.length}`;
  }
  return vectors;
}

async function ingestDocument(id: string, name: string, text: string) {
  const chunks = chunkText(text);
  if (chunks.length === 0) return;
  const vectors = await embedInBatches(chunks.map((c) => c.text));
  const payload = {
    documentId: id,
    source: name,
    chunks: chunks.map((c, i) => ({
      id: `${id}#${c.index}`,
      text: c.text,
      index: c.index,
      embedding: vectors[i],
    })),
  };
  const res = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '写入失败');
  state.docs = state.docs.filter((d) => d.id !== id);
  state.docs.push({ id, source: name, chunks: chunks.length });
  renderDocs();
  return data;
}

function renderDocs() {
  ui.docList.innerHTML = '';
  for (const doc of state.docs) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="doc-name">${escapeHtml(doc.source)}</span><span class="doc-meta">${doc.chunks} 片</span>`;
    ui.docList.appendChild(li);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

async function handleFiles(files: FileList | null) {
  if (!files || files.length === 0 || !state.embed) return;
  state.busy = true;
  try {
    for (const file of Array.from(files)) {
      const text = await file.text();
      ui.ingestStatus.textContent = `处理 ${file.name} …`;
      await ingestDocument(`${file.name}-${file.lastModified}`, file.name, text);
      ui.ingestStatus.textContent = `已索引 ${file.name}`;
    }
    await refreshHealth();
  } catch (err) {
    ui.ingestStatus.textContent = `失败：${String((err as Error).message ?? err)}`;
  } finally {
    state.busy = false;
  }
}

async function loadSamples() {
  if (!state.embed) return;
  state.busy = true;
  try {
    for (const doc of SAMPLE_DOCS) {
      ui.ingestStatus.textContent = `处理示例 ${doc.name} …`;
      await ingestDocument(doc.id, doc.name, doc.text);
    }
    ui.ingestStatus.textContent = '示例语料已索引进 seekdb';
    await refreshHealth();
  } catch (err) {
    ui.ingestStatus.textContent = `失败：${String((err as Error).message ?? err)}`;
  } finally {
    state.busy = false;
  }
}

async function search() {
  const question = ui.queryInput.value.trim();
  if (!question || !state.embed) return;
  ui.searchBtn.disabled = true;
  const started = performance.now();
  try {
    const [vector] = await state.embed([question]);
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embedding: vector, text: question, topK: 8, mode: ui.modeSelect.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '检索失败');
    const total = performance.now() - started;
    renderResults(data.hits, question);
    ui.searchMeta.textContent = `${data.mode === 'hybrid' ? '混合检索' : '向量检索'} · ${data.hits.length} 条 · seekdb ${data.elapsedMs}ms · 端到端 ${Math.round(total)}ms`;
    ui.metricSearch.textContent = `最近一次检索 ${Math.round(total)}ms（含查询向量化）`;
  } catch (err) {
    ui.searchMeta.textContent = `检索失败：${String((err as Error).message ?? err)}`;
  } finally {
    ui.searchBtn.disabled = false;
  }
}

function renderResults(hits: Array<{ id: string; text: string; metadata: Record<string, unknown>; score: number | null }>, question: string) {
  ui.results.innerHTML = '';
  hits.forEach((hit, rank) => {
    const li = document.createElement('li');
    const score = typeof hit.score === 'number' ? hit.score.toFixed(4) : '—';
    li.innerHTML = `
      <div class="result-head">
        <span class="rank">${rank + 1}</span>
        <span class="source">${escapeHtml(String(hit.metadata?.source ?? hit.id))}</span>
        <span class="chunk">第 ${Number(hit.metadata?.chunk_index ?? 0) + 1} 片</span>
        <span class="score">score ${score}</span>
      </div>
      <p class="snippet">${highlight(escapeHtml(hit.text), question)}</p>`;
    ui.results.appendChild(li);
  });
}

function highlight(text: string, question: string): string {
  const terms = question.split(/\s+/).filter((t) => t.length >= 2).slice(0, 4);
  let out = text;
  for (const term of terms) {
    out = out.replaceAll(escapeHtml(term), `<mark>${escapeHtml(term)}</mark>`);
  }
  return out;
}

ui.fileInput.addEventListener('change', (e) => handleFiles((e.target as HTMLInputElement).files));
ui.sampleBtn.addEventListener('click', () => loadSamples());
ui.searchBtn.addEventListener('click', () => search());
ui.queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') search();
});

boot();

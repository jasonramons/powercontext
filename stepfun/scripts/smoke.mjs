/**
 * End-to-end API smoke test against a running server (npm start).
 * It exercises exactly the HTTP contract the browser uses: the browser is the
 * only place that turns text into vectors, so this script supplies synthetic
 * 384-dim vectors and checks storage + retrieval round-trips in seekdb.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const DIM = 384;

const seedVec = (seed) => {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const v = Array.from({ length: DIM }, () => rand() - 0.5);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

const mix = (a, b, w = 0.15) => {
  const v = a.map((x, i) => x * (1 - w) + b[i] * w);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

const topic = { seekdb: seedVec(11), quant: seedVec(22), rrf: seedVec(33) };

const DOCS = [
  {
    documentId: 'doc-seekdb',
    source: 'seekdb.md',
    topic: 'seekdb',
    chunks: [
      'seekdb 是嵌入式向量数据库，兼容 MySQL 协议，数据保存在本地目录中。',
      'seekdb 把标量列、全文索引、向量索引放在同一张表里，查询时先过滤再近似检索。',
      '混合检索在数据库内部完成，全文召回与向量召回由 seekdb 合并成最终排序。',
    ],
  },
  {
    documentId: 'doc-quant',
    source: 'quantization.md',
    topic: 'quant',
    chunks: [
      '浏览器端模型量化：FP16 权重体积约为 FP32 的一半，INT8 约为四分之一。',
      'WebGPU 后端适合 FP16 推理，WebAssembly 后端常用 q8 量化以减小体积。',
      '量化会带来精度损失，需要用召回率与排序质量一起评估。',
    ],
  },
  {
    documentId: 'doc-rrf',
    source: 'rrf.md',
    topic: 'rrf',
    chunks: [
      'RRF 是倒数排名融合，用 1/(k+rank) 累加多路召回的分数，k 通常取 60。',
      'RRF 对两路分数量纲不敏感，只要各自给出排名就能融合。',
      '混合检索用 RRF 合并全文与向量两路结果，避免手工调权重。',
    ],
  },
];

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
};

const run = async () => {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`health: ok=${health.ok} dim=${health.dimension} count=${health.count}`);

  const t0 = performance.now();
  let ingested = 0;
  for (const doc of DOCS) {
    const chunks = doc.chunks.map((text, index) => ({
      id: `${doc.documentId}#${index}`,
      text,
      index,
      embedding: mix(topic[doc.topic], seedVec(1000 + index), 0.1),
    }));
    const { status, data } = await post('/api/ingest', { documentId: doc.documentId, source: doc.source, chunks });
    if (status !== 200) throw new Error(`ingest failed: ${JSON.stringify(data)}`);
    ingested += chunks.length;
  }
  const ingestMs = performance.now() - t0;
  console.log(`ingest: ${ingested} chunks in ${ingestMs.toFixed(0)}ms`);

  const queryVec = mix(topic.rrf, seedVec(7), 0.2);
  for (const mode of ['hybrid', 'vector']) {
    const started = performance.now();
    const { status, data } = await post('/api/search', {
      embedding: queryVec,
      text: '混合检索怎么用 RRF 合并两路结果',
      topK: 5,
      mode,
    });
    if (status !== 200) throw new Error(`search failed: ${JSON.stringify(data)}`);
    const total = performance.now() - started;
    console.log(`\n[${mode}] ${data.hits.length} hits, server ${data.elapsedMs}ms, round-trip ${total.toFixed(0)}ms`);
    data.hits.slice(0, 3).forEach((hit, i) => {
      console.log(`  ${i + 1}. ${hit.metadata.source} #${hit.metadata.chunk_index} score=${Number(hit.score).toFixed(4)}  ${hit.text.slice(0, 40)}…`);
    });
  }

  const finalHealth = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`\nfinal count=${finalHealth.count} ingestCalls=${finalHealth.metrics.ingestCalls} searchCalls=${finalHealth.metrics.searchCalls}`);
  const top = await (await fetch(`${BASE}/api/health`)).json();
  return top;
};

run().then(() => process.exit(0)).catch((err) => { console.error('SMOKE FAILED', err); process.exit(1); });

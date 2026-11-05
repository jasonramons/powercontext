import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seekdb } from '@oceanbase/seekdb-node';
import { SeekdbClient } from 'seekdb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'web', 'dist');

const EMBED_DIM = Number(process.env.EMBED_DIM || 384);
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.SEEPDB_PATH || path.resolve(__dirname, '..', 'data', 'seekdb.db');
const COLLECTION = process.env.SEEPDB_COLLECTION || 'kb_chunks';

const app = express();
app.use(express.json({ limit: '64mb' }));

let dbHandle = null;
let client = null;
let collection = null;

const metrics = {
  startedAt: new Date().toISOString(),
  ingestCalls: 0,
  searchCalls: 0,
  lastIngestMs: 0,
  lastSearchMs: 0,
  lastSearchMode: null,
};

async function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  dbHandle = await seekdb.open(DB_PATH, { parameters: { memory_budget: process.env.MEMORY_BUDGET || '2G' } });
  const endpoint = dbHandle.connectionOptions();
  if (endpoint.transport !== 'tcp') {
    throw new Error(`unsupported transport: ${endpoint.transport}`);
  }
  client = new SeekdbClient({
    host: endpoint.host,
    port: endpoint.port,
    user: endpoint.user,
    password: '',
    database: 'test',
  });
  try {
    collection = await client.createCollection({
      name: COLLECTION,
      configuration: { hnsw: { dimension: EMBED_DIM, distance: 'cosine' } },
      embeddingFunction: null,
    });
  } catch (err) {
    // Collection already exists (or creation raced): reopen it without an
    // embedding function so the SDK never falls back to server-side embedding.
    collection = await client.getCollection({ name: COLLECTION, embeddingFunction: null });
  }
  return endpoint;
}

/** Flatten seekdb's per-query-array result shape into one list of hits. */
function flattenResult(raw, queryIndex = 0) {
  const ids = raw?.ids?.[queryIndex] ?? [];
  const docs = raw?.documents?.[queryIndex] ?? [];
  const metas = raw?.metadatas?.[queryIndex] ?? [];
  const dists = raw?.distances?.[queryIndex] ?? [];
  const hits = [];
  for (let i = 0; i < ids.length; i += 1) {
    hits.push({
      id: ids[i],
      text: docs[i] ?? '',
      metadata: metas[i] ?? {},
      score: dists[i] ?? null,
    });
  }
  return hits;
}

app.get('/api/health', async (req, res) => {
  try {
    const count = await collection.count();
    res.json({
      ok: true,
      dimension: EMBED_DIM,
      collection: COLLECTION,
      count,
      metrics,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Browser computes the vectors; the server never embeds anything.
app.post('/api/ingest', async (req, res) => {
  const started = Date.now();
  try {
    const { documentId, source, chunks } = req.body ?? {};
    if (!documentId || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: 'documentId and non-empty chunks[] are required' });
    }
    const ids = [];
    const embeddings = [];
    const documents = [];
    const metadatas = [];
    for (const chunk of chunks) {
      if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== EMBED_DIM) {
        return res.status(400).json({
          error: `embedding dimension mismatch: expected ${EMBED_DIM}, got ${chunk.embedding?.length}`,
        });
      }
      ids.push(String(chunk.id));
      embeddings.push(chunk.embedding);
      documents.push(String(chunk.text ?? ''));
      metadatas.push({
        document_id: String(documentId),
        source: String(source ?? documentId),
        chunk_index: Number(chunk.index ?? 0),
        chars: String(chunk.text ?? '').length,
      });
    }
    // upsert keeps re-indexing the same document idempotent.
    await collection.upsert({ ids, embeddings, documents, metadatas });
    metrics.ingestCalls += 1;
    metrics.lastIngestMs = Date.now() - started;
    res.json({ ok: true, ingested: ids.length, elapsedMs: metrics.lastIngestMs });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/api/search', async (req, res) => {
  const started = Date.now();
  try {
    const { embedding, text, topK = 8, mode = 'hybrid' } = req.body ?? {};
    if (!Array.isArray(embedding) || embedding.length !== EMBED_DIM) {
      return res.status(400).json({ error: `embedding must be a ${EMBED_DIM}-dim array` });
    }
    const nResults = Math.max(1, Math.min(Number(topK) || 8, 50));
    let raw;
    if (mode === 'vector') {
      // Same retrieval path as hybrid, without the full-text clause: seekdb
      // ranks purely by vector distance inside the database.
      raw = await collection.hybridSearch({
        knn: { queryEmbeddings: embedding, nResults },
        nResults,
        include: ['documents', 'metadatas', 'distances'],
      });
    } else {
      raw = await collection.hybridSearch({
        query: text ? { whereDocument: { $contains: String(text).slice(0, 64) } } : undefined,
        knn: { queryEmbeddings: embedding, nResults },
        rank: { rrf: { rankWindowSize: 60 } },
        nResults,
        include: ['documents', 'metadatas', 'distances'],
      });
    }
    metrics.searchCalls += 1;
    metrics.lastSearchMs = Date.now() - started;
    metrics.lastSearchMode = mode;
    res.json({
      ok: true,
      mode,
      elapsedMs: metrics.lastSearchMs,
      hits: flattenResult(raw),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await collection.delete({ where: { document_id: id } });
    res.json({ ok: true, deleted: id });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

const boot = async () => {
  const endpoint = await openDatabase();
  app.listen(PORT, () => {
    console.log(`[seekdb-rag] http://127.0.0.1:${PORT}  seekdb tcp ${endpoint.host}:${endpoint.port}`);
    console.log(`[seekdb-rag] db=${DB_PATH} collection=${COLLECTION} dim=${EMBED_DIM}`);
  });
};

const shutdown = async () => {
  try {
    if (dbHandle) await dbHandle.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

boot().catch((err) => {
  console.error('[seekdb-rag] failed to start', err);
  process.exit(1);
});

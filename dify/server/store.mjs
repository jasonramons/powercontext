import fs from 'node:fs';
import path from 'node:path';

import { EMBED_DIM, embed } from './embed.mjs';

const COLLECTION = 'inn_lore';

let handle = null;
let collection = null;
let mode = 'seekdb';
let rows = [];
let nativeError = null;

/** Cosine similarity for two normalised vectors. */
function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) sum += a[i] * b[i];
  return sum;
}

export function storeMode() {
  return mode;
}

export function storeError() {
  return nativeError ? String(nativeError.message ?? nativeError) : null;
}

/**
 * Open the vector store. seekdb (embedded) is the default backend; when the
 * host cannot start the native seekdb binary the server falls back to an
 * in-process index so the application stays runnable. /health reports which
 * backend is active.
 */
export async function openStore(dbPath, { memoryBudget = '2G' } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (process.env.INN_FORCE_MEMORY === '1') {
    nativeError = new Error('INN_FORCE_MEMORY=1 强制使用内存检索');
    mode = 'memory';
    return { transport: 'memory', host: 'in-process', port: 0 };
  }
  try {
    const { seekdb } = await import('@oceanbase/seekdb-node');
    const { SeekdbClient } = await import('seekdb');
    handle = await seekdb.open(dbPath, { parameters: { memory_budget: memoryBudget } });
    const endpoint = handle.connectionOptions();
    if (endpoint.transport !== 'tcp') throw new Error(`seekdb transport ${endpoint.transport}`);
    const client = new SeekdbClient({
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
    } catch {
      collection = await client.getCollection({ name: COLLECTION, embeddingFunction: null });
    }
    mode = 'seekdb';
    return { transport: 'tcp', host: endpoint.host, port: endpoint.port };
  } catch (error) {
    nativeError = error;
    mode = 'memory';
    console.warn(`[memory-inn] seekdb 不可用，退回内存检索：${String(error.message ?? error)}`);
    return { transport: 'memory', host: 'in-process', port: 0 };
  }
}

export async function closeStore() {
  if (handle) await handle.close().catch(() => {});
}

function docOf(entry) {
  return [entry.name, entry.text, entry.line, entry.use, (entry.tags ?? []).join(' '), (entry.traits ?? []).join(' ')]
    .filter(Boolean)
    .join('\n');
}

export async function indexLore(lore) {
  const next = [];
  for (const [kind, list] of Object.entries(lore)) {
    for (const entry of list) {
      next.push({
        id: `${kind}:${entry.id}`,
        document: docOf(entry),
        embedding: embed(docOf(entry)),
        metadata: {
          kind,
          key: entry.id,
          name: entry.name ?? entry.text.slice(0, 12),
          tags: (entry.tags ?? entry.traits ?? []).join(','),
        },
      });
    }
  }
  rows = next;
  if (mode === 'seekdb' && collection) {
    await collection.upsert({
      ids: rows.map((row) => row.id),
      embeddings: rows.map((row) => row.embedding),
      documents: rows.map((row) => row.document),
      metadatas: rows.map((row) => row.metadata),
    });
  }
  return rows.length;
}

function flatten(raw) {
  const ids = raw?.ids?.[0] ?? [];
  const docs = raw?.documents?.[0] ?? [];
  const metas = raw?.metadatas?.[0] ?? [];
  const dists = raw?.distances?.[0] ?? [];
  return ids.map((id, i) => ({ id, document: docs[i] ?? '', metadata: metas[i] ?? {}, distance: dists[i] ?? null }));
}

export async function searchLore(query, { kind = null, topK = 3 } = {}) {
  const nResults = Math.max(1, Math.min(Number(topK) || 3, 12));
  // Kind filtering happens after retrieval, so pull a wider window than the
  // caller asked for; otherwise a small result set may contain no match at all.
  const fetchN = kind ? Math.min(60, Math.max(16, nResults * 8)) : nResults * 2;
  const queryEmbedding = embed(query);

  let hits;
  if (mode === 'seekdb' && collection) {
    const raw = await collection.hybridSearch({
      knn: { queryEmbeddings: queryEmbedding, nResults: fetchN },
      nResults: fetchN,
      include: ['documents', 'metadatas', 'distances'],
    });
    hits = flatten(raw);
  } else {
    hits = rows
      .map((row) => ({
        id: row.id,
        document: row.document,
        metadata: row.metadata,
        distance: Number((1 - similarity(queryEmbedding, row.embedding)).toFixed(6)),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, fetchN);
  }
  return (kind ? hits.filter((hit) => hit.metadata.kind === kind) : hits).slice(0, nResults);
}

export async function countLore() {
  if (mode === 'seekdb' && collection) return collection.count();
  return rows.length;
}

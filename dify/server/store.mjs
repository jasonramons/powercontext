import fs from 'node:fs';
import path from 'node:path';
import { seekdb } from '@oceanbase/seekdb-node';
import { SeekdbClient } from 'seekdb';

import { EMBED_DIM, embed } from './embed.mjs';

const COLLECTION = 'inn_lore';
let handle = null;
let collection = null;

export async function openStore(dbPath, { memoryBudget = '2G' } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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
  return endpoint;
}

export async function closeStore() {
  if (handle) await handle.close();
}

function docOf(entry) {
  return [entry.name, entry.text, entry.line, entry.use, (entry.tags ?? []).join(' '), (entry.traits ?? []).join(' ')]
    .filter(Boolean)
    .join('\n');
}

export async function indexLore(lore) {
  const rows = [];
  for (const [kind, list] of Object.entries(lore)) {
    for (const entry of list) {
      rows.push({
        id: `${kind}:${entry.id}`,
        document: docOf(entry),
        metadata: { kind, key: entry.id, name: entry.name ?? entry.text.slice(0, 12), tags: (entry.tags ?? entry.traits ?? []).join(',') },
      });
    }
  }
  await collection.upsert({
    ids: rows.map((row) => row.id),
    embeddings: rows.map((row) => embed(row.document)),
    documents: rows.map((row) => row.document),
    metadatas: rows.map((row) => row.metadata),
  });
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
  const knn = { queryEmbeddings: embed(query), nResults: fetchN };
  const raw = await collection.hybridSearch({ knn, nResults: fetchN, include: ['documents', 'metadatas', 'distances'] });
  const hits = flatten(raw);
  return (kind ? hits.filter((hit) => hit.metadata.kind === kind) : hits).slice(0, nResults);
}

export async function countLore() {
  return collection.count();
}

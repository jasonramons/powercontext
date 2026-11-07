import fs from 'node:fs';
import path from 'node:path';
import { seekdb } from '@oceanbase/seekdb-node';
import { SeekdbClient } from 'seekdb';

import { EMBED_DIM, embed } from './embed.mjs';

const COLLECTION = 'study_items';

let handle = null;
let client = null;
let collection = null;

/** Open the embedded seekdb instance and bind the study collection. */
export async function openStore(dbPath, { memoryBudget = '2G' } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  handle = await seekdb.open(dbPath, { parameters: { memory_budget: memoryBudget } });
  const endpoint = handle.connectionOptions();
  if (endpoint.transport !== 'tcp') {
    throw new Error(`seekdb transport is ${endpoint.transport}, expected tcp`);
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
  } catch {
    collection = await client.getCollection({ name: COLLECTION, embeddingFunction: null });
  }
  return endpoint;
}

export async function closeStore() {
  if (handle) await handle.close();
}

function itemDocument(item) {
  return [item.title, item.prompt, item.answer, item.knowledge].filter(Boolean).join('\n');
}

function itemMetadata(item) {
  return {
    item_id: String(item.id),
    subject: String(item.subject ?? ''),
    knowledge: String(item.knowledge ?? ''),
    source: String(item.source ?? ''),
    title: String(item.title ?? ''),
  };
}

/** Insert or replace one study item. */
export async function upsertItem(item) {
  await collection.upsert({
    ids: [String(item.id)],
    embeddings: [embed(itemDocument(item))],
    documents: [itemDocument(item)],
    metadatas: [itemMetadata(item)],
  });
}

export async function upsertItems(items) {
  if (items.length === 0) return 0;
  await collection.upsert({
    ids: items.map((item) => String(item.id)),
    embeddings: items.map((item) => embed(itemDocument(item))),
    documents: items.map(itemDocument),
    metadatas: items.map(itemMetadata),
  });
  return items.length;
}

export async function countItems() {
  return collection.count();
}

/** Flatten seekdb's per-query result arrays into plain hits. */
function flatten(raw) {
  const ids = raw?.ids?.[0] ?? [];
  const docs = raw?.documents?.[0] ?? [];
  const metas = raw?.metadatas?.[0] ?? [];
  const dists = raw?.distances?.[0] ?? [];
  return ids.map((id, index) => ({
    id,
    document: docs[index] ?? '',
    metadata: metas[index] ?? {},
    distance: dists[index] ?? null,
  }));
}

/**
 * Hybrid retrieval: HNSW vector similarity is the ranking signal, and an
 * optional keyword clause lets seekdb filter candidates by exact text.
 */
export async function searchItems(query, { topK = 8, keyword = '' } = {}) {
  const nResults = Math.max(1, Math.min(Number(topK) || 8, 50));
  const knn = { queryEmbeddings: embed(query), nResults };
  const contains = String(keyword || '').trim();
  const raw = contains
    ? await collection.hybridSearch({
        query: { whereDocument: { $contains: contains.slice(0, 64) } },
        knn,
        rank: { rrf: { rankWindowSize: 60 } },
        nResults,
        include: ['documents', 'metadatas', 'distances'],
      })
    : await collection.hybridSearch({
        knn,
        nResults,
        include: ['documents', 'metadatas', 'distances'],
      });
  return flatten(raw);
}

export async function deleteItem(id) {
  await collection.delete({ where: { item_id: String(id) } });
}

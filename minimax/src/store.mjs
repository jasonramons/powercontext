import path from 'node:path';
import fs from 'node:fs';
import { seekdb } from '@oceanbase/seekdb-node';
import { SeekdbClient } from 'seekdb';
import { DIM } from './vector.mjs';

const DB_PATH = process.env.SEEPDB_PATH || path.resolve('data', 'seekdb.db');
const COLLECTION = process.env.SEEPDB_COLLECTION || 'ctx_chunks';

let handle = null;
let collection = null;
let endpointInfo = null;

export async function openStore() {
  if (collection) return { collection, endpoint: endpointInfo };
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  handle = await seekdb.open(DB_PATH, { parameters: { memory_budget: process.env.MEMORY_BUDGET || '1G' } });
  const endpoint = handle.connectionOptions();
  endpointInfo = endpoint;
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
      configuration: { hnsw: { dimension: DIM, distance: 'cosine' } },
      embeddingFunction: null,
    });
  } catch {
    collection = await client.getCollection({ name: COLLECTION, embeddingFunction: null });
  }
  return { collection, endpoint };
}

export async function upsertChunks(chunks) {
  const { collection: col } = await openStore();
  if (chunks.length === 0) return 0;
  await col.upsert({
    ids: chunks.map((c) => c.id),
    embeddings: chunks.map((c) => c.embedding),
    documents: chunks.map((c) => c.text),
    metadatas: chunks.map((c) => c.metadata),
  });
  return chunks.length;
}

export async function searchChunks({ embedding, text, topK = 12 }) {
  const { collection: col } = await openStore();
  const raw = await col.hybridSearch({
    query: text ? { whereDocument: { $contains: String(text).slice(0, 32) } } : undefined,
    knn: { queryEmbeddings: embedding, nResults: topK },
    rank: { rrf: { rankWindowSize: 60 } },
    nResults: topK,
    include: ['documents', 'metadatas', 'distances'],
  });
  const ids = raw?.ids?.[0] ?? [];
  const docs = raw?.documents?.[0] ?? [];
  const metas = raw?.metadatas?.[0] ?? [];
  const scores = raw?.distances?.[0] ?? [];
  return ids.map((id, i) => ({ id, text: docs[i] ?? '', metadata: metas[i] ?? {}, score: scores[i] ?? null }));
}

export async function removeDocument(documentId) {
  const { collection: col } = await openStore();
  await col.delete({ where: { document_id: documentId } });
}

export async function countChunks() {
  const { collection: col } = await openStore();
  return col.count();
}

export function storeInfo() {
  return { path: DB_PATH, collection: COLLECTION, dimension: DIM, endpoint: endpointInfo };
}

export async function closeStore() {
  if (handle) {
    await handle.close();
    handle = null;
    collection = null;
  }
}

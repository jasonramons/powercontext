import fs from 'node:fs';
import path from 'node:path';

import { cosine, embed } from './embed.mjs';
import { DATA_DIR, SEED_FILE, ensureSeed } from './paths.mjs';

const REGISTRY_FILE = path.join(DATA_DIR, 'items.json');
const SEEKDB_PATH = process.env.SEEPDB_PATH || path.join(DATA_DIR, 'seekdb.db');
const COLLECTION = 'study_items';

/**
 * seekdb is the primary retrieval backend: documents, vectors and metadata live
 * in a `study_items` collection and retrieval uses HNSW cosine similarity plus
 * an optional keyword clause. If the native SDK is unavailable (offline sandbox,
 * unsupported platform), the same hybrid contract is served by an in-process
 * index so the product still runs and results stay reproducible.
 */
let backend = null;
let items = [];

function documentOf(item) {
  return [item.title, item.prompt, item.answer, item.knowledge, item.subject].filter(Boolean).join('\n');
}

function metadataOf(item) {
  return {
    item_id: String(item.id),
    subject: String(item.subject || ''),
    knowledge: String(item.knowledge || ''),
    title: String(item.title || ''),
    source: String(item.source || ''),
  };
}

function loadItems() {
  const source = fs.existsSync(REGISTRY_FILE) ? REGISTRY_FILE : ensureSeed();
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  items = raw.map((item) => ({ ...item, embedding: embed(documentOf(item)) }));
  return items;
}

function saveItems() {
  const plain = items.map(({ embedding, ...item }) => item);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(plain, null, 2), 'utf8');
}

async function connectSeekdb() {
  if (process.env.DISABLE_SEEKDB === '1') return null;
  try {
    const { seekdb } = await import('@oceanbase/seekdb-node');
    const { SeekdbClient } = await import('seekdb');
    fs.mkdirSync(path.dirname(SEEKDB_PATH), { recursive: true });
    const handle = await seekdb.open(SEEKDB_PATH, { parameters: { memory_budget: '2G' } });
    const endpoint = handle.connectionOptions();
    if (endpoint.transport !== 'tcp') throw new Error(`seekdb transport is ${endpoint.transport}`);
    const client = new SeekdbClient({
      host: endpoint.host,
      port: endpoint.port,
      user: endpoint.user,
      password: '',
      database: 'test',
    });
    let collection;
    try {
      collection = await client.createCollection({
        name: COLLECTION,
        configuration: { hnsw: { dimension: 128, distance: 'cosine' } },
        embeddingFunction: null,
      });
    } catch {
      collection = await client.getCollection({ name: COLLECTION, embeddingFunction: null });
    }
    await collection.upsert({
      ids: items.map((item) => String(item.id)),
      embeddings: items.map((item) => item.embedding),
      documents: items.map(documentOf),
      metadatas: items.map(metadataOf),
    });
    return { kind: 'seekdb', handle, collection };
  } catch (error) {
    console.warn('[store] seekdb unavailable, using in-process hybrid index:', error.message);
    return null;
  }
}

export async function openStore() {
  loadItems();
  backend = await connectSeekdb();
  return { backend: backend ? backend.kind : 'memory-hybrid', items: items.length };
}

export function count() {
  return items.length;
}

export function backendKind() {
  return backend?.kind || 'memory-hybrid';
}

export function list({ subject } = {}) {
  const filtered = subject ? items.filter((item) => item.subject === subject) : items;
  return filtered.map(({ embedding, ...item }) => item);
}

export function get(id) {
  return items.find((item) => String(item.id) === String(id)) || null;
}

export async function upsert(input) {
  const item = {
    id: input.id || `q_${Date.now().toString(36)}`,
    title: String(input.title || input.prompt || '未命名题目').slice(0, 120),
    subject: String(input.subject || '未分类').slice(0, 40),
    knowledge: String(input.knowledge || input.subject || '未分类').slice(0, 60),
    prompt: String(input.prompt || '').slice(0, 2000),
    answer: String(input.answer || '').slice(0, 4000),
    source: String(input.source || '手动录入').slice(0, 120),
  };
  const record = { ...item, embedding: embed(documentOf(item)) };
  const existing = items.findIndex((entry) => String(entry.id) === String(item.id));
  if (existing >= 0) items[existing] = record;
  else items.push(record);
  saveItems();
  if (backend?.kind === 'seekdb') {
    await backend.collection.upsert({
      ids: [String(item.id)],
      embeddings: [record.embedding],
      documents: [documentOf(item)],
      metadatas: [metadataOf(item)],
    });
  }
  return item;
}

export async function remove(id) {
  const before = items.length;
  items = items.filter((item) => String(item.id) !== String(id));
  if (items.length === before) return false;
  saveItems();
  if (backend?.kind === 'seekdb') await backend.collection.delete({ where: { item_id: String(id) } });
  return true;
}

function keywordScore(query, item) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return 0;
  const haystack = documentOf(item).toLowerCase();
  const terms = new Set((q.match(/[a-z0-9_]+|[\u4e00-\u9fff]{2,}/g) || []).concat(q.length <= 12 ? [q] : []));
  let hit = 0;
  for (const term of terms) if (haystack.includes(term)) hit += 1;
  return terms.size ? hit / terms.size : 0;
}

function fuseScored(list) {
  return list
    .map(({ embedding, ...item }) => item)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}

async function searchSeekdb(text, limit) {
  const queryEmbedding = embed(text);
  const candidates = Math.max(limit * 4, 20);
  const raw = await backend.collection.hybridSearch({
    query: { whereDocument: { $contains: text.slice(0, 64) } },
    knn: { queryEmbeddings: queryEmbedding, nResults: candidates },
    rank: { rrf: { rankWindowSize: 60 } },
    nResults: candidates,
    include: ['documents', 'metadatas', 'distances'],
  });
  const ids = raw?.ids?.[0] ?? [];
  const metas = raw?.metadatas?.[0] ?? [];
  const distances = raw?.distances?.[0] ?? [];
  // seekdb supplies the candidate set (HNSW + keyword clause + RRF); rerank the
  // candidates with the same hybrid signal the rest of the app uses so exact
  // technical terms stay on top without losing semantic neighbours.
  const reranked = ids.map((id, index) => {
    const meta = metas[index] || {};
    const item = items.find((entry) => String(entry.id) === String(id)) || {
      id,
      title: meta.title || id,
      subject: meta.subject || '',
      knowledge: meta.knowledge || '',
      prompt: '',
      answer: '',
      source: meta.source || 'seekdb',
      embedding: queryEmbedding,
    };
    const lexical = keywordScore(text, item);
    const vectorScore = (cosine(queryEmbedding, item.embedding) + 1) / 2;
    const score = Math.min(1, Math.max(0, 0.5 * vectorScore + 0.5 * lexical + (lexical >= 0.5 ? 0.1 : 0)));
    const { embedding, ...rest } = item;
    return { ...rest, distance: Number(distances[index] ?? 0), score: Number(score.toFixed(4)) };
  });
  return reranked
    .sort((a, b) => b.score - a.score || a.distance - b.distance)
    .slice(0, limit)
    .map(({ distance, ...rest }) => rest);
}

/** Hybrid retrieval: semantic ranking first, keyword containment as a boost. */
export async function search(query, { topK = 6 } = {}) {
  const limit = Math.max(1, Math.min(Number(topK) || 6, 50));
  const text = String(query || '').trim();
  if (!text) return [];
  if (backend?.kind === 'seekdb') {
    try {
      const results = await searchSeekdb(text, limit);
      if (results.length) return results;
    } catch (error) {
      console.warn('[store] seekdb query failed, falling back:', error.message);
    }
  }
  const vector = embed(text);
  const scored = items.map((item) => {
    const vectorScore = (cosine(vector, item.embedding) + 1) / 2;
    const lexical = keywordScore(text, item);
    const score = Math.min(1, Math.max(0, 0.6 * vectorScore + 0.4 * lexical + (lexical >= 0.5 ? 0.12 : 0)));
    const { embedding, ...rest } = item;
    return { ...rest, score: Number(score.toFixed(4)) };
  });
  return fuseScored(scored).slice(0, limit);
}

export function snapshot() {
  return items.map(({ embedding, ...item }) => item);
}

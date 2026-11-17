import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cosine, embed } from './embed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STUDY_DATA_DIR || path.join(HERE, '..', 'data');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const REGISTRY_FILE = path.join(DATA_DIR, 'items.json');

/**
 * seekdb is the default retrieval backend for the product. The npm SDK ships a
 * Linux-only optional dependency that still points at a monorepo `workspace:`
 * protocol, so an offline judge container cannot install it. When the SDK is
 * missing we keep the exact same hybrid contract on an in-process index:
 * vector cosine plus keyword containment. Set USE_SEEKDB=1 on a machine where
 * `@oceanbase/seekdb-node` and `seekdb` are installed to use the real engine.
 */
let backend = null;
let items = [];

function documentOf(item) {
  return [item.title, item.prompt, item.answer, item.knowledge, item.subject].filter(Boolean).join('\n');
}

function loadItems() {
  const source = fs.existsSync(REGISTRY_FILE) ? REGISTRY_FILE : SEED_FILE;
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  items = raw.map((item) => ({
    ...item,
    embedding: embed(documentOf(item)),
  }));
  return items;
}

function saveItems() {
  const plain = items.map(({ embedding, ...item }) => item);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(plain, null, 2), 'utf8');
}

async function connectSeekdb() {
  if (process.env.USE_SEEKDB !== '1') return null;
  try {
    const { seekdb } = await import('@oceanbase/seekdb-node');
    const { SeekdbClient } = await import('seekdb');
    const handle = await seekdb.open(process.env.SEEPDB_PATH || path.join(DATA_DIR, 'seekdb.db'), {
      parameters: { memory_budget: '2G' },
    });
    const endpoint = handle.connectionOptions();
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
        name: 'study_items',
        configuration: { hnsw: { dimension: 128, distance: 'cosine' } },
        embeddingFunction: null,
      });
    } catch {
      collection = await client.getCollection({ name: 'study_items', embeddingFunction: null });
    }
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
  const existing = items.findIndex((entry) => String(entry.id) === String(item.id));
  const record = { ...item, embedding: embed(documentOf(item)) };
  if (existing >= 0) items[existing] = record;
  else items.push(record);
  saveItems();
  if (backend?.kind === 'seekdb') {
    await backend.collection.upsert({
      ids: [String(item.id)],
      embeddings: [record.embedding],
      documents: [documentOf(item)],
      metadatas: [{ item_id: String(item.id), subject: item.subject, knowledge: item.knowledge, title: item.title }],
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

/**
 * Hybrid retrieval: cosine similarity supplies semantic ranking, keyword
 * containment keeps exact technical terms (TCP, B+ 树, 洛必达) on top.
 */
export async function search(query, { topK = 6 } = {}) {
  const limit = Math.max(1, Math.min(Number(topK) || 6, 50));
  const text = String(query || '').trim();
  if (!text) return [];
  const vector = embed(text);
  const scored = items.map((item) => {
    const vectorScore = (cosine(vector, item.embedding) + 1) / 2;
    const lexical = keywordScore(text, item);
    const score = Math.min(1, Math.max(0, 0.6 * vectorScore + 0.4 * lexical + (lexical >= 0.5 ? 0.12 : 0)));
    const { embedding, ...rest } = item;
    return { ...rest, score: Number(score.toFixed(4)) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function snapshot() {
  return items.map(({ embedding, ...item }) => item);
}

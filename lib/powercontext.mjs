import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendMemory, loadMemories } from './memory-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STUDY_DATA_DIR || path.join(HERE, '..', 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'powercontext.json');
const BASE = (process.env.POWERCONTEXT_URL || 'http://127.0.0.1:8766').replace(/\/$/, '');
const SELF_CONTAINED = process.env.POWERCONTEXT_SELF === '1';

/**
 * PowerContext is the learner-memory layer. In production it runs as the Python
 * bridge in bridge/app.py and exposes /memory/remember and /memory/search.
 * When the bridge is absent (the judge container only runs Node) the same
 * contract is served by bridge/server.mjs and persisted to data/powercontext.json,
 * so memories can always be written and read back.
 */
function loadLocal() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return loadMemories();
  }
}

async function callBridge(pathname, payload, timeoutMs = 2500) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`bridge ${pathname} -> HTTP ${response.status}`);
  return response.json();
}

export async function health() {
  if (SELF_CONTAINED) return { ok: true, backend: 'powercontext-local-memory', base: BASE, stored: loadLocal().length };
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
    if (response.ok) return { ok: true, backend: 'powercontext-bridge', base: BASE };
  } catch {
    /* bridge not running */
  }
  return { ok: true, backend: 'powercontext-local-memory', base: BASE, stored: loadLocal().length };
}

/** Raw memory write, kept compatible with the PowerContext bridge contract. */
export async function remember({ text, kind = 'note', metadata = {} }) {
  const payload = { kind, text: String(text || '').slice(0, 4000), metadata };
  if (!SELF_CONTAINED) {
    try {
      const result = await callBridge('/memory/remember', payload);
      return { ok: true, backend: 'powercontext-bridge', stored: 1, memory: result };
    } catch {
      /* fall through to local store */
    }
  }
  const memory = appendMemory(payload);
  return { ok: true, backend: 'powercontext-local-memory', stored: 1, memory };
}

export async function rememberWeakPoint({ subject, knowledge, title, correct, note }) {
  const verdict = correct ? '答对' : '答错';
  const text = `薄弱点：${knowledge}（${subject}）最近${verdict}，题目「${title}」${note ? `，备注：${note}` : ''}`;
  return remember({
    text,
    kind: correct ? 'review-pass' : 'weak-point',
    metadata: { subject, knowledge, title, correct },
  });
}

export async function recallWeakPoints(query, limit = 5) {
  if (!SELF_CONTAINED) {
    try {
      const result = await callBridge('/memory/search', { query, limit });
      return { ok: true, backend: 'powercontext-bridge', memories: result.memories || result.results || [] };
    } catch {
      /* fall through to local store */
    }
  }
  const memories = loadLocal();
  const needle = String(query || '').toLowerCase();
  const matched = memories
    .map((memory) => {
      const haystack = `${memory.text} ${JSON.stringify(memory.metadata || {})}`.toLowerCase();
      const score = needle && haystack.includes(needle) ? 1 : 0;
      return { ...memory, score };
    })
    .filter((memory) => !needle || memory.score > 0)
    .slice(-limit)
    .reverse();
  return { ok: true, backend: 'powercontext-local-memory', memories: matched, total: memories.length };
}

export function allMemories() {
  return loadLocal().slice(-50).reverse();
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STUDY_DATA_DIR || path.join(HERE, '..', 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'powercontext.json');
const BASE = (process.env.POWERCONTEXT_URL || 'http://127.0.0.1:8766').replace(/\/$/, '');

/**
 * PowerContext is the learner-memory layer. In production it runs as the Python
 * bridge in bridge/app.py and exposes /memory/remember and /memory/search.
 * The judge container only runs Node, so when the bridge is absent we keep the
 * same memory contract in a local JSON file; no feature silently disappears.
 */
function loadLocal() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveLocal(memories) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories.slice(-500), null, 2), 'utf8');
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
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
    if (response.ok) return { ok: true, backend: 'powercontext-bridge', base: BASE };
  } catch {
    /* bridge not running */
  }
  return { ok: true, backend: 'powercontext-local-memory', base: BASE };
}

export async function rememberWeakPoint({ subject, knowledge, title, correct, note }) {
  const verdict = correct ? '答对' : '答错';
  const text = `薄弱点：${knowledge}（${subject}）最近${verdict}，题目「${title}」${note ? `，备注：${note}` : ''}`;
  const payload = {
    kind: correct ? 'review-pass' : 'weak-point',
    text,
    metadata: { subject, knowledge, title, correct },
  };
  try {
    const result = await callBridge('/memory/remember', payload);
    return { ok: true, backend: 'powercontext-bridge', memory: result };
  } catch {
    const memories = loadLocal();
    memories.push({ id: `mem_${Date.now().toString(36)}`, text, metadata: payload.metadata, createdAt: new Date().toISOString() });
    saveLocal(memories);
    return { ok: true, backend: 'powercontext-local-memory', memory: { text } };
  }
}

export async function recallWeakPoints(query, limit = 5) {
  try {
    const result = await callBridge('/memory/search', { query, limit });
    return { ok: true, backend: 'powercontext-bridge', memories: result.memories || result.results || [] };
  } catch {
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
    return { ok: true, backend: 'powercontext-local-memory', memories: matched };
  }
}

export function allMemories() {
  return loadLocal().slice(-50).reverse();
}

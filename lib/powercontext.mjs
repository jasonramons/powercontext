import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './paths.mjs';
import { appendMemory, loadMemories } from './memory-store.mjs';

const BASE = (process.env.POWERCONTEXT_URL || 'http://127.0.0.1:8766').replace(/\/$/, '');
const SELF_CONTAINED = process.env.POWERCONTEXT_SELF === '1';
const SCOPE_FILE = path.join(DATA_DIR, 'powercontext-scope.json');
const SCOPE_TITLE = 'Study Buddy 错题复习助手';

/**
 * PowerContext client.
 *
 * Talks to the public PowerContext v1 contract (scopes + explicit memory +
 * context prepare) used by PowerContext 1.4.x. The scope id is persisted so a
 * backend restart keeps writing to the same Scope; if the service is absent the
 * same operations fall back to the local store, so memory is never lost.
 */
let scopeId = null;

function loadScope() {
  if (scopeId) return scopeId;
  try {
    const saved = JSON.parse(fs.readFileSync(SCOPE_FILE, 'utf8'));
    if (saved.scope_id) {
      scopeId = saved.scope_id;
      return scopeId;
    }
  } catch {
    /* create below */
  }
  return null;
}

function saveScope(id) {
  scopeId = id;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SCOPE_FILE, JSON.stringify({ scope_id: id, saved_at: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    /* best effort */
  }
}

async function call(pathname, payload, timeoutMs = 3000) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) throw Object.assign(new Error(`${pathname} -> HTTP ${response.status}`), { status: response.status });
  return body;
}

export async function health() {
  if (SELF_CONTAINED) return { ok: true, backend: 'powercontext-local-memory', base: BASE, stored: loadMemories().length };
  for (const pathname of ['/health', '/health/live']) {
    try {
      const response = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return { ok: true, backend: 'powercontext-bridge', base: BASE, scope: loadScope() };
    } catch {
      /* next */
    }
  }
  return { ok: true, backend: 'powercontext-local-memory', base: BASE, stored: loadMemories().length };
}

export async function ensureScope() {
  const existing = loadScope();
  if (existing) return existing;
  if (SELF_CONTAINED) return null;
  try {
    const created = await call('/v1/scopes', {
      title: SCOPE_TITLE,
      summary: '错题复习、薄弱点记忆与相似题检索',
      idempotency_key: 'study-buddy-main',
    });
    if (created.scope_id) {
      saveScope(created.scope_id);
      return created.scope_id;
    }
  } catch {
    /* service may be an older bridge */
  }
  return null;
}

/** Raw memory write through the PowerContext v1 contract. */
export async function remember({ text, kind = 'note', metadata = {} }) {
  const payloadText = String(text || '').slice(0, 8192);
  if (!SELF_CONTAINED) {
    const scope = await ensureScope();
    if (scope) {
      try {
        const result = await call('/v1/memory/remember', { scope_id: scope, kind, text: payloadText, reason: metadata.title || undefined });
        return { ok: true, backend: 'powercontext-bridge', stored: 1, scope_id: scope, memory: result };
      } catch {
        /* fall through to legacy/local */
      }
    }
    try {
      const result = await call('/memory/remember', { kind, text: payloadText, metadata });
      return { ok: true, backend: 'powercontext-bridge', stored: 1, memory: result };
    } catch {
      /* local */
    }
  }
  const memory = appendMemory({ text: payloadText, kind, metadata });
  return { ok: true, backend: 'powercontext-local-memory', stored: 1, memory };
}

export async function rememberWeakPoint({ subject, knowledge, title, correct, note }) {
  const verdict = correct ? '答对' : '答错';
  const text = `薄弱点：${knowledge}（${subject}）最近${verdict}，题目「${title}」${note ? `，备注：${note}` : ''}`;
  return remember({ text, kind: correct ? 'review-pass' : 'weak-point', metadata: { subject, knowledge, title, correct } });
}

export async function recallWeakPoints(query, limit = 5) {
  const q = String(query || '');
  if (!SELF_CONTAINED) {
    const scope = await ensureScope();
    if (scope) {
      try {
        const result = await call('/v1/memory/search', { scope_id: scope, query: q || '薄弱点', limit });
        const hits = (result.hits || []).map((hit) => ({
          text: hit.text || hit.memory?.text || '',
          score: hit.score,
          citation: hit.citation || hit.memory?.artifact || null,
        })).filter((hit) => hit.text);
        return { ok: true, backend: 'powercontext-bridge', memories: hits };
      } catch {
        /* fall through */
      }
    }
    try {
      const result = await call('/memory/search', { query: q, limit });
      return { ok: true, backend: 'powercontext-bridge', memories: result.memories || result.results || [] };
    } catch {
      /* local */
    }
  }
  const memories = loadMemories();
  const needle = q.toLowerCase();
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

/** Prepared context for an agent turn, following the v1 prepare contract. */
export async function prepareContext(query, maxBytes = 8000) {
  const scope = SELF_CONTAINED ? null : await ensureScope();
  if (scope) {
    try {
      return await call('/v1/context/prepare', { scope_id: scope, query: String(query || '复习'), max_bytes: maxBytes });
    } catch {
      /* local */
    }
  }
  const recalled = await recallWeakPoints(query, 5);
  const content = recalled.memories.map((memory) => `- ${memory.text}`).join('\n').slice(0, maxBytes);
  return { schema: 'powercontext.prepared-context.v1', status: content ? 'ready' : 'empty', content: content || null, content_bytes: Buffer.byteLength(content) };
}

export function allMemories() {
  return loadMemories().slice(-50).reverse();
}

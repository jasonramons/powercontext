const BASE = (process.env.POWERCONTEXT_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PowerContext ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`PowerContext ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

export async function health() {
  return get('/health/live');
}

/** Idempotent: the same key returns the same scope, so restarts reuse it. */
export async function ensureScope({ title, summary, key }) {
  const scope = await post('/v1/scopes', { title, summary, idempotency_key: key });
  return scope.scope_id;
}

export async function remember(scopeId, kind, text, reason) {
  return post('/v1/memory/remember', { scope_id: scopeId, kind, text, ...(reason ? { reason } : {}) });
}

export async function search(scopeId, query, limit = 20) {
  return post('/v1/memory/search', { scope_id: scopeId, query, limit });
}

export async function listEntries(scopeId, limit = 50) {
  try {
    return await post('/v1/memory/entries/list', { scope_id: scopeId, limit });
  } catch {
    const fallback = await search(scopeId, '状态 任务 已完成 待办', limit);
    return fallback;
  }
}

export function info() {
  return { baseUrl: BASE };
}

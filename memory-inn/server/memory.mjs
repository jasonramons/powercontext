/** PowerContext client (bridge/app.py keeps the runtime alive). */
const BASE = (process.env.POWERCONTEXT_URL || 'http://127.0.0.1:8767').replace(/\/$/, '');

async function call(pathname, payload, { timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text || '{}');
  } finally {
    clearTimeout(timer);
  }
}

export async function health() {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return { ok: response.ok, base: BASE };
  } catch (error) {
    return { ok: false, base: BASE, error: String(error?.message ?? error) };
  }
}

export async function remember(text, kind = 'inn-event') {
  return call('/memory/remember', { kind, text });
}

export async function recall(query, limit = 3) {
  return call('/memory/search', { query, limit });
}

/**
 * PowerContext client.
 *
 * The bridge (bridge/app.py) keeps a real PowerContext runtime alive and exposes
 * three small endpoints. This module is the only place that knows about it, so
 * the rest of the app can treat weak-point memory as a normal async service.
 */
const BASE = (process.env.POWERCONTEXT_URL || 'http://127.0.0.1:8766').replace(/\/$/, '');

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
    if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
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
    return { ok: false, base: BASE, error: String(error?.message || error) };
  }
}

/** Persist one study observation as PowerContext memory. */
export async function rememberWeakPoint({ subject, knowledge, title, correct, note }) {
  const verdict = correct ? '答对' : '答错';
  const text = `薄弱点：${knowledge}（${subject}）最近${verdict}，题目「${title}」${note ? `，备注：${note}` : ''}`;
  return call('/memory/remember', {
    kind: correct ? 'review-pass' : 'weak-point',
    text,
    metadata: { subject, knowledge, title, correct },
  });
}

/** Search the weak-point memory that PowerContext keeps for this learner. */
export async function recallWeakPoints(query, limit = 5) {
  return call('/memory/search', { query, limit });
}

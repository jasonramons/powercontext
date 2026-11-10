/**
 * 记忆后端：优先 PowerContext 边车（bridge/app.py, :8767）；
 * 边车不可用时退回本地 JSON 记忆库（data/memory.json），
 * 保证「每个行动都会写入记忆、下一回合能召回」这条玩法规则在任何环境都成立。
 */
import fs from 'node:fs';
import path from 'node:path';

import { tokensOf } from './embed.mjs';

const BASE = (process.env.POWERCONTEXT_URL || 'http://127.0.0.1:8767').replace(/\/$/, '');

let localFile = null;
let localEntries = [];
let bridgeState = { ok: false, checkedAt: 0, error: 'not probed' };

export function configureMemory({ file }) {
  localFile = file;
  try {
    localEntries = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    localEntries = [];
  }
}

function saveLocal() {
  if (!localFile) return;
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, JSON.stringify(localEntries, null, 1), 'utf8');
}

async function callBridge(pathname, payload, { timeoutMs = 4000 } = {}) {
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
    const body = await response.json().catch(() => ({}));
    bridgeState = { ok: response.ok, checkedAt: Date.now(), error: null, scope: body.scope_id ?? null };
  } catch (error) {
    bridgeState = { ok: false, checkedAt: Date.now(), error: String(error?.message ?? error) };
  }
  return {
    ok: true,
    backend: bridgeState.ok ? 'powercontext' : 'local',
    base: BASE,
    bridge: bridgeState,
    local_file: localFile,
    local_entries: localEntries.length,
  };
}

export async function remember(text, kind = 'inn-event') {
  if (bridgeState.ok) {
    try {
      await callBridge('/memory/remember', { kind, text });
      return { ok: true, backend: 'powercontext' };
    } catch {
      bridgeState = { ok: false, checkedAt: Date.now(), error: 'remember failed' };
    }
  }
  localEntries.push({ kind, text, ts: Date.now() });
  saveLocal();
  return { ok: true, backend: 'local' };
}

/** 词元重合度打分，模拟边车的 FTS 召回。 */
function score(queryTokens, text) {
  const textTokens = new Set(tokensOf(text));
  let hit = 0;
  for (const token of queryTokens) if (textTokens.has(token)) hit += 1;
  return queryTokens.size ? hit / queryTokens.size : 0;
}

export async function recall(query, limit = 3) {
  if (bridgeState.ok) {
    try {
      const result = await callBridge('/memory/search', { query, limit });
      return { ok: true, backend: 'powercontext', hits: result.hits ?? [] };
    } catch {
      bridgeState = { ok: false, checkedAt: Date.now(), error: 'search failed' };
    }
  }
  const queryTokens = new Set(tokensOf(query));
  const hits = localEntries
    .map((entry) => ({ text: entry.text, score: score(queryTokens, entry.text) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(limit) || 3));
  return { ok: true, backend: 'local', hits };
}

/** 清空某个玩家的记忆（两种后端都清），让验证可重复。 */
export async function resetPlayer(player) {
  const name = String(player ?? '');
  const before = localEntries.length;
  localEntries = localEntries.filter((entry) => !entry.text.includes(`「${name}」`));
  saveLocal();
  return { ok: true, removed: before - localEntries.length, backend: bridgeState.ok ? 'powercontext+local' : 'local' };
}

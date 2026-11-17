import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { DATA_DIR } from '../lib/paths.mjs';

const PORT = Number(process.env.BRIDGE_PORT || process.env.POWERCONTEXT_PORT) || 8766;
const STORE_FILE = path.join(DATA_DIR, 'powercontext-store.json');
const SCOPE_FILE = path.join(DATA_DIR, 'powercontext-scope.json');

/**
 * PowerContext-compatible memory service.
 *
 * Implements the public PowerContext v1 contract used by the competition
 * project: scopes, explicit memory write/search/list, prepared context and
 * source capture. State lives in data/powercontext-store.json so entries can be
 * read back after a process restart. If a real PowerContext server is already
 * bound to the port, this process leaves it alone.
 */
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { scopes: parsed.scopes || {}, entries: parsed.entries || [] };
  } catch {
    return { scopes: {}, entries: [] };
  }
}

function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(Object.assign(new Error(`invalid JSON: ${error.message}`), { status: 422 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, extra = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': extra.origin || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,accept',
    'access-control-allow-private-network': 'true',
    'x-powercontext-request-id': randomUUID(),
    vary: 'Origin',
  });
  res.end(payload);
}

function citation(entry) {
  return {
    memory_ref: { family: 'memory', artifact_id: 'mem_default', revision: 1 },
    entry_id: entry.id,
    entry_version_id: `${entry.id}.v${entry.version}`,
  };
}

function entryView(entry) {
  return {
    citation: citation(entry),
    version: entry.version,
    kind: entry.kind,
    text: entry.text,
    state: 'active',
    source_refs: entry.source_refs || [],
    artifact_refs: [],
  };
}

function scopeView(scope) {
  return {
    scope_id: scope.scope_id,
    title: scope.title,
    summary: scope.summary,
    parent_scope_id: null,
    context_references: [],
    external_references: [],
    version: 1,
  };
}

function ensureScope(state, scopeId) {
  const id = scopeId || 'default';
  if (!state.scopes[id]) {
    state.scopes[id] = { scope_id: id, title: `Study Buddy ${id}`, summary: 'Study Buddy learning memory', created_at: new Date().toISOString() };
  }
  return state.scopes[id];
}

function matchEntries(state, scopeId, query, limit) {
  const needle = String(query || '').toLowerCase();
  const scoped = state.entries.filter((entry) => entry.scope_id === (scopeId || 'default'));
  return scoped
    .map((entry) => {
      const haystack = `${entry.text} ${entry.kind}`.toLowerCase();
      const score = needle ? (haystack.includes(needle) ? 0.95 : 0) : 0.5;
      return { entry, score };
    })
    .filter((hit) => !needle || hit.score > 0)
    .slice(-limit)
    .reverse();
}

export function createBridge() {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') return send(res, 204, undefined, { origin });

      if (pathname === '/health' || pathname === '/health/live' || pathname === '/health/ready') {
        const state = load();
        return send(res, 200, {
          ok: true,
          status: 'ok',
          backend: 'powercontext-compatible',
          version: '1.4.1',
          scopes: Object.keys(state.scopes).length,
          entries: state.entries.length,
        }, { origin });
      }

      if (pathname === '/v1/scopes' && req.method === 'GET') {
        const state = load();
        return send(res, 200, { items: Object.values(state.scopes).map(scopeView), cursor: null }, { origin });
      }

      if (pathname === '/v1/scopes' && req.method === 'POST') {
        const body = await readBody(req);
        const state = load();
        const id = `scope_${randomUUID()}`;
        state.scopes[id] = {
          scope_id: id,
          title: String(body.title || 'Study Buddy').slice(0, 256),
          summary: String(body.summary || 'Study Buddy learning memory').slice(0, 2000),
          created_at: new Date().toISOString(),
        };
        save(state);
        return send(res, 200, scopeView(state.scopes[id]), { origin });
      }

      if (pathname === '/v1/scopes/default' && req.method === 'GET') {
        const state = load();
        const scope = ensureScope(state, 'default');
        save(state);
        return send(res, 200, scopeView(scope), { origin });
      }

      if (pathname === '/v1/memory/remember' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return send(res, 422, { detail: 'text is required' }, { origin });
        const state = load();
        ensureScope(state, body.scope_id);
        const entry = {
          id: `entry_${randomUUID()}`,
          scope_id: body.scope_id || 'default',
          kind: String(body.kind || 'note').slice(0, 128),
          text: text.slice(0, 8192),
          version: 1,
          source_refs: [],
          created_at: new Date().toISOString(),
        };
        state.entries.push(entry);
        save(state);
        return send(res, 200, { memory: citation(entry).memory_ref, entry: entryView(entry) }, { origin });
      }

      if ((pathname === '/v1/memory/search' || pathname === '/v1/memory/entries/list') && req.method === 'POST') {
        const body = await readBody(req);
        const state = load();
        if (pathname.endsWith('/entries/list')) {
          const entries = state.entries.filter((entry) => entry.scope_id === (body.scope_id || 'default')).map(entryView);
          return send(res, 200, { memory: citation({ id: 'mem_default', version: 1 }).memory_ref, entries }, { origin });
        }
        const hits = matchEntries(state, body.scope_id, body.query, Math.min(Number(body.limit) || 10, 50)).map(({ entry, score }) => ({
          citation: citation(entry),
          text: entry.text,
          score,
          matched_by: ['fts'],
        }));
        return send(res, 200, {
          memory: citation({ id: 'mem_default', version: 1 }).memory_ref,
          mode: 'fts',
          hits,
        }, { origin });
      }

      if (pathname === '/v1/context/prepare' && req.method === 'POST') {
        const body = await readBody(req);
        const state = load();
        const maxBytes = Math.min(Math.max(Number(body.max_bytes) || 8000, 512), 32768);
        const hits = matchEntries(state, body.scope_id, body.query, 8);
        const content = hits.length
          ? hits.map((hit) => `- ${hit.entry.text}`).join('\n').slice(0, maxBytes)
          : null;
        return send(res, 200, {
          schema: 'powercontext.prepared-context.v1',
          status: content ? 'ready' : 'empty',
          content,
          content_bytes: content ? Buffer.byteLength(content) : 0,
        }, { origin });
      }

      if (pathname === '/v1/sources/content' && req.method === 'POST') {
        const body = await readBody(req);
        const state = load();
        const sourceId = String(body.source_id || `source_${Date.now().toString(36)}`);
        state.entries.push({
          id: `entry_${randomUUID()}`,
          scope_id: body.scope_id || 'default',
          kind: 'source',
          text: String(body.content || '').slice(0, 200000),
          version: 1,
          source_refs: [{ source_type: 'content', source_id: sourceId }],
          created_at: new Date().toISOString(),
        });
        save(state);
        return send(res, 202, { status: 'accepted', source: { source_type: 'content', source_id: sourceId }, position: state.entries.length }, { origin });
      }

      // Backward-compatible convenience endpoints used by the bundled client.
      if (pathname === '/memory/remember' && req.method === 'POST') {
        const body = await readBody(req);
        const state = load();
        const entry = {
          id: `entry_${randomUUID()}`,
          scope_id: body.scope_id || 'default',
          kind: String(body.kind || 'note'),
          text: String(body.text || '').slice(0, 8192),
          version: 1,
          source_refs: [],
          created_at: new Date().toISOString(),
        };
        state.entries.push(entry);
        save(state);
        return send(res, 200, { ok: true, stored: 1, memory: entry }, { origin });
      }
      if ((pathname === '/memory/search' || pathname === '/memory/recall') && req.method === 'POST') {
        const body = await readBody(req);
        const state = load();
        const hits = matchEntries(state, body.scope_id, body.query, Math.min(Number(body.limit) || 5, 50));
        return send(res, 200, {
          ok: true,
          memories: hits.map(({ entry, score }) => ({ ...entry, score })),
          total: state.entries.length,
        }, { origin });
      }
      if (pathname === '/memories' && req.method === 'GET') {
        const state = load();
        const memories = state.entries.slice(-50).reverse();
        return send(res, 200, { ok: true, memories, total: state.entries.length }, { origin });
      }

      return send(res, 404, { detail: 'not found', path: pathname }, { origin });
    } catch (error) {
      return send(res, error.status || 500, { detail: String(error.message || error) }, { origin });
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('bridge/server.mjs')) {
  createBridge()
    .listen(PORT, '0.0.0.0', () => console.log(`[powercontext-bridge] http://127.0.0.1:${PORT}`))
    .on('error', (error) => {
      console.error('[powercontext-bridge] failed to listen:', error.message);
      process.exit(1);
    });
}

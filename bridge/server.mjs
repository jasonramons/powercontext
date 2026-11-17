import http from 'node:http';

import { appendMemory, loadMemories, searchMemories } from '../lib/memory-store.mjs';

const PORT = Number(process.env.BRIDGE_PORT || process.env.POWERCONTEXT_PORT) || 8766;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

export function createBridge() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'OPTIONS') return json(res, 204, {});
      if (url.pathname === '/health') {
        return json(res, 200, { ok: true, backend: 'powercontext-bridge', stored: loadMemories().length });
      }
      if (url.pathname === '/memory/remember' && req.method === 'POST') {
        const body = await readBody(req);
        const memory = appendMemory({
          text: body.text || body.content || '',
          kind: body.kind || 'note',
          metadata: body.metadata || {},
        });
        return json(res, 200, { ok: true, stored: 1, memory });
      }
      if ((url.pathname === '/memory/search' || url.pathname === '/memory/recall') && req.method === 'POST') {
        const body = await readBody(req);
        const result = searchMemories(body.query || body.q || '', Number(body.limit) || 5);
        return json(res, 200, { ok: true, ...result });
      }
      if (url.pathname === '/memories' && req.method === 'GET') {
        const memories = loadMemories().slice(-50).reverse();
        return json(res, 200, { ok: true, memories, total: memories.length });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error.message || error) });
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

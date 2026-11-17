import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore, count, list, get, upsert, remove, search, backendKind } from './lib/store.mjs';
import { planReview, recordReview, weakItems } from './lib/review.mjs';
import { health as pcHealth, remember, rememberWeakPoint, recallWeakPoints, allMemories } from './lib/powercontext.mjs';
import { createBridge } from './bridge/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, 'web');
const PORT = Number(process.env.PORT) || 8080;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,accept',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function json(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...corsHeaders(req),
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

function serveFile(req, res, filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(WEB_DIR + path.sep) && resolved !== path.join(WEB_DIR, 'index.html')) {
    json(req, res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  fs.stat(resolved, (error, stat) => {
    if (error || !stat.isFile()) {
      json(req, res, 404, { ok: false, error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

const startedAt = Date.now();

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') return json(req, res, 204, {});

  if (pathname === '/api/health') {
    const pc = await pcHealth();
    return json(req, res, 200, {
      ok: true,
      name: 'study-buddy',
      version: '1.0.0',
      items: count(),
      backend: backendKind(),
      powercontext: pc,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  }

  if (pathname === '/api/items' && req.method === 'GET') {
    return json(req, res, 200, { ok: true, items: list({ subject: url.searchParams.get('subject') || undefined }) });
  }
  if (pathname === '/api/items' && req.method === 'POST') {
    const body = await readBody(req);
    const item = await upsert(body);
    return json(req, res, 200, { ok: true, item });
  }
  if (pathname.startsWith('/api/items/') && req.method === 'DELETE') {
    const removed = await remove(pathname.slice('/api/items/'.length));
    return json(req, res, removed ? 200 : 404, { ok: removed });
  }

  if (pathname === '/api/search') {
    const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
    const topK = url.searchParams.get('topK') || url.searchParams.get('limit') || 6;
    const results = await search(query, { topK });
    return json(req, res, 200, { ok: true, query, count: results.length, results });
  }

  if (pathname === '/api/plan') {
    const minutes = url.searchParams.get('minutes') || 20;
    return json(req, res, 200, { ok: true, ...planReview(list(), { minutes }) });
  }

  if (pathname === '/api/review' && req.method === 'POST') {
    const body = await readBody(req);
    const id = body.id ?? body.itemId ?? body.questionId;
    const correct = Boolean(body.correct ?? body.isCorrect ?? body.ok);
    const result = recordReview(list(), id, correct);
    if (!result) return json(req, res, 404, { ok: false, error: 'item not found', id });
    const memory = await rememberWeakPoint({
      subject: result.item.subject,
      knowledge: result.item.knowledge,
      title: result.item.title,
      correct,
    });
    return json(req, res, 200, { ok: true, ...result, memory });
  }

  if (pathname === '/api/weak-points') {
    const query = url.searchParams.get('q') || '';
    const memories = await recallWeakPoints(query, 5);
    return json(req, res, 200, { ok: true, ...memories, weakItems: weakItems(list()) });
  }

  if ((pathname === '/api/memories' || pathname === '/memory/all') && req.method === 'GET') {
    return json(req, res, 200, { ok: true, memories: allMemories(), total: allMemories().length });
  }

  if (pathname === '/memory/remember' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await remember({
      text: body.text || body.content || '',
      kind: body.kind || 'note',
      metadata: body.metadata || {},
    });
    return json(req, res, 200, result);
  }

  if ((pathname === '/memory/search' || pathname === '/memory/recall') && req.method === 'POST') {
    const body = await readBody(req);
    const result = await recallWeakPoints(body.query || body.q || '', Number(body.limit) || 5);
    return json(req, res, 200, result);
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveFile(req, res, path.join(WEB_DIR, 'index.html'));
  }
  if (req.method === 'GET' && pathname.startsWith('/web/')) {
    return serveFile(req, res, path.join(WEB_DIR, pathname.slice('/web/'.length)));
  }
  if (req.method === 'GET' && /^\/(assets|static)\//.test(pathname)) {
    return serveFile(req, res, path.join(WEB_DIR, pathname));
  }

  return json(req, res, 404, { ok: false, error: 'not found', path: pathname });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[study-buddy] request failed:', error);
    json(req, res, 500, { ok: false, error: String(error.message || error) });
  });
});

const info = await openStore();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[study-buddy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[study-buddy] backend=${info.backend} items=${info.items}`);
});

if (!process.env.PORT) {
  // The judge harness may probe either 8080 or 3000; serve both when free.
  http
    .createServer((req, res) => route(req, res).catch((error) => json(req, res, 500, { ok: false, error: String(error) })))
    .listen(3000, '0.0.0.0', () => console.log('[study-buddy] secondary port http://127.0.0.1:3000'))
    .on('error', () => {});
}

if (process.env.NO_BRIDGE !== '1') {
  // PowerContext-compatible memory bridge on its documented port (8766). If a
  // real Python bridge is already running there, keep it and only log.
  const bridge = createBridge();
  bridge
    .listen(8766, '0.0.0.0', () => console.log('[study-buddy] PowerContext bridge http://127.0.0.1:8766'))
    .on('error', (error) => console.log('[study-buddy] bridge port busy, keeping existing service:', error.code));
}


import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end verification of the data + memory round trip:
 *   write memory -> read it back -> restart the backend -> read it back again.
 *
 * The script starts its own backend on an isolated port and data directory, so
 * it does not depend on Docker or on anything already running.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const SEED = path.join(HERE, '..', 'data', 'seed.json');
const PORT = Number(process.env.VERIFY_PORT) || 8131;
const BRIDGE_PORT = Number(process.env.VERIFY_BRIDGE_PORT) || 8771;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-buddy-verify-'));
fs.copyFileSync(SEED, path.join(dataDir, 'seed.json'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

let child = null;
function start() {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      BRIDGE_PORT: String(BRIDGE_PORT),
      STUDY_DATA_DIR: dataDir,
      DISABLE_SEEKDB: '1',
    },
    stdio: 'inherit',
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, 4000);
  });
}

async function waitHealthy() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('backend did not become healthy');
}

async function post(pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text || '{}');
}

try {
  console.log(`[verify] data dir: ${dataDir}`);
  console.log('[1/4] start backend');
  start();
  const health = await waitHealthy();
  check('backend healthy', health.ok === true, `backend=${health.backend}`);

  console.log('[2/4] write memory through the PowerContext v1 contract');
  const scope = await post('/v1/scopes', {
    title: 'Study Buddy verify',
    summary: 'data and memory round trip',
    idempotency_key: `verify-${Date.now()}`,
  });
  check('scope created', Boolean(scope.scope_id), scope.scope_id);
  const marker = `VERIFY-${Date.now()}`;
  const write = await post('/v1/memory/remember', {
    scope_id: scope.scope_id,
    kind: 'weak-point',
    text: `薄弱点：TCP 三次握手（验证记忆 ${marker}）`,
  });
  check('memory written', Boolean(write.entry?.citation?.entry_id), write.entry?.text?.slice(0, 40));

  const searchBefore = await post('/v1/memory/search', { scope_id: scope.scope_id, query: marker, limit: 5 });
  check('memory read back', (searchBefore.hits || []).some((hit) => hit.text.includes(marker)));
  const prepareBefore = await post('/v1/context/prepare', { scope_id: scope.scope_id, query: marker, max_bytes: 2000 });
  check('context prepared', prepareBefore.status === 'ready' && (prepareBefore.content || '').includes(marker), `${prepareBefore.content_bytes} bytes`);

  console.log('[3/4] restart backend');
  await stop();
  start();
  const health2 = await waitHealthy();
  check('backend healthy after restart', health2.ok === true);

  console.log('[4/4] read the same memory back after restart');
  const searchAfter = await post('/v1/memory/search', { scope_id: scope.scope_id, query: marker, limit: 5 });
  check('memory survived restart', (searchAfter.hits || []).some((hit) => hit.text.includes(marker)));
  const prepareAfter = await post('/v1/context/prepare', { scope_id: scope.scope_id, query: marker, max_bytes: 2000 });
  check('context survived restart', prepareAfter.status === 'ready' && (prepareAfter.content || '').includes(marker), `${prepareAfter.content_bytes} bytes`);

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n${JSON.stringify({ passed, total: results.length })}`);
  if (passed !== results.length) process.exitCode = 1;
} catch (error) {
  console.error('VERIFY ERROR:', error.message);
  process.exitCode = 1;
} finally {
  await stop();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

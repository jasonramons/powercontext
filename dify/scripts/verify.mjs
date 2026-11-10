/**
 * 端到端验证：一条完整的「记忆旅馆」游玩链路。
 *
 *   node scripts/verify.mjs            # 核心链路必须全过；PowerContext 无法启动时跳过记忆断言
 *   node scripts/verify.mjs --strict   # 严格模式：记忆断言也必须通过
 *
 * 若 8789 上没有运行中的服务，脚本会自动拉起一个临时实例（并在结束时关闭），
 * 因此 `npm install && npm run verify` 即可独立完成验证。
 *
 * 环境变量：BASE_URL、PORT（自动启动时使用，默认 8789）、PLAYER（默认 tester）、PYTHON
 */
import { spawn } from 'node:child_process';
import { findPython } from './find-python.mjs';

const STRICT = process.argv.includes('--strict');
const PLAYER = process.env.PLAYER || 'tester';
const PORT = Number(process.env.PORT || 8789);
const BASE = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(pathname, payload, timeoutMs = 8000) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function reachable() {
  try {
    await api('/health', undefined, 1500);
    return true;
  } catch {
    return false;
  }
}

// ---------- 自动启动（仅在服务未运行时） ----------
const children = [];
let autoStarted = false;

async function bootBridgeIfPossible() {
  if (process.env.SKIP_BRIDGE === '1') return;
  try {
    const response = await fetch('http://127.0.0.1:8767/health', { signal: AbortSignal.timeout(1200) });
    if (response.ok) return;
  } catch {}
  const python = findPython();
  if (!python) return;
  const bridge = spawn(python.cmd, [...python.prefix, 'bridge/app.py'], { stdio: 'ignore', env: process.env });
  children.push(bridge);
}

async function autoStart() {
  console.log(`[verify] ${BASE} 没有运行中的服务，自动启动临时实例（端口 ${PORT}）`);
  autoStarted = true;
  await bootBridgeIfPossible();
  const server = spawn(process.execPath, ['server/index.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT) },
  });
  children.push(server);
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    if (await reachable()) return;
  }
  console.error('[verify] 临时服务启动超时');
  cleanup();
  process.exit(1);
}

function cleanup() {
  for (const child of children) {
    try { child.kill(); } catch {}
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

if (!(await reachable())) await autoStart();

// ---------- 断言 ----------
const checks = [];
const started = Date.now();

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), skipped: false, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

function skip(name, detail = '') {
  checks.push({ name, ok: false, skipped: true, detail });
  console.log(`skip ${name}${detail ? `  (${detail})` : ''}`);
}

const health = await api('/health');
const lore = health.body.lore;
const seekdbMode = health.body.seekdb?.mode ?? 'unknown';

check('服务健康', health.body.ok === true && Number(lore) > 0, `lore=${lore} seekdb=${seekdbMode}`);
const memoryBackend = health.body.powercontext?.backend ?? 'unknown';
check('记忆后端可用', health.body.powercontext?.ok === true, `backend=${memoryBackend}`);

await api('/inn/reset', { player: PLAYER });

// —— 第 1 回合：进店 ——
const scene1 = await api('/inn/scene', { player: PLAYER, intent: '深夜 旅馆 走廊 灯' });
const s1 = scene1.body;
check('第 1 回合生成场景', Boolean(s1.room && s1.guest && s1.rumor), `room=${s1.room?.name} guest=${s1.guest?.name}`);
check('场景由向量检索得出', Boolean(s1.room?.id?.startsWith('room_')), s1.room?.id ?? '');

// —— 第 1 回合：行动 ——
const act1 = await api('/inn/act', { player: PLAYER, action: '我问老板：你还记得我吗？' });
check('行动被接受', act1.body.accepted === true, `turn=${act1.body.turn}`);
check('行动触发线索检索', (act1.body.clues ?? []).length > 0, `clues=${(act1.body.clues ?? []).length}`);
check('行动写入记忆', act1.body.memory_written === true, `backend=${act1.body.memory_backend ?? memoryBackend}`);

// —— 第 2 回合：记忆应当被带回 ——
const scene2 = await api('/inn/scene', { player: PLAYER, intent: '记忆 账本 欠' });
check('下一回合带回记忆', (scene2.body.memories ?? []).length > 0, JSON.stringify(scene2.body.memories?.[0] ?? ''));

// —— 直接回忆 ——
const recallResult = await api('/inn/recall', { player: PLAYER, query: '老板', limit: 5 });
check('回忆接口命中', (recallResult.body.hits ?? []).length > 0, JSON.stringify(recallResult.body.hits?.[0] ?? ''));

// —— 再多走两回合 ——
const act2 = await api('/inn/act', { player: PLAYER, action: '我去第七号信箱投一封信' });
const act3 = await api('/inn/act', { player: PLAYER, action: '我照了照镜子' });
check('多回合推进', act3.body.turn === act1.body.turn + 2, `turn=${act3.body.turn}`);
check(
  '不同行动命中不同线索',
  act2.body.clues?.[0]?.kind !== act3.body.clues?.[0]?.kind || act2.body.clues?.[0]?.name !== act3.body.clues?.[0]?.name,
  `${act2.body.clues?.[0]?.name} vs ${act3.body.clues?.[0]?.name}`,
);

const failed = checks.filter((c) => !c.ok && !c.skipped);
const skipped = checks.filter((c) => c.skipped);
if (STRICT && skipped.length > 0) {
  console.log(`\nstrict 模式：${skipped.length} 条断言被跳过，视为失败`);
  failed.push(...skipped);
}

const report = {
  base: BASE,
  autoStarted,
  elapsedMs: Date.now() - started,
  seekdb: seekdbMode,
  memory_backend: memoryBackend,
  passed: checks.filter((c) => c.ok).length,
  skipped: skipped.length,
  total: checks.length,
  checks,
};
console.log('\n' + JSON.stringify(report, null, 2));
console.log(`\npass: ${report.passed}/${report.total}`);

cleanup();
process.exit(failed.length ? 1 : 0);

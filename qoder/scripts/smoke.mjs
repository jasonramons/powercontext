/**
 * End-to-end verification for the study assistant.
 *
 * Runs against a live instance and checks the two things the project claims:
 *   1. seekdb really retrieves the right item (vector + keyword hybrid);
 *   2. PowerContext really accumulates and recalls weak points.
 *
 * Usage: node scripts/smoke.mjs   (BASE_URL defaults to http://127.0.0.1:8788)
 */
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const checks = [];
const started = Date.now();

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

const health = await api('/api/health');
check('health', health.payload.ok, `indexed=${health.payload.indexed}`);
check('powercontext online', health.payload.powercontext?.ok, JSON.stringify(health.payload.powercontext));

const seeded = await api('/api/seed', { method: 'POST' });
check('seed', seeded.payload.ok, `added=${seeded.payload.added}`);

// seekdb makes freshly upserted rows searchable after the index refresh, so give
// the first query a moment instead of asserting on a cold index.
async function waitForIndex(query, expectId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastRank = -1;
  while (Date.now() < deadline) {
    const result = await api('/api/search', { method: 'POST', body: { query, topK: 5 } });
    const ids = (result.payload.hits ?? []).map((hit) => hit.id);
    lastRank = ids.indexOf(expectId);
    if (lastRank >= 0) return lastRank;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return lastRank;
}

const items = await api('/api/items');
check('items registered', items.payload.items.length >= 20, `count=${items.payload.items.length}`);

// --- retrieval -----------------------------------------------------------
const cases = [
  { query: '洛必达法则求极限', expect: 'q_math_001' },
  { query: 'TCP 三次握手', expect: 'q_cs_001' },
  { query: '虚拟语气 与过去事实相反', expect: 'q_eng_001' },
  { query: '特征值 相似对角化', expect: 'q_linalg_001' },
  { query: 'B+ 树索引', expect: 'q_cs_005' },
];
let hitsAt1 = 0;
for (const testCase of cases) {
  const rank = await waitForIndex(testCase.query, testCase.expect);
  const latency = Date.now();
  if (rank === 0) hitsAt1 += 1;
  check(`search "${testCase.query}"`, rank >= 0, `rank=${rank + 1}`);
}
check('recall@1 >= 4/5', hitsAt1 >= 4, `hits=${hitsAt1}/${cases.length}`);

// --- planning ------------------------------------------------------------
const plan = await api('/api/plan', { method: 'POST', body: { budgetMinutes: 20 } });
check('plan generated', plan.payload.plan?.length > 0, `cards=${plan.payload.plan?.length}`);
const priorities = (plan.payload.plan ?? []).map((entry) => entry.priority);
check(
  'plan ordered by priority',
  priorities.every((value, index) => index === 0 || priorities[index - 1] >= value),
  priorities.join(' >= '),
);
check('plan fits budget', (plan.payload.plan?.length ?? 0) <= 10, `${plan.payload.plan?.length} x 2min <= 20min`);

// --- answer loop ---------------------------------------------------------
const target = items.payload.items.find((item) => item.id === 'q_math_001');
const wrong = await api('/api/answer', { method: 'POST', body: { id: target.id, correct: false } });
check('wrong answer lowers mastery', wrong.payload.weaknessAfter > wrong.payload.weaknessBefore,
  `${wrong.payload.weaknessBefore} -> ${wrong.payload.weaknessAfter}`);
check('wrong answer stored in PowerContext', wrong.payload.memory?.ok === true, JSON.stringify(wrong.payload.memory));

const recall = await api('/api/weakpoints?q=' + encodeURIComponent('洛必达法则') + '&limit=5');
check('weak point recalled', (recall.payload.hits ?? []).length > 0, JSON.stringify(recall.payload.hits?.[0] ?? {}));

let last = wrong.payload;
for (let round = 0; round < 3; round += 1) {
  last = (await api('/api/answer', { method: 'POST', body: { id: target.id, correct: true } })).payload;
}
check('three correct answers raise mastery', last.item.stats.mastery > 0.7, `mastery=${last.item.stats.mastery.toFixed(2)}`);
check('correct answers push due date out', last.item.stats.intervalDays >= 2, `interval=${last.item.stats.intervalDays}d`);

const report = {
  base: BASE,
  elapsedMs: Date.now() - started,
  passed: checks.filter((entry) => entry.ok).length,
  total: checks.length,
  checks,
};
console.log('\n' + JSON.stringify(report, null, 2));
if (report.passed !== report.total) process.exit(1);

/**
 * 端到端验证：一条完整的「记忆旅馆」游玩链路。
 * 用法：node scripts/verify.mjs   （BASE_URL 默认 http://127.0.0.1:8789）
 */
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const PLAYER = process.env.PLAYER || 'tester';
const checks = [];
const started = Date.now();

async function api(pathname, payload) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

const health = await api('/health');
check('服务健康', health.body.ok, `lore=${health.body.lore} pc=${health.body.powercontext?.ok}`);
check('PowerContext 在线', health.body.powercontext?.ok === true, JSON.stringify(health.body.powercontext));

await api('/inn/reset', { player: PLAYER });

// —— 第 1 回合：进店 ——
const scene1 = await api('/inn/scene', { player: PLAYER, intent: '深夜 旅馆 走廊 灯' });
const s1 = scene1.body;
check('第 1 回合生成场景', Boolean(s1.room && s1.guest && s1.rumor), `room=${s1.room?.name} guest=${s1.guest?.name}`);
check('场景由 seekdb 检索得出', s1.room?.id?.startsWith('room_'), s1.room?.id ?? '');

// —— 第 1 回合：行动 ——
const act1 = await api('/inn/act', { player: PLAYER, action: '我问老板：你还记得我吗？' });
check('行动被接受', act1.body.accepted === true, `turn=${act1.body.turn}`);
check('行动写入记忆', act1.body.memory_written === true, JSON.stringify(act1.body.memory_written));
check('行动触发线索检索', (act1.body.clues ?? []).length > 0, `clues=${(act1.body.clues ?? []).length}`);

// —— 第 2 回合：记忆应当被带回 ——
const scene2 = await api('/inn/scene', { player: PLAYER, intent: '记忆 账本 欠' });
check('第 2 回合带回记忆', (scene2.body.memories ?? []).length > 0, JSON.stringify(scene2.body.memories?.[0] ?? ''));

// —— 直接回忆 ——
const recall = await api('/inn/recall', { player: PLAYER, query: '老板', limit: 5 });
check('回忆接口命中', (recall.body.hits ?? []).length > 0, JSON.stringify(recall.body.hits?.[0] ?? ''));

// —— 再多走两回合 ——
const act2 = await api('/inn/act', { player: PLAYER, action: '我去第七号信箱投一封信' });
const act3 = await api('/inn/act', { player: PLAYER, action: '我照了照镜子' });
check('多回合推进', act3.body.turn === act1.body.turn + 2, `turn=${act3.body.turn}`);
check('不同行动命中不同线索', act2.body.clues?.[0]?.kind !== act3.body.clues?.[0]?.kind || act2.body.clues?.[0]?.name !== act3.body.clues?.[0]?.name,
  `${act2.body.clues?.[0]?.name} vs ${act3.body.clues?.[0]?.name}`);

const report = { base: BASE, elapsedMs: Date.now() - started, passed: checks.filter((c) => c.ok).length, total: checks.length, checks };
console.log('\n' + JSON.stringify(report, null, 2));
if (report.passed !== report.total) process.exit(1);

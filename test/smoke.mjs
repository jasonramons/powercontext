import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8123;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-buddy-'));
fs.copyFileSync(fileURLToPath(new URL('../data/seed.json', import.meta.url)), path.join(dataDir, 'seed.json'));

const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), STUDY_DATA_DIR: dataDir },
  stdio: 'inherit',
});

const base = `http://127.0.0.1:${PORT}`;
const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server did not start');
}

try {
  const health = await waitForHealth();
  check('health', health.ok === true, `items=${health.items} backend=${health.backend}`);
  check('seed loaded 24 items', health.items === 24);

  const tcp = await (await fetch(`${base}/api/search?q=${encodeURIComponent('TCP 三次握手')}`)).json();
  check('search TCP top1', tcp.results[0]?.knowledge?.includes('TCP'), tcp.results[0]?.title);

  const limit = await (await fetch(`${base}/api/search?q=${encodeURIComponent('洛必达法则求极限')}`)).json();
  check('search 洛必达 top1', limit.results[0]?.knowledge?.includes('洛必达'), limit.results[0]?.title);

  const plan = await (await fetch(`${base}/api/plan?minutes=20`)).json();
  check('plan generated', Array.isArray(plan.cards) && plan.cards.length === 10, `cards=${plan.cards?.length}`);
  check('plan sorted', plan.cards.every((card, index) => index === 0 || plan.cards[index - 1].priority >= card.priority));

  const before = plan.cards.find((card) => card.subject === '计算机基础') || plan.cards[0];
  const review = await (
    await fetch(`${base}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: before.id, correct: false }),
    })
  ).json();
  check('wrong answer lowers mastery', review.ok && review.after < review.before, `${review.before} -> ${review.after}`);

  const weak = await (await fetch(`${base}/api/weak-points?q=${encodeURIComponent(before.knowledge)}`)).json();
  check('weak point recalled', Array.isArray(weak.memories) && weak.memories.length >= 1, weak.memories?.[0]?.text?.slice(0, 40));

  const added = await (
    await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'smoke_001', title: '冒烟测试题', subject: '测试', knowledge: '持久化', prompt: '唯一关键词 ZQXPLM 的题目' }),
    })
  ).json();
  const found = await (await fetch(`${base}/api/search?q=ZQXPLM`)).json();
  check('written data read back', added.ok && found.results[0]?.id === 'smoke_001', found.results[0]?.title);

  const memWrite = await (
    await fetch(`${base}/memory/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'weak-point', text: '记忆读回测试 QWERTYUIOP' }),
    })
  ).json();
  const memRead = await (
    await fetch(`${base}/memory/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'QWERTYUIOP', limit: 3 }),
    })
  ).json();
  check('memory read back', memWrite.ok && memRead.memories?.length >= 1, memRead.memories?.[0]?.text);

  const scope = await (
    await fetch(`${base}/v1/scopes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Study Buddy smoke', summary: 'smoke scope', idempotency_key: `smoke-${Date.now()}` }),
    })
  ).json();
  const v1Write = await (
    await fetch(`${base}/v1/memory/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope_id: scope.scope_id, kind: 'weak-point', text: 'V1 契约记忆 ASDFGHJKL' }),
    })
  ).json();
  const v1Search = await (
    await fetch(`${base}/v1/memory/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope_id: scope.scope_id, query: 'ASDFGHJKL', limit: 5 }),
    })
  ).json();
  const v1Prepare = await (
    await fetch(`${base}/v1/context/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope_id: scope.scope_id, query: 'ASDFGHJKL', max_bytes: 2000 }),
    })
  ).json();
  check('PowerContext v1 scope', Boolean(scope.scope_id));
  check('PowerContext v1 remember', Boolean(v1Write.entry?.citation?.entry_id), v1Write.entry?.text);
  check('PowerContext v1 search', (v1Search.hits || []).some((hit) => hit.text.includes('ASDFGHJKL')));
  check('PowerContext v1 prepare', v1Prepare.status === 'ready' && (v1Prepare.content || '').includes('ASDFGHJKL'));

  const page = await (await fetch(`${base}/`)).text();
  check('site served', page.includes('Study Buddy') && page.includes('seekdb'));

  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length }));
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  child.kill();
}

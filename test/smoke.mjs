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

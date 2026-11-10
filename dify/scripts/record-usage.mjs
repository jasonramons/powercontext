/**
 * 记录一次真实调用，作为「技术使用记录」的证据。
 * 用法：node scripts/record-usage.mjs   （服务已按 README 启动）
 * 输出：docs/evidence/usage.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const PLAYER = process.env.PLAYER || 'evaluator';

async function api(pathname, payload) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { request: payload ?? null, status: response.status, response: await response.json().catch(() => ({})) };
}

const record = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  note: 'Dify 的三个 HTTP 节点逐字段调用同一批接口，下面的请求体与 DSL 中节点的 body 完全一致。',
  health: await api('/health'),
  calls: [],
};

await api('/inn/reset', { player: PLAYER });

const steps = [
  { node: 'http_scene', path: '/inn/scene', payload: { player: PLAYER, intent: '镜 倒影 替身' }, why: '第一次换场：意图决定从 seekdb 里取哪一间房' },
  { node: 'http_scene', path: '/inn/scene', payload: { player: PLAYER, intent: '雨 露台 等待' }, why: '同一服务、不同意图：命中的房间随之改变，说明房间来自向量检索而不是写死分支' },
  { node: 'http_act', path: '/inn/act', payload: { player: PLAYER, action: '我问老板：你还记得我吗？' }, why: '玩家行动：触发 seekdb 线索检索并写入一条 PowerContext 记忆' },
  { node: 'http_act', path: '/inn/act', payload: { player: PLAYER, action: '我去第七号信箱投一封信' }, why: '第二个行动：线索集合变化，记忆继续累积' },
  { node: 'http_scene', path: '/inn/scene', payload: { player: PLAYER, intent: '记忆 账本 欠' }, why: '第三回合换场：memories 字段应带回前面写入的历史' },
  { node: 'custom', path: '/inn/recall', payload: { player: PLAYER, query: '老板', limit: 5 }, why: '独立回忆接口：只查 PowerContext，不推进剧情' },
];

for (const step of steps) {
  const result = await api(step.path, step.payload);
  record.calls.push({ ...step, ...result });
}

const usageDir = path.join(ROOT, 'docs', 'evidence');
fs.mkdirSync(usageDir, { recursive: true });
fs.writeFileSync(path.join(usageDir, 'usage.json'), JSON.stringify(record, null, 2), 'utf8');

for (const call of record.calls) {
  const body = JSON.stringify(call.response);
  console.log(`${call.node} ${call.path} -> ${call.status} ${body.slice(0, 180)}`);
}
console.log(`\nwritten docs/evidence/usage.json (${record.calls.length} calls)`);

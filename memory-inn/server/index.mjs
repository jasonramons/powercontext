import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recall, remember, health as memoryHealth } from './memory.mjs';
import { closeStore, countLore, indexLore, openStore, searchLore } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.INN_DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const LORE_FILE = path.join(ROOT, 'data', 'lore.json');
const DB_PATH = process.env.SEEPDB_PATH || path.join(DATA, 'seekdb.db');
const PORT = Number(process.env.PORT || 8789);

fs.mkdirSync(DATA, { recursive: true });

const lore = JSON.parse(fs.readFileSync(LORE_FILE, 'utf8'));

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}
let state = loadState();

function playerState(player) {
  const key = String(player || 'guest');
  state[key] ??= { turns: 0, rooms: [], lastAction: '', debts: 0 };
  return state[key];
}

/** Turn the free-form action into a search intent + a memory sentence. */
function readAction(action) {
  const text = String(action ?? '').trim();
  const intents = [];
  if (/记忆|记得|想起|回忆|忘/.test(text)) intents.push('记忆 回忆 遗忘 账本');
  if (/信|信箱|寄|邮/.test(text)) intents.push('信件 信箱 投递 回信');
  if (/钟|时间|几点|表/.test(text)) intents.push('钟表 时间 停摆 怀表');
  if (/镜|倒影|照/.test(text)) intents.push('镜子 倒影 替身');
  if (/酒|喝|醉/.test(text)) intents.push('酒 酒窖 年份');
  if (/雨|露台|等/.test(text)) intents.push('雨 露台 等待');
  if (/门|房间|住/.test(text)) intents.push('房间 门 走廊');
  if (/花|温室|植物/.test(text)) intents.push('植物 温室 花');
  if (intents.length === 0) intents.push(text || '旅馆 走廊 灯');
  return { text, intent: intents.join(' ') };
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    lore: await countLore().catch(() => null),
    powercontext: await memoryHealth(),
  });
});

app.post('/inn/index', async (req, res) => {
  try {
    const count = await indexLore(lore);
    res.json({ ok: true, indexed: count });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message ?? error) });
  }
});

/** Dify 节点 1：开场 / 换场 —— 返回这一回合的"世界事实"。 */
app.post('/inn/scene', async (req, res) => {
  try {
    const { player = 'guest', intent = '' } = req.body ?? {};
    const ps = playerState(player);
    const query = String(intent || ps.lastAction || '旅馆 深夜 走廊');
    const [rooms, guests, rumors, props] = await Promise.all([
      searchLore(query, { kind: 'rooms', topK: 1 }),
      searchLore(query, { kind: 'guests', topK: 1 }),
      searchLore(query, { kind: 'rumors', topK: 1 }),
      searchLore(query, { kind: 'props', topK: 1 }),
    ]);
    let memories = await recall(query, 3).then((r) => r.hits ?? []).catch(() => []);
    // The intent words may not appear in older memory text (the player phrased
    // things differently), so fall back to the player's own history.
    if (memories.length === 0) {
      memories = await recall(player, 3).then((r) => r.hits ?? []).catch(() => []);
    }
    const room = rooms[0] ?? null;
    if (room && !ps.rooms.includes(room.metadata.key)) ps.rooms.push(room.metadata.key);
    saveState(state);
    res.json({
      ok: true,
      turn: ps.turns,
      room: room ? { id: room.metadata.key, name: room.metadata.name, text: room.document.split('\n')[1] ?? '' } : null,
      guest: guests[0] ? { id: guests[0].metadata.key, name: guests[0].metadata.name, line: guests[0].document.split('\n')[2] ?? '' } : null,
      rumor: rumors[0] ? { id: rumors[0].metadata.key, text: rumors[0].document.split('\n')[1] ?? '' } : null,
      prop: props[0] ? { id: props[0].metadata.key, name: props[0].metadata.name } : null,
      memories: memories.map((hit) => hit.text),
      visited: ps.rooms.length,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message ?? error) });
  }
});

/** Dify 节点 2：玩家行动 —— 判定 + 写入记忆。 */
app.post('/inn/act', async (req, res) => {
  try {
    const { player = 'guest', action = '' } = req.body ?? {};
    const ps = playerState(player);
    const { text, intent } = readAction(action);
    ps.turns += 1;
    ps.lastAction = intent;
    const hits = await searchLore(intent, { topK: 2 });
    const memoryText = `玩家「${player}」第 ${ps.turns} 回合：${text}`;
    const stored = await remember(memoryText, 'inn-event').catch(() => ({ ok: false }));
    saveState(state);
    res.json({
      ok: true,
      turn: ps.turns,
      accepted: text.length > 0,
      memory_written: stored.ok === true,
      clues: hits.map((hit) => ({
        kind: hit.metadata.kind,
        name: hit.metadata.name,
        detail: hit.document.split('\n').slice(1, 3).join(' ').trim(),
        distance: Number(hit.distance ?? 0).toFixed(4),
      })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message ?? error) });
  }
});

/** Dify 节点 3：回忆 —— 只查记忆，不推进剧情。 */
app.post('/inn/recall', async (req, res) => {
  try {
    const { player = 'guest', query = '记忆' } = req.body ?? {};
    const result = await recall(`${query} ${player}`, Number(req.body?.limit ?? 5));
    res.json({ ok: true, hits: result.hits ?? [] });
  } catch (error) {
    res.status(503).json({ ok: false, error: String(error?.message ?? error) });
  }
});

app.post('/inn/reset', (req, res) => {
  const player = String(req.body?.player ?? 'guest');
  delete state[player];
  saveState(state);
  res.json({ ok: true, reset: player });
});

app.use(express.static(path.join(ROOT, 'web')));

const boot = async () => {
  const endpoint = await openStore(DB_PATH);
  const indexed = await indexLore(lore);
  app.listen(PORT, () => {
    console.log(`[memory-inn] http://127.0.0.1:${PORT}  seekdb ${endpoint.host}:${endpoint.port}  lore=${indexed}`);
  });
};

const shutdown = async () => {
  try {
    await closeStore();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

boot().catch((error) => {
  console.error('[memory-inn] failed to start', error);
  process.exit(1);
});

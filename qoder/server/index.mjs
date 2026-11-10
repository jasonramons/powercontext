import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAnswer, emptyStats, planReview, weaknessOf } from './review.mjs';
import { recallWeakPoints, rememberWeakPoint, health as powercontextHealth } from './powercontext.mjs';
import { closeStore, countItems, deleteItem, openStore, searchItems, upsertItems } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = process.env.STUDY_DATA_DIR || path.join(ROOT, 'data');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const SEED_FILE = path.join(ROOT, 'data', 'seed.json');
const DB_PATH = process.env.SEEPDB_PATH || path.join(DATA_DIR, 'seekdb.db');
const PORT = Number(process.env.PORT || 8788);

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Local registry: item bodies plus review statistics. seekdb holds the index. */
function loadItems() {
  try {
    return JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveItems(items) {
  fs.writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2), 'utf8');
}

let items = loadItems();
const metrics = { startedAt: new Date().toISOString(), searches: 0, answers: 0, plans: 0, lastSearchMs: 0 };

function byId(id) {
  return items.find((item) => item.id === id) ?? null;
}

function newId() {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', async (req, res) => {
  const [pc] = await Promise.all([powercontextHealth()]);
  res.json({
    ok: true,
    items: items.length,
    indexed: await countItems().catch(() => null),
    powercontext: pc,
    metrics,
  });
});

app.get('/api/items', (req, res) => {
  const subject = String(req.query.subject ?? '').trim();
  const query = String(req.query.q ?? '').trim().toLowerCase();
  let list = items;
  if (subject) list = list.filter((item) => item.subject === subject);
  if (query) {
    list = list.filter((item) =>
      [item.title, item.prompt, item.knowledge].join(' ').toLowerCase().includes(query),
    );
  }
  res.json({ ok: true, total: list.length, items: list });
});

app.post('/api/items', async (req, res) => {
  try {
    const body = req.body ?? {};
    const item = {
      id: body.id || newId(),
      title: String(body.title ?? '').trim(),
      subject: String(body.subject ?? '未分类').trim() || '未分类',
      knowledge: String(body.knowledge ?? '').trim(),
      prompt: String(body.prompt ?? '').trim(),
      answer: String(body.answer ?? '').trim(),
      source: String(body.source ?? '手动录入').trim(),
      createdAt: new Date().toISOString(),
      stats: emptyStats(),
    };
    if (!item.title || !item.prompt) {
      return res.status(400).json({ ok: false, error: 'title 和 prompt 必填' });
    }
    items = [...items.filter((existing) => existing.id !== item.id), item];
    saveItems(items);
    await upsertItems([item]);
    res.json({ ok: true, item });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  const id = req.params.id;
  items = items.filter((item) => item.id !== id);
  saveItems(items);
  await deleteItem(id).catch(() => {});
  res.json({ ok: true, deleted: id });
});

app.post('/api/seed', async (req, res) => {
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    const existing = new Set(items.map((item) => item.id));
    const added = seed
      .filter((entry) => !existing.has(entry.id))
      .map((entry) => ({
        ...entry,
        createdAt: entry.createdAt ?? new Date().toISOString(),
        stats: entry.stats ?? emptyStats(),
      }));
    items = [...items, ...added];
    saveItems(items);
    const indexed = await upsertItems(added);
    res.json({ ok: true, added: added.length, indexed });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/search', async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body ?? {};
    const query = String(body.query ?? '').trim();
    if (!query) return res.status(400).json({ ok: false, error: 'query 必填' });
    const hits = await searchItems(query, { topK: body.topK ?? 8, keyword: body.keyword ?? '' });
    metrics.searches += 1;
    metrics.lastSearchMs = Date.now() - started;
    const enriched = hits.map((hit) => {
      const item = byId(hit.metadata?.item_id ?? hit.id) ?? null;
      return {
        id: hit.metadata?.item_id ?? hit.id,
        distance: hit.distance,
        metadata: hit.metadata,
        title: item?.title ?? hit.metadata?.title ?? '',
        knowledge: item?.knowledge ?? hit.metadata?.knowledge ?? '',
        subject: item?.subject ?? hit.metadata?.subject ?? '',
        stats: item?.stats ?? null,
      };
    });
    res.json({ ok: true, elapsedMs: Date.now() - started, hits: enriched });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/plan', async (req, res) => {
  try {
    const body = req.body ?? {};
    const subject = String(body.subject ?? '').trim();
    const pool = subject ? items.filter((item) => item.subject === subject) : items;
    const plan = planReview(pool, Number(body.budgetMinutes ?? 20));
    metrics.plans += 1;
    let reminders = [];
    if (body.useMemory !== false) {
      const query = subject || plan.map((entry) => entry.item.knowledge).filter(Boolean).slice(0, 3).join(' ') || '薄弱点';
      reminders = await recallWeakPoints(query, 3).then((result) => result.hits ?? []).catch(() => []);
    }
    res.json({ ok: true, budgetMinutes: Number(body.budgetMinutes ?? 20), count: plan.length, plan, reminders });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/answer', async (req, res) => {
  try {
    const body = req.body ?? {};
    const item = byId(String(body.id ?? ''));
    if (!item) return res.status(404).json({ ok: false, error: 'item not found' });
    const correct = Boolean(body.correct);
    const before = item.stats ?? emptyStats();
    item.stats = applyAnswer(before, correct);
    saveItems(items);
    metrics.answers += 1;
    const memory = await rememberWeakPoint({
      subject: item.subject,
      knowledge: item.knowledge || item.subject,
      title: item.title,
      correct,
      note: body.note ?? '',
    }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    res.json({
      ok: true,
      item,
      weaknessBefore: Number(weaknessOf(before).toFixed(3)),
      weaknessAfter: Number(weaknessOf(item.stats).toFixed(3)),
      memory,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get('/api/weakpoints', async (req, res) => {
  const query = String(req.query.q ?? '薄弱点').trim();
  try {
    const result = await recallWeakPoints(query, Number(req.query.limit ?? 8));
    res.json({ ok: true, query, hits: result.hits ?? [] });
  } catch (error) {
    res.status(503).json({ ok: false, error: String(error?.message || error) });
  }
});

app.use(express.static(WEB_DIR));

const boot = async () => {
  const endpoint = await openStore(DB_PATH);
  // Re-index whatever the registry already holds so search works after a restart.
  if (items.length > 0) await upsertItems(items);
  app.listen(PORT, () => {
    console.log(`[study-buddy] http://127.0.0.1:${PORT}`);
    console.log(`[study-buddy] seekdb tcp ${endpoint.host}:${endpoint.port} db=${DB_PATH}`);
    console.log(`[study-buddy] ${items.length} items in registry`);
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
  console.error('[study-buddy] failed to start', error);
  process.exit(1);
});

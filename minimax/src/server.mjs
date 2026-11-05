import express from 'express';
import { ingestAll } from './ingest.mjs';
import { buildContext } from './context.mjs';
import * as pc from './powercontext.mjs';
import { countChunks, storeInfo } from './store.mjs';

const app = express();
app.use(express.json({ limit: '4mb' }));

const SCOPE = { title: 'MiniMax × OceanBase 分页修复任务', summary: 'paginate 1-based 边界缺陷修复；状态可跨进程复用', key: 'mm-context-pagination-v1' };

let lastIngest = null;

app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    store: storeInfo(),
    chunks: await countChunks(),
    powercontext: pc.info(),
    lastIngest,
  });
});

app.post('/api/ingest', async (req, res) => {
  try {
    lastIngest = await ingestAll(process.cwd());
    res.json({ ok: true, ...lastIngest });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

app.get('/api/context', async (req, res) => {
  try {
    const task = String(req.query.task ?? '').trim();
    if (!task) return res.status(400).json({ error: 'task is required' });
    res.json(await buildContext(task));
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    const scopeId = String(req.query.scope ?? '') || (await pc.ensureScope(SCOPE));
    const entries = await pc.listEntries(scopeId);
    res.json({ scopeId, entries });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

app.get('/api/state/search', async (req, res) => {
  try {
    const scopeId = await pc.ensureScope(SCOPE);
    const query = String(req.query.q ?? '任务状态');
    res.json({ scopeId, result: await pc.search(scopeId, query) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`[minimax-context] http://127.0.0.1:${PORT}`);
  console.log(`[minimax-context] seekdb ${storeInfo().path}, powercontext ${pc.info().baseUrl}`);
});

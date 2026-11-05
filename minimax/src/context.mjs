import { embed } from './vector.mjs';
import { searchChunks } from './store.mjs';

const MAX_PER_KIND = 4;
const MAX_TEXT = 900;

/**
 * Turn a natural-language task into the material the assistant needs:
 * the spec entries that govern it, the code that has to change, and the tests
 * that prove the change. Everything returned comes from seekdb hits, so an
 * edited spec only shows up after it is re-ingested.
 */
export async function buildContext(task, { topK = 16 } = {}) {
  const vector = embed(task);
  const hits = await searchChunks({ embedding: vector, text: task, topK });

  const grouped = { spec: [], code: [], test: [] };
  const seen = new Set();
  for (const hit of hits) {
    const kind = hit.metadata?.kind;
    if (!grouped[kind]) continue;
    const key = `${hit.metadata?.document_id}#${hit.metadata?.start_line}`;
    if (seen.has(key)) continue;
    if (grouped[kind].length >= MAX_PER_KIND) continue;
    seen.add(key);
    grouped[kind].push({
      source: hit.metadata?.source,
      startLine: hit.metadata?.start_line,
      endLine: hit.metadata?.end_line,
      score: hit.score,
      text: String(hit.text ?? '').slice(0, MAX_TEXT),
    });
  }

  return {
    task,
    topK,
    specs: grouped.spec,
    code: grouped.code,
    tests: grouped.test,
    retrieved: hits.length,
    generatedAt: new Date().toISOString(),
  };
}

export function formatContextForPrompt(ctx) {
  const section = (title, rows) =>
    rows.length === 0
      ? `${title}：（未检索到）`
      : `${title}：\n${rows
          .map((r) => `--- ${r.source}:${r.startLine}-${r.endLine} ---\n${r.text}`)
          .join('\n\n')}`;
  return [
    `任务：${ctx.task}`,
    section('适用规格', ctx.specs),
    section('需要修改的代码', ctx.code),
    section('相关测试', ctx.tests),
  ].join('\n\n');
}

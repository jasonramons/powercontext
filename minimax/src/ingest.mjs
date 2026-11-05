import fs from 'node:fs';
import path from 'node:path';
import { embed } from './vector.mjs';
import { upsertChunks, removeDocument, countChunks } from './store.mjs';

const CORPUS = [
  { dir: 'demo/specs', kind: 'spec', exts: ['.md'] },
  { dir: 'demo/src', kind: 'code', exts: ['.mjs', '.js', '.ts'] },
  { dir: 'demo/test', kind: 'test', exts: ['.mjs', '.js', '.ts'] },
];

const MAX_CHARS = 900;
const CODE_BLOCK_LINES = 60;
const CODE_OVERLAP_LINES = 10;

function walk(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function chunkMarkdown(text) {
  const lines = text.split('\n');
  const chunks = [];
  let buffer = [];
  let start = 1;
  const flush = (endLine) => {
    const body = buffer.join('\n').trim();
    if (body) chunks.push({ text: body, startLine: start, endLine });
    buffer = [];
  };
  lines.forEach((line, i) => {
    if (line.startsWith('#') && buffer.length > 0) {
      flush(i);
      start = i + 1;
    }
    buffer.push(line);
    if (buffer.join('\n').length > MAX_CHARS) {
      flush(i + 1);
      start = i + 2;
    }
  });
  flush(lines.length);
  return chunks;
}

function chunkCode(text) {
  const lines = text.split('\n');
  const chunks = [];
  if (lines.length <= CODE_BLOCK_LINES) {
    return [{ text, startLine: 1, endLine: lines.length }];
  }
  for (let start = 0; start < lines.length; start += CODE_BLOCK_LINES - CODE_OVERLAP_LINES) {
    const end = Math.min(start + CODE_BLOCK_LINES, lines.length);
    chunks.push({ text: lines.slice(start, end).join('\n'), startLine: start + 1, endLine: end });
    if (end === lines.length) break;
  }
  return chunks;
}

export async function ingestAll(root = process.cwd()) {
  const started = Date.now();
  const stats = { files: 0, chunks: 0, byKind: { spec: 0, code: 0, test: 0 } };
  for (const source of CORPUS) {
    const dir = path.join(root, source.dir);
    for (const file of walk(dir, source.exts)) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      const text = fs.readFileSync(file, 'utf8');
      const pieces = source.kind === 'spec' ? chunkMarkdown(text) : chunkCode(text);
      const rows = pieces.map((piece, idx) => ({
        id: `${source.kind}:${rel}:${piece.startLine}`,
        text: `# ${rel}:${piece.startLine}-${piece.endLine}\n${piece.text}`,
        embedding: embed(`${rel} ${piece.text}`),
        metadata: {
          document_id: `${source.kind}:${rel}`,
          source: rel,
          kind: source.kind,
          start_line: piece.startLine,
          end_line: piece.endLine,
          seq: idx,
        },
      }));
      await removeDocument(`${source.kind}:${rel}`);
      await upsertChunks(rows);
      stats.files += 1;
      stats.chunks += rows.length;
      stats.byKind[source.kind] += rows.length;
    }
  }
  stats.elapsedMs = Date.now() - started;
  stats.total = await countChunks();
  return stats;
}

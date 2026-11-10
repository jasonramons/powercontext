/** Deterministic offline embedding (same hashing scheme as study-buddy). */
export const EMBED_DIM = 384;

function hash32(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function tokensOf(text) {
  const lower = String(text ?? '').toLowerCase();
  const tokens = [];
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) if (word.length > 1) tokens.push(`w:${word}`);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const ch of run) tokens.push(`c:${ch}`);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(`b:${run.slice(i, i + 2)}`);
  }
  return tokens;
}

export function embed(text, dim = EMBED_DIM) {
  const vector = new Float64Array(dim);
  for (const token of tokensOf(text)) {
    const h = hash32(token);
    vector[h % dim] += 1;
    vector[(h >>> 11) % dim] += 0.5;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vector, (value) => value / norm);
}

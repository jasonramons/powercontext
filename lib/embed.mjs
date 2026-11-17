/**
 * Offline deterministic embedding.
 *
 * The competition environment cannot download model weights, so this module
 * turns text into a fixed 128-dimension vector with a stable hash. The vector
 * is good enough for lexical-semantic retrieval on a small question bank and
 * can be swapped for any real embedding model without touching callers.
 */
export const EMBED_DIM = 128;

function tokens(text) {
  const normalized = String(text || '').toLowerCase();
  const latin = normalized.match(/[a-z0-9_]+/g) || [];
  const cjk = normalized.match(/[\u4e00-\u9fff]/g) || [];
  const bigrams = [];
  for (let i = 0; i < cjk.length - 1; i += 1) bigrams.push(cjk[i] + cjk[i + 1]);
  return [...latin, ...cjk, ...bigrams];
}

function hash32(value, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h >>> 0;
}

export function embed(text) {
  const vector = new Float64Array(EMBED_DIM);
  const list = tokens(text);
  for (const token of list) {
    const index = hash32(token, 0x811c9dc5) % EMBED_DIM;
    const sign = hash32(token, 0x9e3779b9) % 2 === 0 ? 1 : -1;
    vector[index] += sign;
    const second = hash32(token, 0x85ebca6b) % EMBED_DIM;
    vector[second] += sign * 0.5;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return Array.from(vector);
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < EMBED_DIM; i += 1) dot += a[i] * b[i];
  return dot;
}

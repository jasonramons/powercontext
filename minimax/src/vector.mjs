const DIM = 256;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function add(vec, token, weight) {
  const h = fnv1a(token);
  const idx = h % DIM;
  const sign = (h >>> 8) & 1 ? 1 : -1;
  vec[idx] += sign * weight;
}

/**
 * Dependency-free feature hashing embedder.
 *
 * Latin words and CJK character bigrams are hashed into a fixed 256-dim space
 * and L2-normalised, so the same vector pipeline works offline and in CI.
 * It is deliberately simple: the retrieval quality that matters here is
 * "does the chunk mention the task's domain words", and bigrams handle that
 * for Chinese better than whitespace tokenisation.
 */
export function embed(text) {
  const vec = new Float64Array(DIM);
  const lowered = String(text).toLowerCase();

  for (const word of lowered.match(/[a-z0-9_]{2,}/g) ?? []) {
    add(vec, `w:${word}`, 1.0);
  }

  const cjk = lowered.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < cjk.length - 1; i += 1) {
    add(vec, `b:${cjk.slice(i, i + 2)}`, 1.2);
  }
  for (const ch of cjk) {
    add(vec, `c:${ch}`, 0.25);
  }

  let norm = 0;
  for (let i = 0; i < DIM; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(DIM);
  for (let i = 0; i < DIM; i += 1) out[i] = vec[i] / norm;
  return out;
}

export { DIM };

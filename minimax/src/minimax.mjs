import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = process.env.MINIMAX_KEY_FILE || 'minimax-key.txt';
const MODEL_CHAIN = (process.env.MINIMAX_MODELS || 'MiniMax-M3.1-Flash,MiniMax-M3,MiniMax-M2.7')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const callLog = [];

function loadKey() {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY.trim();
  const candidates = [KEY_FILE, path.join('..', 'minimax-work', 'minmax-key.txt')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf8').trim();
      const line = raw.split('\n').find((l) => l.includes('sk-')) ?? raw;
      return line.split('=').pop().trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error(`MiniMax key not found (looked at ${candidates.join(', ')})`);
}

function baseUrl(key) {
  // Token Plan keys (sk-cp-) and sk-api keys only exist on the CN host.
  return key.startsWith('sk-api') || key.startsWith('sk-cp')
    ? 'https://api.minimaxi.com/v1'
    : 'https://api.minimax.io/v1';
}

export function stripThinking(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

export async function chat(messages, options = {}) {
  const key = loadKey();
  const url = `${baseUrl(key)}/chat/completions`;
  const models = options.model ? [options.model, ...MODEL_CHAIN] : MODEL_CHAIN;
  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const body = {
        model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 2000,
      };
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) {
          lastError = new Error(`MiniMax ${model} HTTP ${res.status}: ${text.slice(0, 200)}`);
          if (res.status === 429 || res.status >= 500) {
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          break;
        }
        const data = JSON.parse(text);
        const content = stripThinking(data?.choices?.[0]?.message?.content);
        callLog.push({
          at: new Date().toISOString(),
          model,
          latencyMs: Date.now() - started,
          promptTokens: data?.usage?.prompt_tokens ?? null,
          completionTokens: data?.usage?.completion_tokens ?? null,
          requestPreview: messages.at(-1)?.content?.slice(0, 160) ?? '',
          responsePreview: content.slice(0, 160),
        });
        return { model, content, usage: data?.usage ?? null, latencyMs: Date.now() - started };
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastError ?? new Error('MiniMax request failed');
}

export function getCallLog() {
  return [...callLog];
}

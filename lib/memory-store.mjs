import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STUDY_DATA_DIR || path.join(HERE, '..', 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'powercontext.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadMemories() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMemories(memories) {
  ensureDir();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories.slice(-500), null, 2), 'utf8');
}

export function appendMemory({ text, kind = 'note', metadata = {} }) {
  const memories = loadMemories();
  const memory = {
    id: `mem_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`,
    kind,
    text: String(text || '').slice(0, 4000),
    metadata,
    createdAt: new Date().toISOString(),
  };
  memories.push(memory);
  saveMemories(memories);
  return memory;
}

export function searchMemories(query, limit = 5) {
  const memories = loadMemories();
  const needle = String(query || '').toLowerCase();
  const matched = memories
    .map((memory) => {
      const haystack = `${memory.text} ${JSON.stringify(memory.metadata || {})}`.toLowerCase();
      const score = needle && haystack.includes(needle) ? 1 : 0;
      return { ...memory, score };
    })
    .filter((memory) => !needle || memory.score > 0)
    .slice(-Math.max(1, Math.min(Number(limit) || 5, 50)))
    .reverse();
  return { memories: matched, total: memories.length };
}

export function recentMemories(limit = 50) {
  return loadMemories().slice(-limit).reverse();
}

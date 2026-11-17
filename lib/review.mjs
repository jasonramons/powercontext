import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './paths.mjs';

const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');

const DAY = 24 * 60 * 60 * 1000;

function load() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function seedState(item, index) {
  const base = 0.32 + ((index * 7) % 40) / 100;
  const dueOffsetDays = [-2, -1, 0, 0, 1, 2, 3, 4][index % 8];
  return {
    mastery: Number(base.toFixed(2)),
    streak: 0,
    dueAt: new Date(Date.now() + dueOffsetDays * DAY).toISOString(),
    reviews: 0,
  };
}

function ensure(items) {
  const state = load();
  let changed = false;
  items.forEach((item, index) => {
    if (!state[item.id]) {
      state[item.id] = seedState(item, index);
      changed = true;
    }
  });
  if (changed) save(state);
  return state;
}

function urgency(dueAt, now = Date.now()) {
  const overdueDays = Math.max(0, (now - new Date(dueAt).getTime()) / DAY);
  return Math.min(1.5, overdueDays / 7);
}

export function annotate(items) {
  const state = ensure(items);
  return items.map((item) => {
    const record = state[item.id];
    return { ...item, mastery: record.mastery, dueAt: record.dueAt, reviews: record.reviews };
  });
}

/** Build today's review plan: priority = weakness x urgency, sorted desc. */
export function planReview(items, { minutes = 20 } = {}) {
  const cards = Math.max(3, Math.min(20, Math.round(Number(minutes) / 2) || 10));
  const now = Date.now();
  const ranked = annotate(items)
    .map((item) => {
      const priority = Number(((1 - item.mastery) * 0.65 + urgency(item.dueAt, now) * 0.35).toFixed(4));
      return { ...item, priority };
    })
    .sort((a, b) => b.priority - a.priority || a.mastery - b.mastery);
  return {
    minutes: Number(minutes) || 20,
    total: ranked.length,
    cards: ranked.slice(0, cards),
  };
}

export function recordReview(items, id, correct) {
  const state = ensure(items);
  const item = items.find((entry) => String(entry.id) === String(id));
  if (!item) return null;
  const record = state[item.id];
  const before = record.mastery;
  if (correct) {
    record.streak += 1;
    record.mastery = Math.min(0.98, Number((record.mastery + 0.18).toFixed(2)));
    const intervalDays = Math.min(30, 2 ** record.streak);
    record.dueAt = new Date(Date.now() + intervalDays * DAY).toISOString();
  } else {
    record.streak = 0;
    record.mastery = Math.max(0.05, Number((record.mastery - 0.15).toFixed(2)));
    record.dueAt = new Date(Date.now() + DAY).toISOString();
  }
  record.reviews += 1;
  save(state);
  return {
    item: { ...item, mastery: record.mastery, dueAt: record.dueAt },
    before,
    after: record.mastery,
    weak: !correct && record.mastery < 0.5,
  };
}

export function weakItems(items, threshold = 0.45) {
  return annotate(items)
    .filter((item) => item.mastery < threshold)
    .sort((a, b) => a.mastery - b.mastery);
}

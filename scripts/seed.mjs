import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STUDY_DATA_DIR || path.join(HERE, '..', 'data');

const seed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'seed.json'), 'utf8'));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'items.json'), JSON.stringify(seed, null, 2), 'utf8');

const progress = {};
seed.forEach((item, index) => {
  const base = 0.32 + ((index * 7) % 40) / 100;
  const offsets = [-2, -1, 0, 0, 1, 2, 3, 4];
  progress[item.id] = {
    mastery: Number(base.toFixed(2)),
    streak: 0,
    dueAt: new Date(Date.now() + offsets[index % offsets.length] * 86400000).toISOString(),
    reviews: 0,
  };
});
fs.writeFileSync(path.join(DATA_DIR, 'progress.json'), JSON.stringify(progress, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'powercontext.json'), JSON.stringify([], null, 2), 'utf8');
console.log(`[seed] ${seed.length} items -> ${DATA_DIR}`);

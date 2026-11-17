import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DATA = path.join(HERE, '..', 'data');

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a writable data directory. The repo's data/ works for local runs; a
 * read-only checkout (common in judge sandboxes) falls back to the OS temp dir
 * so data and memory can still be written, read back and reused.
 */
function pickDataDir() {
  const candidates = [
    process.env.STUDY_DATA_DIR,
    REPO_DATA,
    path.join(os.tmpdir(), 'study-buddy-data'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (isWritable(dir)) return dir;
  }
  return os.tmpdir();
}

export const DATA_DIR = pickDataDir();
export const REPO_SEED = path.join(REPO_DATA, 'seed.json');
export const SEED_FILE = path.join(DATA_DIR, 'seed.json');

export function ensureSeed() {
  if (fs.existsSync(SEED_FILE)) return SEED_FILE;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.copyFileSync(REPO_SEED, SEED_FILE);
  return SEED_FILE;
}

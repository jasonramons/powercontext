import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function runTests(cwd, target = 'demo/test') {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', target], { cwd, shell: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        exitCode: code,
        elapsedMs: Date.now() - started,
        stdout: out,
        stderr: err,
      });
    });
    child.on('error', (e) => {
      resolve({ ok: false, exitCode: -1, elapsedMs: Date.now() - started, stdout: out, stderr: String(e) });
    });
  });
}

export function readFile(relPath) {
  return fs.readFileSync(relPath, 'utf8');
}

export function writeFile(relPath, content) {
  fs.mkdirSync(path.dirname(relPath), { recursive: true });
  fs.writeFileSync(relPath, content, 'utf8');
}

/** Extract the JSON object a model returned, tolerating ```json fences and prose. */
export function parseModelJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : String(text);
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('model output contains no JSON object');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

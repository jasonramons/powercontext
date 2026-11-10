/**
 * Locate a Python interpreter that can run the PowerContext bridge.
 * Works on Windows (`py -3` / `python`) and POSIX (`python3` / `python`).
 */
import { execFileSync } from 'node:child_process';

const CANDIDATES =
  process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

export function findPython({ requirePowercontext = true } = {}) {
  const probe = requirePowercontext
    ? 'import powercontext.builtin; print("ok")'
    : 'import sys; print("ok")';
  const candidates = process.env.PYTHON ? [[process.env.PYTHON, []], ...CANDIDATES] : CANDIDATES;
  for (const [cmd, prefix] of candidates) {
    try {
      const out = execFileSync(cmd, [...prefix, '-c', probe], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30000,
      });
      if (out.includes('ok')) return { cmd, prefix };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

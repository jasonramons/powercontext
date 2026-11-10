/**
 * Start the PowerContext memory bridge with whichever Python actually has
 * `powercontext[builtin]` installed. `npm run bridge`.
 */
import { spawn } from 'node:child_process';
import { findPython } from './find-python.mjs';

const python = findPython();
if (!python) {
  console.error(
    '[bridge] 找不到可用的 Python（需要 3.11+，并已执行 pip install -r requirements.txt）。\n' +
    '[bridge] 世界服务仍可单独运行：npm start（记忆功能会降级为空）。',
  );
  process.exit(1);
}

console.log(`[bridge] using ${python.cmd} ${python.prefix.join(' ')}`.trim());
const child = spawn(python.cmd, [...python.prefix, 'bridge/app.py'], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill();
    process.exit(0);
  });
}

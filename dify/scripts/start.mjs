/**
 * One command to bring up the whole demo: PowerContext bridge (if Python with
 * powercontext is available) plus the world service. `npm start`.
 *
 * Every part is optional except the world service, so the app stays runnable
 * on a machine without Python or without the seekdb native binary.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findPython } from './find-python.mjs';

const BRIDGE_HEALTH = process.env.POWERCONTEXT_HEALTH || 'http://127.0.0.1:8767/health';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 依赖缺失时自动补装，避免评审直接 `npm start` 时因 node_modules 不存在而中断。
const missing = ['express', 'seekdb', '@oceanbase/seekdb-node'].filter(
  (name) => !existsSync(`node_modules/${name}`),
);
if (missing.length > 0) {
  console.log(`[memory-inn] 检测到缺少依赖（${missing.join(', ')}），自动执行 npm install …`);
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      timeout: 300000,
    });
  } catch (error) {
    console.error(`[memory-inn] 自动安装失败（${error.message}），请手动执行 npm install`);
  }
}

async function bridgeUp() {
  try {
    const response = await fetch(BRIDGE_HEALTH, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

let bridge = null;
if (await bridgeUp()) {
  console.log('[memory-inn] PowerContext 边车已在运行，复用现有进程');
} else {
  const python = findPython();
  if (!python) {
    console.warn('[memory-inn] 未找到含 powercontext 的 Python，记忆边车跳过（记忆功能降级，其余功能正常）');
  } else {
    console.log(`[memory-inn] 启动记忆边车：${python.cmd} ${python.prefix.join(' ')} bridge/app.py`.trim());
    bridge = spawn(python.cmd, [...python.prefix, 'bridge/app.py'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    bridge.stdout.on('data', (chunk) => process.stdout.write(`[bridge] ${chunk}`));
    bridge.stderr.on('data', (chunk) => process.stderr.write(`[bridge] ${chunk}`));
    bridge.on('exit', (code) => console.warn(`[memory-inn] 记忆边车退出 code=${code}`));
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      if (await bridgeUp()) { console.log('[memory-inn] 记忆边车就绪'); break; }
    }
  }
}

const server = spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit', env: process.env });

const stop = (signal) => {
  try { server.kill(signal); } catch {}
  if (bridge) { try { bridge.kill(signal); } catch {} }
};
process.on('SIGINT', () => { stop('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { stop('SIGTERM'); process.exit(0); });
server.on('exit', (code) => {
  if (bridge) { try { bridge.kill(); } catch {} }
  process.exit(code ?? 0);
});

import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, YACWU_BACKEND_ROOT: process.env.YACWU_BACKEND_ROOT || root, YACWU_STATIC: process.env.YACWU_STATIC || resolve(root, 'build') };
if (process.platform === 'win32') {
  env.YACWU_BACKENDS = '';
  env.YACWU_PERSISTENT_BACKENDS = '0';
}
const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));
const child = spawn('gleam', ['run', ...(args.length ? ['--', ...args] : [])], { cwd: resolve(root, 'server'), env, stdio: 'inherit', windowsHide: false });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); else child.kill(signal); });

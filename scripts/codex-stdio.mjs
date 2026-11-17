import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve native executables or the standard npm Codex launcher; never feed
 * an executable path or user arguments into cmd.exe. */
export function resolveCommand(command, args, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { command, args };
  const candidates = isAbsolute(command) || /[\\/]/.test(command)
    ? [resolve(command)]
    : (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean).map(dir => join(dir, command));
  for (const candidate of candidates) {
    if ((!extname(candidate) || extname(candidate).toLowerCase() === '.exe') && existsSync(extname(candidate) ? candidate : `${candidate}.exe`)) {
      return { command: extname(candidate) ? candidate : `${candidate}.exe`, args };
    }
    if (/^codex(?:\.cmd)?$/i.test(command.split(/[\\/]/).pop() || '')) {
      const scripts = [join(dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), join(dirname(candidate), '..', '@openai', 'codex', 'bin', 'codex.js')];
      const script = scripts.find(existsSync);
      if (script) return { command: process.execPath, args: [script, ...args] };
    }
  }
  throw new Error(`Cannot find native executable ${command}. Install Codex with npm, or set YACWU_CODEX_BIN to codex.exe.`);
}

export function run(command, args) {
  const executable = resolveCommand(command, args);
  let log;
  try { if (process.env.YACWU_CODEX_STDERR_LOG) log = openSync(process.env.YACWU_CODEX_STDERR_LOG, 'a'); } catch { /* inherit stderr */ }
  const child = spawn(executable.command, executable.args, { stdio: ['pipe', 'pipe', log ?? 'inherit'], windowsHide: true });
  if (log !== undefined) closeSync(log);
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      else child.kill('SIGTERM');
    }
  }
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdout.on('error', stop);
  child.stdin.on('error', () => {});
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('error', error => { console.error(error.message); process.exitCode = 1; process.stdin.destroy(); });
  child.on('close', code => { process.stdin.destroy(); process.exitCode = code ?? 1; });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(process.argv[2] || process.env.YACWU_CODEX_BIN || 'codex', process.argv.slice(3)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

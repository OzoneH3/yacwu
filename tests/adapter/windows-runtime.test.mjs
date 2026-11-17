import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { resolveCommand } from '../../scripts/codex-stdio.mjs';

const scratch = resolve('.workspace/runtime-tests');
mkdirSync(scratch, { recursive: true });
test('npm shim resolution preserves each argument and never executes a command shell', () => {
  const dir = mkdtempSync(join(scratch, 'npm with spaces-'));
  try {
    const script = join(dir, 'node_modules/@openai/codex/bin/codex.js');
    mkdirSync(join(dir, 'node_modules/@openai/codex/bin'), { recursive: true });
    writeFileSync(script, '');
    const args = ['app-server', 'C:/work & data/日本'];
    const found = resolveCommand(join(dir, 'codex.cmd'), args, {}, 'win32');
    assert.equal(found.command, process.execPath);
    assert.deepEqual(found.args, [script, ...args]);
    assert.throws(() => resolveCommand(join(dir, 'other.cmd'), [], {}, 'win32'), /Cannot find native executable/);
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
    const local = resolveCommand(join(dir, 'node_modules/.bin/codex.cmd'), args, {}, 'win32');
    assert.equal(resolve(local.args[0]), script);
    assert.deepEqual(local.args.slice(1), args);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('stdio bridge carries protocol output separately and exits when its owner closes stdin', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['scripts/codex-stdio.mjs', process.execPath, '-e',
    'process.stdin.on("data", d => process.stdout.write(d)); console.error("diagnostic");'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, YACWU_CODEX_STDERR_LOG: '' } });
  const exited = once(child, 'exit');
  try {
    const output = once(child.stdout, 'data');
    child.stdin.write('{"id":1}\n');
    assert.equal(String((await output)[0]), '{"id":1}\n');
    child.stdin.end();
    await exited;
  } finally { if (child.exitCode === null) child.kill(); }
});
test('Windows owner closure terminates Codex descendants', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const program = `const {spawn}=require('node:child_process'); const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(JSON.stringify({pid:process.pid,worker:worker.pid})+'\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['scripts/codex-stdio.mjs', process.execPath, '-e', program], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  const [chunk] = await once(child.stdout, 'data');
  const pids = JSON.parse(String(chunk));
  child.stdin.end();
  await exited;
  assert.throws(() => process.kill(pids.pid, 0));
  assert.throws(() => process.kill(pids.worker, 0));
});

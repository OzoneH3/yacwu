// No login or inference: exercise a real app-server via Yacwu's Windows bridge.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const child = spawn(process.execPath, ['scripts/codex-stdio.mjs', process.env.YACWU_CODEX_BIN || 'codex', 'app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
const exited = once(child, 'exit');
let counter = 0;
const pending = new Map();
function fail(error) { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); }
child.on('exit', () => fail(new Error('Codex exited before replying')));
child.on('error', fail);
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const msg = JSON.parse(line);
  const waiter = pending.get(msg.id);
  if (waiter) { pending.delete(msg.id); msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result); }
});
function request(method, params) {
  const id = ++counter;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
}
const timer = setTimeout(() => { fail(new Error('Codex smoke test timed out')); child.stdin.end(); }, 30000);
try {
  const initialized = await request('initialize', { clientInfo: { name: 'yacwu_smoke', version: '1.0.0' } });
  assert.ok(initialized);
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const threads = await request('thread/list', { limit: 1 });
  assert.ok(Array.isArray(threads.data));
  console.log('Codex initialization and thread listing passed without model credentials');
} finally {
  clearTimeout(timer);
  lines.close();
  child.stdin.end();
  await exited;
}

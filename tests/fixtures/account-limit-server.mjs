// Deterministic app-server for account guards: no model or credentials involved.
import { createInterface } from 'node:readline';
const provider = process.argv[2] ?? 'codex';
let used = 0, starts = 0, steers = 0, failUsage = false;
const active = new Map(), interrupted = [];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const quota = () => ({ rateLimits: provider === 'copilot' ? { limitId: 'copilot', copilotUsage: { used } } : { limitId: 'codex', primary: { usedPercent: used, resetsAt: Math.floor(Date.now() / 1000) + 1000 }, secondary: null } });
createInterface({ input: process.stdin }).on('line', line => {
 const { id, method, params = {} } = JSON.parse(line);
 if (id == null) return;
 let result = {};
 if (method === 'test/fail-usage') failUsage = true;
 if (method === 'account/rateLimits/read') {
  if (failUsage) {
   failUsage = false;
   send({ id, error: { code: -32603, message: 'temporary usage endpoint failure' } });
   return;
  }
  result = quota();
 }
 if (method === 'turn/start') {
  const turn = { id: `turn-${++starts}`, status: 'inProgress', items: [] };
  active.set(params.threadId, turn); result = { turn };
  send({ method: 'turn/started', params: { threadId: params.threadId, turn } });
 }
 if (method === 'turn/steer') steers++;
 if (method === 'turn/interrupt') {
  interrupted.push(params.threadId);
  const turn = active.get(params.threadId);
  active.delete(params.threadId);
  send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { ...turn, status: 'interrupted' } } });
 }
 if (method === 'test/exhaust') {
  used = provider === 'copilot' ? 2000 : 90;
  send({ method: 'account/rateLimits/updated', params: quota() });
 }
 if (method === 'test/stats') result = { starts, steers, interrupted };
 send({ id, result });
});

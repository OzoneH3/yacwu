// Protocol fixture: records the exact policy sent by Yacwu, no model requests.
import { createInterface } from 'node:readline';
let next = 0; const seen = [];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
 const { id, method, params = {} } = JSON.parse(line);
 if (id == null) return;
 seen.push({ method, params }); let result = {};
 if (method === 'thread/start' || method === 'thread/fork') result = { thread: { id: `file-access-${++next}`, status: { type: 'idle' }, turns: [] } };
 if (method === 'thread/resume') result = { thread: { id: params.threadId, status: { type: 'idle' }, turns: [] } };
 if (method === 'turn/start') {
  const turn = { id: `turn-${++next}`, status: 'inProgress', items: [] };
  send({ method: 'turn/started', params: { threadId: params.threadId, turn } }); result = { turn };
 }
 if (method === 'turn/interrupt') send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn', status: 'interrupted', items: [] } } });
 if (method === 'test/seen') result = { seen };
 send({ id, result });
});

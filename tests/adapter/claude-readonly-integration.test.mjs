import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adapter, skip, startServer } from './yacwu-server.mjs';

async function call(base, path, data) {
 const response = await fetch(base + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
 return { ok: response.ok, data: await response.json() };
}

test('the updated Claude launch shim advertises enforced read-only mode through the real server', { skip }, async t => {
 const server = await startServer(mkdtempSync(join(tmpdir(), 'claude-readonly-ready-')));
 t.after(server.stop);
 const created = await call(server.base, '/threads', { host: 'claude', fileAccess: 'read-only' });
 assert.equal(created.ok, true, JSON.stringify(created.data));
 const id = created.data.thread.id;
 const access = await call(server.base, `/threads/${id}/file-access?host=claude`);
 assert.equal(access.data.mode, 'read-only'); assert.equal(access.data.readOnlySupported, true); assert.equal(access.data.readOnlyKind, 'tools');
 const shell = await call(server.base, `/threads/${id}/shell?host=claude`, { command: 'touch forbidden' });
 assert.equal(shell.ok, false); assert.match(shell.data.error, /read-only/);
 const fork = await call(server.base, `/threads/${id}/fork?host=claude`, {});
 assert.equal(fork.ok, true, JSON.stringify(fork.data));
 assert.equal((await call(server.base, `/threads/${fork.data.thread.id}/file-access?host=claude`)).data.mode, 'read-only');
 const changed = await call(server.base, `/threads/${id}/file-access?host=claude`, { mode: 'read-write' });
 assert.equal(changed.ok, true, JSON.stringify(changed.data)); assert.equal(changed.data.mode, 'read-write');
});

test('an older Claude process cannot enable or create read-only sessions', { skip }, async t => {
 const server = await startServer(mkdtempSync(join(tmpdir(), 'claude-readonly-old-')), { claudeBackend: `node ${adapter} app-server --listen stdio://` });
 t.after(server.stop);
 const rejected = await call(server.base, '/threads', { host: 'claude', fileAccess: 'read-only' });
 assert.equal(rejected.ok, false); assert.match(rejected.data.error, /Restart the Claude backend daemon/);
 const created = await call(server.base, '/threads', { host: 'claude', fileAccess: 'read-write' });
 assert.equal(created.ok, true, JSON.stringify(created.data));
 const id = created.data.thread.id;
 const access = await call(server.base, `/threads/${id}/file-access?host=claude`);
 assert.equal(access.data.readOnlySupported, false);
 const changed = await call(server.base, `/threads/${id}/file-access?host=claude`, { mode: 'read-only' });
 assert.equal(changed.ok, false); assert.match(changed.data.error, /Restart the Claude backend daemon/);
 assert.equal((await call(server.base, `/threads/${id}/file-access?host=claude`)).data.mode, 'read-write');
});

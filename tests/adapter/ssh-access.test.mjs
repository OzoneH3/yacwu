import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, readFileSync, existsSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateSetup, expiryTime, hostId } from '../../scripts/ssh-access.mjs';
const helper = fileURLToPath(new URL('../../scripts/ssh-access.mjs', import.meta.url));
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'yacwu-ssh-'));
 for (const path of ['bin', 'runtime', 'remote/.ssh']) mkdirSync(join(root, path), { recursive: true });
 copyFileSync(new URL('./fake-ssh.mjs', import.meta.url), join(root, 'bin/ssh')); chmodSync(join(root, 'bin/ssh'), 0o755);
 writeFileSync(join(root, 'remote/.ssh/authorized_keys'), 'ssh-ed25519 AAAA-other unrelated-key\n');
 const env = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, HOME: join(root, 'local'), XDG_STATE_HOME: join(root, 'state'), XDG_RUNTIME_DIR: join(root, 'runtime'), FAKE_SSH_ROOT: root };
 const call = (input, extra = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [helper], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  const timeout = setTimeout(() => { child.kill(); reject(new Error('helper hung: ' + error)); }, 15000);
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
  child.on('exit', () => { clearTimeout(timeout); try { resolve(JSON.parse(output)); } catch { reject(new Error(output + error)); } });
  // Match Erlang port transport: newline, without EOF until the helper exits.
  child.stdin.on('error', () => {}); child.stdin.write(JSON.stringify(input) + '\n');
 });
 return { root, call };
}
const input = { action: 'setup', hostname: 'test.example', username: 'test', port: 2222, hours: 1, password: 'test-password-value' };

test('password-assisted setup confirms host key, installs and verifies an expiring identity, then revokes exactly it', async () => {
 const { root, call } = fixture();
 const first = await call(input);
 assert.equal(first.confirmationRequired, true); assert.equal(first.fingerprint, 'SHA256:TESTFINGERPRINT');
 assert.equal(readFileSync(join(root, 'remote/.ssh/authorized_keys'), 'utf8'), 'ssh-ed25519 AAAA-other unrelated-key\n');
 const result = await call({ ...input, confirmedFingerprint: first.fingerprint });
 assert.equal(result.ok, true, JSON.stringify(result));
 const dir = join(root, 'state/yacwu/ssh-access', hostId(result.host));
 const metadata = readFileSync(join(dir, 'entry.json'), 'utf8');
 assert.ok(!metadata.includes(input.password));
 assert.equal(statSync(join(dir, 'id_ed25519')).mode & 0o777, 0o600);
 const remote = readFileSync(join(root, 'remote/.ssh/authorized_keys'), 'utf8');
 assert.match(remote, /expiry-time="[0-9]{14}Z"/); assert.match(remote, /unrelated-key/);
 assert.ok(!readFileSync(join(root, 'argv.jsonl'), 'utf8').includes(input.password));
 assert.equal((await call({ ...input, confirmedFingerprint: first.fingerprint })).ok, undefined);
 const failed = await call({ action: 'revoke', host: result.host }, { FAKE_REJECT_KEY: '1' });
 assert.equal(failed.needsPassword, true); assert.equal(existsSync(dir), true);
 const removed = await call({ action: 'revoke', host: result.host, password: input.password }, { FAKE_REJECT_KEY: '1' });
 assert.equal(removed.ok, true); assert.equal(existsSync(dir), false);
 assert.equal(readFileSync(join(root, 'remote/.ssh/authorized_keys'), 'utf8'), 'ssh-ed25519 AAAA-other unrelated-key\n');
 assert.deepEqual(readdirSync(join(root, 'runtime')), []);
});

test('failed key verification rolls back authorization and deletes the failed local identity', async () => {
 const { root, call } = fixture(); writeFileSync(join(root, 'trusted'), 'yes');
 const result = await call(input, { FAKE_REJECT_KEY: '1' });
 assert.match(result.error, /did not accept/);
 assert.equal(readFileSync(join(root, 'remote/.ssh/authorized_keys'), 'utf8'), 'ssh-ed25519 AAAA-other unrelated-key\n');
 assert.deepEqual(readdirSync(join(root, 'state/yacwu/ssh-access')), []);
});

test('setup rejects injected targets, invalid TTLs and line-breaking passwords', () => {
 for (const changes of [{ hostname: '-oProxyCommand=bad' }, { username: 'u;sh' }, { hours: 999 }, { port: 0 }, { password: 'a\nb' }]) assert.throws(() => validateSetup({ ...input, ...changes }));
 assert.equal(expiryTime(Date.UTC(2026, 9, 18, 23, 15, 20)), '20261018231520Z');
});

test('OpenSSH accepts a future expiry and rejects an expired key', { timeout: 15000, skip: !existsSync('/usr/bin/sshd') && !existsSync('/usr/sbin/sshd') }, async t => {
 const { execFileSync } = await import('node:child_process');
 const { createServer } = await import('node:net');
 const root = mkdtempSync(join(tmpdir(), 'yacwu-sshd-'));
 const sshd = existsSync('/usr/bin/sshd') ? '/usr/bin/sshd' : '/usr/sbin/sshd';
 for (const name of ['host', 'identity']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)]);
 const port = await new Promise(resolve => { const socket = createServer().listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
 const config = join(root, 'sshd_config');
 writeFileSync(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(root, 'host')}\nPidFile ${join(root, 'sshd.pid')}\nAuthorizedKeysFile ${join(root, 'authorized_keys')}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitUserRC no\nLogLevel ERROR\n`);
 const server = spawn(sshd, ['-D', '-e', '-f', config], { env: { ...process.env, YACWU_PERSISTENT_BACKENDS: '0', YACWU_BACKENDS: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
 t.after(() => server.kill());
 let logs = ''; server.stderr.on('data', b => logs += b);
 const pub = readFileSync(join(root, 'identity.pub'), 'utf8').trim();
 const username = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
 const authenticate = () => new Promise(resolve => {
  const child = spawn('ssh', ['-F', '/dev/null', '-v', '-N', '-T', '-oConnectTimeout=2', '-oBatchMode=yes', '-oStrictHostKeyChecking=accept-new', `-oUserKnownHostsFile=${join(root, 'known_hosts')}`, '-oIdentityAgent=none', '-i', join(root, 'identity'), '-p', String(port), '-l', username, '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let output = '', accepted = false;
  const timer = setTimeout(() => child.kill(), 3000);
  child.stderr.on('data', b => { output += b; if (output.includes('Authenticated to ')) { accepted = true; child.kill(); } });
  child.once('close', () => { clearTimeout(timer); resolve({ accepted, output }); });
 });
 writeFileSync(join(root, 'authorized_keys'), `expiry-time="${expiryTime(Date.now() + 3600000)}" ${pub}\n`);
 let result;
 for (let i = 0; i < 10; i++) { result = await authenticate(); if (!result.output.includes('Connection refused')) break; await new Promise(r => setTimeout(r, 30)); }
 assert.equal(result.accepted, true, logs + result.output);
 writeFileSync(join(root, 'authorized_keys'), `expiry-time="${expiryTime(Date.now() - 60000)}" ${pub}\n`);
 result = await authenticate(); assert.equal(result.accepted, false); assert.match(result.output, /Permission denied/);
});

#!/usr/bin/env node
// Passwords travel only over stdin and a private askpass socket, never argv,
// environment variables, state files, or diagnostic output.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, chmod, open } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const children = new Set();
export const stateRoot = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'yacwu/ssh-access');
export const hostId = host => createHash('sha256').update(host).digest('hex').toUpperCase();
export function validateSetup(input) {
 const hostname = String(input.hostname ?? '').trim();
 const username = String(input.username ?? '').trim();
 const port = input.port ?? 22, hours = input.hours ?? 24;
 if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,252}$/.test(hostname) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(username)) throw new Error('Enter a valid hostname and username.');
 if (!Number.isInteger(port) || port < 1 || port > 65535 || ![1, 8, 24, 168].includes(hours)) throw new Error('Choose a valid port and access duration.');
 if (typeof input.password !== 'string' || !input.password || input.password.length > 4096 || /[\r\n\0]/.test(input.password)) throw new Error('Enter the SSH password.');
 const host = `yacwu-${username}@${hostname.replaceAll(':', '-')}${port === 22 ? '' : `-${port}`}`;
 return { hostname, username, port, hours, host };
}
export const expiryTime = milliseconds => new Date(milliseconds).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function sshOptions(entry, key = true) {
 return ['-F', '/dev/null', '-oControlMaster=no', '-oControlPath=none', '-oConnectTimeout=10', '-oConnectionAttempts=1',
  `-oHostName=${entry.hostname}`, '-l', entry.username, '-p', String(entry.port),
  ...(key ? ['-i', entry.keyPath, '-oIdentitiesOnly=yes', '-oIdentityAgent=none', '-oBatchMode=yes'] : ['-oBatchMode=no', '-oPreferredAuthentications=password,keyboard-interactive', '-oPubkeyAuthentication=no', '-oNumberOfPasswordPrompts=1'])];
}
export function editKeysScript(entry, publicKey = null) {
 // Exact final comment match: never remove someone else's authorized keys.
 const line = publicKey ? `expiry-time="${expiryTime(entry.expiresAt)}",no-agent-forwarding,no-X11-forwarding,no-pty ${publicKey.trim()}` : '';
 return `set -eu
umask 077
mkdir -p "$HOME/.ssh"
file="$HOME/.ssh/authorized_keys"
[ ! -L "$file" ] || { echo 'authorized_keys is a symlink; manage it manually' >&2; exit 1; }
touch "$file"
lock="$HOME/.ssh/.yacwu-keys.lock"
n=0
until mkdir "$lock" 2>/dev/null; do n=$((n+1)); [ "$n" -lt 50 ] || exit 1; sleep 0.1; done
trap 'rmdir "$lock" 2>/dev/null || true' EXIT HUP INT TERM
tmp=$(mktemp "$HOME/.ssh/.yacwu-keys.XXXXXX")
trap 'rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true' EXIT HUP INT TERM
awk -v marker=${quote(entry.marker)} '$NF != marker' "$file" > "$tmp"
${line ? `printf '%s\\n' ${quote(line)} >> "$tmp"` : ''}
chmod 600 "$tmp"
mv "$tmp" "$file"
printf 'YACWU_KEY_OK\\n'
`;
}

async function run(command, args, { input = '', env = process.env, timeout = 30000 } = {}) {
 return await new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let output = '', size = 0;
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SSH setup timed out.')); }, timeout);
  const collect = chunk => { size += chunk.length; if (size <= 65536) output += chunk; else { child.kill('SIGKILL'); reject(new Error('SSH output exceeded its limit.')); } };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.on('error', () => { clearTimeout(timer); reject(new Error(`${command} is not available.`)); });
  child.stdin.on('error', () => {});
  child.on('close', code => { children.delete(child); clearTimeout(timer); resolveRun({ code, output }); });
  child.stdin.end(input);
 });
}

async function withPassword(input, action) {
 const runtime = process.env.XDG_RUNTIME_DIR || join(stateRoot(), 'runtime');
 await mkdir(runtime, { recursive: true, mode: 0o700 });
 const socketPath = join(runtime, `yk-${randomBytes(6).toString('hex')}.sock`);
 let hostKey = null, passwordRequests = 0;
 const server = createServer(socket => {
  let text = '';
  socket.setTimeout(5000, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', data => {
   text += data; if (text.length > 8192) { socket.destroy(); return; }
   if (!text.includes('\n')) return;
   let prompt; try { prompt = JSON.parse(text.split('\n')[0]).prompt; } catch { socket.destroy(); return; }
   if (typeof prompt !== 'string') { socket.destroy(); return; }
   if (prompt.includes('Are you sure you want to continue connecting')) {
    const fingerprint = prompt.match(/SHA256:[a-zA-Z0-9+/]+/g)?.at(-1);
    if (fingerprint && input.confirmedFingerprint === fingerprint) socket.end('yes');
    else { hostKey = { fingerprint, prompt }; socket.end(''); }
   } else if (/password:/i.test(prompt) && ++passwordRequests <= 1) socket.end(input.password || '');
   else socket.end('');
  });
 });
 await new Promise((done, fail) => { server.once('error', fail); server.listen(socketPath, done); });
 await chmod(socketPath, 0o600);
 try {
  const result = await action({ ...process.env, SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0', YACWU_SSH_ASKPASS_SOCKET: socketPath });
  if (hostKey) return { confirmationRequired: true, ...hostKey };
  return result;
 } finally { server.close(); await rm(socketPath, { force: true }); }
}

async function ssh(entry, command, passwordInput = null) {
 const exec = async env => {
  const result = await run('ssh', [...sshOptions(entry, !passwordInput), `-oStrictHostKeyChecking=${passwordInput ? 'ask' : 'yes'}`, '--', entry.host, 'exec sh'], { input: command, env });
  // Do not echo arbitrary remote output; it can contain secrets or shell noise.
  return result.code === 0 && result.output.includes('YACWU_KEY_OK') ? { ok: true } : { error: 'SSH authentication or remote key update failed. Check the address, password, permissions and OpenSSH support.' };
 };
 return passwordInput ? withPassword(passwordInput, exec) : exec(process.env);
}

async function lock(host, action) {
 const root = stateRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
 const path = join(root, `${hostId(host)}.lock`);
 let fd;
 try { fd = await open(path, 'wx', 0o600); }
 catch (error) {
  if (error.code !== 'EEXIST') throw error;
  let pid; try { pid = Number(await readFile(path, 'utf8')); process.kill(pid, 0); } catch (error) {
   if (error.code === 'ESRCH') { await rm(path, { force: true }); return lock(host, action); }
  }
  throw new Error('Another SSH access update is running for this host.');
 }
 await fd.writeFile(String(process.pid));
 try { return await action(); } finally { await fd.close(); await rm(path, { force: true }); }
}

export async function setup(input) {
 const validated = validateSetup(input);
 return lock(validated.host, async () => {
  const dir = join(stateRoot(), hostId(validated.host));
  try { await readFile(join(dir, 'entry.json')); throw new Error('Access already exists for this host. Remove it before creating a new key.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = { ...validated, keyPath: join(dir, 'id_ed25519'), marker: `yacwu-${randomBytes(16).toString('hex')}`, expiresAt: Date.now() + validated.hours * 3600000 };
  let installed = false;
  try {
   const keygen = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', entry.marker, '-f', entry.keyPath]);
   if (keygen.code !== 0) throw new Error('Could not generate the SSH key.');
   const publicKey = await readFile(`${entry.keyPath}.pub`, 'utf8');
   const added = await ssh(entry, editKeysScript(entry, publicKey), input);
   if (!added.ok) return added;
   installed = true;
   const verified = await ssh(entry, "printf 'YACWU_KEY_OK\\n'\n");
   if (!verified.ok) {
    throw new Error('The server did not accept the expiring key. Check public-key authentication and expiry-time support.');
   }
   await writeFile(join(dir, 'entry.json.new'), JSON.stringify(entry), { mode: 0o600 });
   await rename(join(dir, 'entry.json.new'), join(dir, 'entry.json'));
   return { ok: true, host: entry.host, expiresAt: entry.expiresAt };
  } catch (error) {
   if (installed) {
    const rollback = await ssh(entry, editKeysScript(entry), input).catch(() => ({ error: 'rollback failed' }));
    if (!rollback.ok) {
     await writeFile(join(dir, 'entry.json'), JSON.stringify({ ...entry, cleanupRequired: true }), { mode: 0o600 });
     throw new Error('Setup could not finish and remote cleanup could not be confirmed. Use Remove access to retry; the key also expires automatically.');
    }
   }
   throw error;
  } finally {
   // Keep recovery records if remote cleanup failed; otherwise erase local keys.
   try { await readFile(join(dir, 'entry.json')); } catch { await rm(dir, { recursive: true, force: true }); }
  }
 });
}

export async function revoke(input) {
 if (typeof input.host !== 'string' || !/^yacwu-[a-zA-Z0-9_.@-]+$/.test(input.host)) throw new Error('Invalid managed host.');
 return lock(input.host, async () => {
  const dir = join(stateRoot(), hostId(input.host));
  const entry = JSON.parse(await readFile(join(dir, 'entry.json'), 'utf8'));
  let removed = await ssh(entry, editKeysScript(entry));
  if (!removed.ok && input.password) removed = await ssh(entry, editKeysScript(entry), input);
  if (!removed.ok) return { ...removed, needsPassword: !removed.confirmationRequired };
  await rm(dir, { recursive: true, force: true });
  return { ok: true, host: input.host };
 });
}

async function askpass(prompt) {
 const socket = createConnection(process.env.YACWU_SSH_ASKPASS_SOCKET);
 socket.setTimeout(5000, () => socket.destroy());
 socket.on('connect', () => socket.write(JSON.stringify({ prompt }) + '\n'));
 socket.on('data', data => process.stdout.write(data));
 socket.on('error', () => { process.exitCode = 1; });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 if (process.env.YACWU_SSH_ASKPASS_SOCKET && process.argv[2]) await askpass(process.argv[2]);
 else {
  const cleanup = () => { for (const child of children) child.kill('SIGTERM'); };
  process.on('exit', cleanup);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { cleanup(); process.exit(1); });
  try {
   const text = await new Promise((done, fail) => {
    let text = '';
    process.stdin.on('data', chunk => {
     text += chunk;
     if (text.length > 16384) { process.stdin.destroy(); fail(new Error('Request too large.')); }
     else if (text.includes('\n')) { process.stdin.destroy(); done(text.split('\n')[0]); }
    });
    process.stdin.on('end', () => done(text));
   });
   const input = JSON.parse(text);
   const result = input.action === 'revoke' ? await revoke(input) : input.action === 'setup' ? await setup(input) : { error: 'Unknown SSH access operation.' };
   process.stdout.write(JSON.stringify(result));
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.code === 'ENOENT' ? 'SSH access record not found.' : error.message })); }
 }
}

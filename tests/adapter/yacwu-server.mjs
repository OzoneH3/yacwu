// An isolated Yacwu server for adapter-level tests: own HOME, state and port,
// no persistent backends, and the Claude adapter in mock mode (no model calls).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('../..', import.meta.url));
export const adapter = join(repo, 'claude-codex/dist/src/adapter.mjs');
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
export const skip = !existsSync(adapter) ? 'Claude adapter checkout is not built'
	: !has('gleam') ? 'gleam is not installed'
	: !has('codex') ? 'codex is not installed'
	: false;

const freePort = () => new Promise((resolve) => {
	const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

/**
 * Start the server under `root`. `claudeBackend` replaces the Claude backend
 * command (default: Yacwu's wrapper, with its allowance guard).
 */
export async function startServer(root, { claudeBackend } = {}) {
	const port = await freePort();
	const home = join(root, 'home');
	mkdirSync(home);
	const child = spawn('gleam', ['run'], {
		cwd: join(repo, 'server'),
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			HOME: home,
			XDG_STATE_HOME: join(home, 'state'),
			PORT: String(port),
			YACWU_PERSISTENT_BACKENDS: '0',
			YACWU_INSECURE_SKIP_AUTH: '1',
			YACWU_BACKEND_ROOT: repo,
			YACWU_BACKENDS: `claude=${claudeBackend ?? `node ./scripts/claude-backend.mjs ${adapter}`}`,
			CLAUDE_CODEX_MOCK: '1'
		}
	});
	let log = '';
	child.stdout.on('data', (data) => { log += data; });
	child.stderr.on('data', (data) => { log += data; });
	const base = `http://127.0.0.1:${port}/api`;
	for (let i = 0; i < 240; i++) {
		try { if ((await fetch(`${base}/hosts`)).ok) return { base, home, pid: child.pid, stop: () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } }; } catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	try { process.kill(-child.pid, 'SIGTERM'); } catch {}
	throw new Error(`server did not start:\n${log.slice(-2000)}`);
}

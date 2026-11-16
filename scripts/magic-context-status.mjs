// Read the status Magic Context reports for its own OpenCode session.
//
// The plugin answers `/ctx-status` with a TUI action, which Yacwu cannot show.
// Its OpenCode server also exposes a loopback RPC server with the same status
// data (`status-detail`); the server writes a discovery file named after the
// canonical project directory, exactly as its TUI finds it. That file records
// `started_at`, not `startedAt`.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Discovery files are keyed by this hash of the canonical directory. */
export function projectHash(directory) {
	const canonical = (() => {
		try {
			return realpathSync.native(directory);
		} catch {
			return resolve(directory);
		}
	})();
	return createHash('sha256').update(resolve(canonical)).digest('hex').slice(0, 16);
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === 'EPERM';
	}
}

/**
 * The newest live RPC server for `directory`, or null when the plugin's server
 * has not started (or has exited and left a stale discovery file behind).
 */
export function discoverRpcServer(storageDir, directory, { alive = processAlive } = {}) {
	const root = join(storageDir, 'rpc', projectHash(directory));
	let entries;
	try {
		entries = readdirSync(root);
	} catch {
		return null;
	}
	const servers = [];
	for (const entry of entries) {
		if (!/^port-.*\.json$/.test(entry)) continue;
		let record;
		try {
			record = JSON.parse(readFileSync(join(root, entry), 'utf8'));
		} catch {
			continue;
		}
		const port = Number(record?.port);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
		if (!alive(Number(record?.pid))) continue;
		servers.push({
			port,
			token: typeof record?.token === 'string' ? record.token : '',
			pid: Number(record?.pid) || null,
			// The plugin writes `started_at`. Accept the camelCase alias too.
			startedAt: Number(record?.started_at) || Number(record?.startedAt) || 0
		});
	}
	servers.sort((a, b) => b.startedAt - a.startedAt || b.port - a.port);
	return servers[0] ?? null;
}

function rpcError(reply) {
	if (typeof reply?.error === 'string') {
		return reply.error === 'unavailable'
			? 'Magic Context status is unavailable for this session'
			: `Magic Context status is unavailable: ${reply.error}`;
	}
	if (reply?.disabled === true) {
		return reply.paused
			? 'Magic Context is paused for this project'
			: 'Magic Context is disabled for this project';
	}
	return null;
}

/** Fetch the plugin's status-detail payload for one OpenCode session. */
export async function fetchStatusDetail(
	{ storageDir, directory, sessionId, timeoutMs = 5000 },
	{ fetchImpl = globalThis.fetch, ...discovery } = {}
) {
	if (!sessionId) {
		throw new Error('Magic Context has no session for this thread yet; send a message first');
	}
	const server = discoverRpcServer(storageDir, directory, discovery);
	if (!server) {
		throw new Error(`Magic Context is not running for ${directory} (no RPC discovery file)`);
	}
	let response;
	try {
		response = await fetchImpl(`http://127.0.0.1:${server.port}/rpc/status-detail`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${server.token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ sessionId, directory }),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (error) {
		throw new Error(`Magic Context status request failed: ${error?.message ?? error}`);
	}
	if (!response.ok) {
		throw new Error(`Magic Context status request failed (HTTP ${response.status})`);
	}
	const reply = await response.json().catch(() => null);
	const failure = rpcError(reply);
	if (failure) throw new Error(failure);
	if (!reply || typeof reply.usagePercentage !== 'number') {
		throw new Error('Magic Context returned an unexpected status reply');
	}
	return reply;
}

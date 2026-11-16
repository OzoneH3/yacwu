import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	discoverRpcServer,
	fetchStatusDetail,
	projectHash
} from '../../scripts/magic-context-status.mjs';
import { openCodeThreadStatus } from '../../scripts/opencode-backend.mjs';

const STATUS = {
	sessionId: 'ses_test',
	usagePercentage: 42.5,
	inputTokens: 71400,
	contextLimit: 168000,
	compartmentCount: 2,
	memoryCount: 3,
	sessionNoteCount: 1,
	pluginVersion: '0.49.56'
};

async function rpcServer(handler) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A managed OpenCode storage tree holding one discovery file per record. */
function projectStorage() {
	const storage = mkdtempSync(join(tmpdir(), 'yacwu-magic-context-'));
	const directory = mkdtempSync(join(tmpdir(), 'yacwu-magic-context-project-'));
	const rpcDir = join(storage, 'rpc', projectHash(directory));
	mkdirSync(rpcDir, { recursive: true });
	const record = (port, extra = {}) => {
		writeFileSync(
			join(rpcDir, `port-${port}.json`),
			JSON.stringify({ port, token: 'secret', pid: process.pid, startedAt: 1, ...extra })
		);
	};
	return { storage, directory, rpcDir, record };
}

test('Magic Context status reads the project RPC server with the session token', async () => {
	const { storage, directory, record } = projectStorage();
	let seen;
	const server = await rpcServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) body += chunk;
		seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(STATUS));
	});
	try {
		record(server.port);
		const status = await fetchStatusDetail({ storageDir: storage, directory, sessionId: 'ses_test' });
		assert.equal(status.usagePercentage, 42.5);
		assert.equal(seen.url, '/rpc/status-detail');
		assert.equal(seen.auth, 'Bearer secret');
		assert.deepEqual(seen.body, { sessionId: 'ses_test', directory });
	} finally {
		await server.close();
	}
});

test('Magic Context discovery ignores dead servers and prefers the newest one', () => {
	const { storage, directory, record } = projectStorage();
	record(41001, { pid: 4001, startedAt: 10 });
	record(41002, { pid: 4002, startedAt: 20 });
	record(41003, { pid: 4003, startedAt: 30 });
	const alive = (pid) => pid !== 4002;
	const server = discoverRpcServer(storage, directory, { alive });
	assert.deepEqual(
		{ port: server.port, startedAt: server.startedAt, pid: server.pid },
		{ port: 41003, startedAt: 30, pid: 4003 }
	);
});

test('Magic Context discovery reads the plugin started_at field', () => {
	const { storage, directory, record } = projectStorage();
	record(41011, { pid: 4011, started_at: 40 });
	record(41012, { pid: 4012, started_at: 10 });
	const server = discoverRpcServer(storage, directory, { alive: () => true });
	assert.equal(server.port, 41011);
	assert.equal(server.startedAt, 40);
});

test('Magic Context status explains a server that is not running', async () => {
	const { storage, directory } = projectStorage();
	await assert.rejects(
		fetchStatusDetail({ storageDir: storage, directory, sessionId: 'ses_test' }),
		/is not running/
	);
	await assert.rejects(
		fetchStatusDetail({ storageDir: storage, directory, sessionId: '' }),
		/send a message/i
	);
});

test('Magic Context status surfaces plugin refusals instead of an empty view', async () => {
	const { storage, directory, record } = projectStorage();
	const replies = [{ error: 'unavailable' }, { disabled: true }, { disabled: true, paused: true }];
	const server = await rpcServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(replies.shift()));
	});
	try {
		record(server.port);
		const read = () => fetchStatusDetail({ storageDir: storage, directory, sessionId: 'ses_test' });
		await assert.rejects(read(), /status is unavailable for this session/);
		await assert.rejects(read(), /disabled for this project/);
		await assert.rejects(read(), /paused for this project/);
	} finally {
		await server.close();
	}
});

test('Magic Context status reports an HTTP failure from the plugin server', async () => {
	const { storage, directory, record } = projectStorage();
	const server = await rpcServer((req, res) => {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
	});
	try {
		record(server.port);
		await assert.rejects(
			fetchStatusDetail({ storageDir: storage, directory, sessionId: 'ses_test' }),
			/HTTP 401/
		);
	} finally {
		await server.close();
	}
});

test('OpenCode threads need their own Magic Context session before a status exists', async () => {
	await assert.rejects(
		openCodeThreadStatus({ getThread: () => ({ cwd: '/project', claudeSessionId: null }) }, 'thr'),
		/Send a message/
	);
	await assert.rejects(
		openCodeThreadStatus({ getThread: () => null }, 'thr'),
		/Unknown thread/
	);
});

test('OpenCode threads read status through their recorded session', async () => {
	const { storage, directory, record } = projectStorage();
	let seen;
	const server = await rpcServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) body += chunk;
		seen = JSON.parse(body);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(STATUS));
	});
	try {
		record(server.port);
		const status = await openCodeThreadStatus(
			{ getThread: () => ({ cwd: directory, claudeSessionId: 'ses_thread' }) },
			'thr',
			{ storageDir: storage }
		);
		assert.equal(status.memoryCount, 3);
		assert.deepEqual(seen, { sessionId: 'ses_thread', directory });
	} finally {
		await server.close();
	}
});

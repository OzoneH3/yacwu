import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
	fetchGoUsage,
	GO_USAGE_URL,
	mapGoUsage,
	openCodeDatabasePath,
	openCodeRateLimits,
	readGoKey
} from '../../scripts/opencode-usage.mjs';
import { openCodeUsageLimits } from '../../scripts/opencode-backend.mjs';

const GO_USAGE = {
	rolling: { status: 'ok', percent: 31, resetsAt: '2026-11-16T17:41:10.000Z' },
	weekly: { status: 'ok', percent: 12, resetsAt: '2026-11-23T00:00:00.000Z' },
	monthly: { status: 'ok', percent: 6, resetsAt: '2026-12-16T12:18:41.000Z' }
};

test('OpenCode Go usage maps rolling to the 5-hour and weekly to the 7-day window', () => {
	const { rateLimits } = mapGoUsage(GO_USAGE);
	assert.equal(rateLimits.limitId, 'opencode');
	assert.equal(rateLimits.planType, 'go');
	assert.deepEqual(rateLimits.primary, {
		usedPercent: 31,
		windowDurationMins: 300,
		resetsAt: Math.floor(Date.parse('2026-11-16T17:41:10.000Z') / 1000)
	});
	assert.deepEqual(rateLimits.secondary, {
		usedPercent: 12,
		windowDurationMins: 10080,
		resetsAt: Math.floor(Date.parse('2026-11-23T00:00:00.000Z') / 1000)
	});
});

test('OpenCode Go usage is empty windows without data', () => {
	const { rateLimits, rateLimitsByLimitId } = mapGoUsage(null);
	assert.equal(rateLimits.primary, null);
	assert.equal(rateLimits.secondary, null);
	assert.equal(rateLimitsByLimitId.opencode, rateLimits);
});

test('OpenCode Go usage ignores malformed meters and flags a rate-limited window', () => {
	const malformed = mapGoUsage({ rolling: { percent: 120 }, weekly: null }).rateLimits;
	assert.equal(malformed.primary, null);
	assert.equal(malformed.secondary, null);
	assert.equal(malformed.rateLimitReachedType, null);

	const limited = mapGoUsage({ ...GO_USAGE, weekly: { ...GO_USAGE.weekly, status: 'rate-limited' } }).rateLimits;
	assert.equal(limited.rateLimitReachedType, 'primary');
});

/** A temp OpenCode database holding one credential row. */
function goDatabase(value) {
	const dataHome = mkdtempSync(join(tmpdir(), 'yacwu-opencode-home-'));
	const dbPath = openCodeDatabasePath(dataHome);
	mkdirSync(join(dataHome, 'opencode'), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec(
		'create table credential (id text primary key, integration_id text, label text, value text, active integer)'
	);
	db.prepare('insert into credential values (?, ?, ?, ?, ?)').run(
		'cred_1',
		'opencode-go',
		'OpenCode Go',
		JSON.stringify(value),
		1
	);
	db.close();
	return { dataHome, dbPath };
}

test('readGoKey reads the active opencode-go key from the database', () => {
	const { dbPath } = goDatabase({ type: 'key', key: 'go-secret' });
	assert.equal(readGoKey(dbPath), 'go-secret');
});

test('readGoKey ignores other integrations and inactive credentials', () => {
	const dataHome = mkdtempSync(join(tmpdir(), 'yacwu-opencode-home-'));
	mkdirSync(join(dataHome, 'opencode'), { recursive: true });
	const dbPath = openCodeDatabasePath(dataHome);
	const db = new DatabaseSync(dbPath);
	db.exec('create table credential (id text, integration_id text, label text, value text, active integer)');
	db.prepare('insert into credential values (?, ?, ?, ?, ?)').run(
		'cred_2','openai','OpenAI',JSON.stringify({ type: 'oauth' }),1
	);
	db.prepare('insert into credential values (?, ?, ?, ?, ?)').run(
		'cred_3','opencode-go','OpenCode Go',JSON.stringify({ type: 'key', key: 'old' }),0
	);
	db.close();
	assert.equal(readGoKey(dbPath), null);
	assert.equal(readGoKey(join(dataHome, 'missing', 'opencode.db')), null);
});

test('fetchGoUsage sends the bearer token and returns the usage payload', async () => {
	let seen;
	const original = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		seen = { url, auth: options.headers.authorization };
		return new Response(JSON.stringify({ usage: GO_USAGE }), { status: 200 });
	};
	try {
		assert.deepEqual(await fetchGoUsage('go-secret'), GO_USAGE);
		assert.equal(seen.url, GO_USAGE_URL);
		assert.equal(seen.auth, 'Bearer go-secret');
	} finally {
		globalThis.fetch = original;
	}
});

test('fetchGoUsage returns null without a key or on a failed request', async () => {
	assert.equal(await fetchGoUsage(null), null);
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response('no', { status: 401 });
	try {
		assert.equal(await fetchGoUsage('go-secret'), null);
	} finally {
		globalThis.fetch = original;
	}
});

test('openCodeRateLimits reads the managed database and maps the live allowance', async () => {
	const { dataHome } = goDatabase({ type: 'key', key: 'go-secret' });
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ usage: GO_USAGE }), { status: 200 });
	try {
		const { rateLimits } = await openCodeRateLimits(dataHome);
		assert.equal(rateLimits.primary.usedPercent, 31);
		assert.equal(rateLimits.secondary.usedPercent, 12);
	} finally {
		globalThis.fetch = original;
	}
});

test('openCodeRateLimits yields empty windows when no Go key is stored', async () => {
	const { dataHome } = goDatabase({ type: 'oauth', access: 'x' });
	const { rateLimits } = await openCodeRateLimits(dataHome);
	assert.equal(rateLimits.primary, null);
	assert.equal(rateLimits.secondary, null);

	const missing = await openCodeUsageLimits(join(dataHome, 'nope'));
	assert.equal(missing.rateLimits.primary, null);
});

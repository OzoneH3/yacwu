import { expect, test } from 'bun:test';
import { accountModels, adapterModels, mergeModelCatalogs } from '../../scripts/claude-backend.mjs';
import { reportedTokenStatistics } from '../../src/lib/protocol';
import { claudeRateLimits, createClaudeUsageReader, normalizeClaudeTokenUsage } from '../../scripts/claude-usage.mjs';
import { analyzeUsage, type UsageEvent } from '../../src/lib/usage-analysis';

test('Claude cache reads become a subset of input without changing totals or double counting', () => {
	const raw = { totalTokens: 1000, inputTokens: 100, cachedInputTokens: 800, outputTokens: 100 };
	const message = { method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: raw, last: raw } } };
	const normalized = normalizeClaudeTokenUsage(message);
	expect(normalized.params?.tokenUsage?.total).toEqual({ ...raw, inputTokens: 900 });
	expect(normalized.params?.tokenUsage?.last?.inputTokens).toBe(900);
	expect(normalizeClaudeTokenUsage(normalized)).toEqual(normalized);
	expect(raw.inputTokens).toBe(100);
});

test('Claude models train task allowance estimates from normalized tokens and weekly quota', () => {
	for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
		const total = normalizeClaudeTokenUsage({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { totalTokens: 1000, inputTokens: 100, cachedInputTokens: 800, outputTokens: 100 } } } }).params?.tokenUsage?.total;
		const events: UsageEvent[] = [
			{ at: 0, host: 'claude', event: 'newThread', threadId: 'task' },
			{ at: 0, host: 'claude', event: 'metadata', threadId: 'task', model, effort: 'medium' },
			{ at: 1, host: 'claude', event: 'turn/started', threadId: 'task', turnId: 'turn' },
			{ at: 2, host: 'claude', event: 'quota', usedPercent: 10, resetsAt: 1000, limitId: 'claude-code' },
			{ at: 3, host: 'claude', event: 'tokens', threadId: 'task', turnId: 'turn', total },
			{ at: 4, host: 'claude', event: 'turn/completed', threadId: 'task', turnId: 'turn' },
			{ at: 5, host: 'claude', event: 'quota', usedPercent: 12, resetsAt: 1000, limitId: 'claude-code' }
		];
		const analysis = analyzeUsage(events, { host: 'claude', settleMs: 0 });
		expect(analysis.tasks[0].tokens).toMatchObject({ inputTokens: 900, cachedInputTokens: 800, totalTokens: 1000 });
		expect(analysis.tasks[0].estimate).toMatchObject({ value: 2, provisional: true });
		expect(analysis.rates[0].model).toBe(model);
		const historical = analyzeUsage(events.map((event) => event.event === 'tokens'
			? { ...event, total: { ...event.total, inputTokens: 100 } } : event), { host: 'claude', settleMs: 0 });
		expect(historical.tasks[0].tokens).toEqual(analysis.tasks[0].tokens);
		expect(historical.tasks[0].estimate).toEqual(analysis.tasks[0].estimate);
	}
});

test('account model discovery pages through available concrete models without inventing IDs', async () => {
	const urls: string[] = [];
	const models = await accountModels({ token: 'test-token', fetchModels: async (url) => {
		urls.push(url);
		return urls.length === 1
			? Response.json({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }], has_more: true, last_id: 'claude-sonnet-5-5' })
			: Response.json({ data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }, { id: null }], has_more: false });
	} });
	expect(models.map((model) => model.sdkModel)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
	expect(urls[1]).toContain('after_id=claude-sonnet-5-5');
});

test('new account models supplement stale CLI aliases while preserving defaults and avoiding duplicate IDs', () => {
	const cli = adapterModels([{ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default' }, { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' }]);
	const account = ['claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) => ({ id, sdkModel: id, displayName: id, description: '', isDefault: false }));
	const models = mergeModelCatalogs(cli, [...account, ...account]);
	expect(models.map((model) => model.id)).toEqual(['default', 'sonnet', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
	expect(models[0].isDefault).toBe(true);
});

test('account model discovery rejects failed reads and invalid pagination for CLI fallback', async () => {
	await expect(accountModels({ token: 'test-token', fetchModels: async () => new Response('', { status: 401 }) })).rejects.toThrow('401');
	await expect(accountModels({ token: 'test-token', fetchModels: async () => Response.json({ data: [], has_more: true }) })).rejects.toThrow('pagination');
});

test('Claude allowance windows preserve percentages and convert reset timestamps', () => {
	const result = claudeRateLimits({
		five_hour: { utilization: 12.5, resets_at: '2026-10-08T15:00:00Z' },
		seven_day: { utilization: 0, resets_at: '2026-10-12T15:00:00Z' }
	}, 'max');
	expect(result.rateLimits.primary).toEqual({ usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1791471600 });
	expect(result.rateLimits.secondary?.usedPercent).toBe(0);
	expect(result.rateLimits.secondary?.windowDurationMins).toBe(10080);
	expect(result.rateLimits.planType).toBe('max');
	expect(claudeRateLimits({ five_hour: { utilization: 101, resets_at: 'invalid' } }).rateLimits.primary).toBeNull();
});

test('Claude quota polling deduplicates requests and retains readings during rate limiting', async () => {
	let time = 1000;
	let calls = 0;
	const read = createClaudeUsageReader({
		credentials: async () => ({ accessToken: 'test-token', subscriptionType: 'max' }),
		now: () => time,
		fetchUsage: async () => {
			calls++;
			return calls === 1
				? Response.json({ five_hour: { utilization: 35, resets_at: '2026-10-08T15:00:00Z' } })
				: new Response('', { status: 429, headers: { 'retry-after': '300' } });
		}
	});
	const results = await Promise.all([read(), read()]);
	expect(calls).toBe(1);
	expect(results[0]).toEqual(results[1]);
	await read();
	expect(calls).toBe(1);
	time += 120001;
	expect((await read()).rateLimits.primary?.usedPercent).toBe(35);
	time += 120001;
	await read();
	expect(calls).toBe(2);
});

test('Claude usage refresh bypasses the cache when its allowance window resets', async () => {
	let calls = 0;
	let time = Date.parse('2026-10-08T14:59:00Z');
	const read = createClaudeUsageReader({
		now: () => time,
		credentials: async () => ({ accessToken: 'test-token', subscriptionType: 'max' }),
		fetchUsage: async () => {
			calls++;
			return Response.json({ five_hour: { utilization: calls === 1 ? 95 : 0, resets_at: '2026-10-08T15:00:00Z' }, seven_day: { utilization: 20, resets_at: '2026-10-15T15:00:00Z' } });
		}
	});
	expect((await read()).rateLimits.primary?.usedPercent).toBe(95);
	expect((await read()).rateLimits.primary?.usedPercent).toBe(95);
	expect(calls).toBe(1);
	time += 60_001;
	expect((await read({ force: true })).rateLimits.primary?.usedPercent).toBe(0);
	expect(calls).toBe(2);
});

test('failed forced Claude usage refresh never presents stale quota as current', async () => {
	let fail = false;
	let time = Date.parse('2026-10-08T14:00:00Z');
	const read = createClaudeUsageReader({
		now: () => time,
		credentials: async () => ({ accessToken: 'test-token', subscriptionType: 'max' }),
		fetchUsage: async () => fail
			? new Response('', { status: 503 })
			: Response.json({ five_hour: { utilization: 95, resets_at: '2026-10-08T15:00:00Z' }, seven_day: { utilization: 20, resets_at: '2026-10-15T15:00:00Z' } })
	});
	expect((await read()).rateLimits.primary?.usedPercent).toBe(95);
	fail = true;
	time += 120_001;
	const refreshed = await read({ force: true });
	expect(refreshed.rateLimits.primary).toBeNull();
	expect(refreshed.rateLimits.secondary).toBeNull();
});

test('fresh usage survives repeated starts and forced reads respect HTTP 429 backoff', async () => {
	let time = Date.parse('2026-10-08T14:00:00Z');
	let calls = 0;
	const read = createClaudeUsageReader({
		now: () => time,
		credentials: async () => ({ accessToken: 'test-token' }),
		fetchUsage: async () => {
			calls++;
			return calls === 1 || calls === 3
				? Response.json({ five_hour: { utilization: 10, resets_at: '2026-10-08T15:00:00Z' }, seven_day: { utilization: 20, resets_at: '2026-10-15T15:00:00Z' } })
				: new Response('', { status: 429, headers: { 'retry-after': '300' } });
		}
	});
	await read();
	for (let i = 0; i < 5; i++) expect((await read({ force: true })).rateLimits.primary?.usedPercent).toBe(10);
	expect(calls).toBe(1);
	time += 120_001;
	const failed = await read({ force: true });
	expect(failed).toMatchObject({ usageError: { code: 'rate_limited' } });
	for (let i = 0; i < 5; i++) await read({ force: true });
	expect(calls).toBe(2);
	time += 300_001;
	expect((await read({ force: true })).rateLimits.primary?.usedPercent).toBe(10);
	expect(calls).toBe(3);
});

test('a reported zero usage percentage remains valid without a reset timestamp', () => {
	const usage = claudeRateLimits({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 12, resets_at: null } });
	expect(usage.rateLimits.primary?.usedPercent).toBe(0);
	expect(usage.rateLimits.primary?.resetsAt).toBeNull();
	expect(usage.rateLimits.secondary?.usedPercent).toBe(12);
});

test('Claude account without subscription credentials reports unavailable usage', async () => {
	let fetched = false;
	const read = createClaudeUsageReader({
		credentials: async () => null,
		fetchUsage: async () => { fetched = true; return Response.json({}); }
	});
	expect((await read()).rateLimits.primary).toBeNull();
	expect(fetched).toBe(false);
});

test('Claude catalog labels resolve versions without treating a date as a minor version', () => {
	const choices = adapterModels([
		{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' },
		{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
		{ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
		{ value: 'custom', displayName: 'Custom model' }
	]);
	expect(choices.map((choice: { displayName: string }) => choice.displayName)).toEqual(['Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5', 'Custom model']);
	expect(choices[0].id).toBe('opus');
	expect(choices[0].sdkModel).toBe('opus');
});

test('usage statistics preserve reported cumulative counters and reject invalid snapshots', () => {
	const total = { totalTokens: 1200, inputTokens: 700, cachedInputTokens: 300, outputTokens: 200 };
	expect(reportedTokenStatistics({ total, last: { totalTokens: 100 } })).toEqual(total);
	expect(reportedTokenStatistics({ total: { ...total, outputTokens: -1 } })).toBeNull();
	expect(reportedTokenStatistics({ last: total })).toBeNull();
});

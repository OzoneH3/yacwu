import { expect, test } from 'bun:test';
import { createClaudeQuotaGuard } from '../../scripts/claude-quota-guard.mjs';

const paused = { threadId: 'thread', turnId: 'paused', reserve: 10, reason: 'Claude 5-hour allowance has 10% remaining.', checkAt: 0, progress: true };

test('a persisted allowance stop resumes exactly once after both allowances recover', async () => {
	let time = 1000, used = 95, reads = 0;
	const sent: any[] = [], replies: any[] = [], saved: any[][] = [];
	const guard = createClaudeQuotaGuard(async () => { reads++; return { rateLimits: { primary: { usedPercent: used }, secondary: { usedPercent: 20 } } }; }, m => sent.push(m), m => replies.push(m), { now: () => time, waiting: [paused], saveWaiting: entries => saved.push(structuredClone(entries)) });
	await guard.poll(); expect(sent).toHaveLength(0);
	time = 2000; await guard.poll(); expect(reads).toBe(1);
	time = 901001; used = 0; await guard.poll();
	expect(sent[0]).toMatchObject({ method: 'thread/read', params: { threadId: 'thread', includeTurns: true } });
	guard.observe({ id: sent[0].id, result: { thread: { turns: [{ id: 'paused', status: 'interrupted' }] } } });
	expect(sent[1]).toMatchObject({ method: 'turn/start', params: { threadId: 'thread' } });
	expect(sent[1].params.input[0].text).toContain('finish only the remaining work');
	expect(sent[1].params.input[0].text).toContain('YACWU_TASK_PROGRESS');
	await guard.poll(); expect(sent).toHaveLength(2);
	guard.observe({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'resumed' } } });
	expect(replies[0].params.item.text).toContain('resumed automatically');
	expect(saved.at(-1)).toEqual([]);
	guard.close();
});

test('manual stops, archive actions and newer turns are never automatically resumed', async () => {
	const sent: any[] = [];
	const healthy = async () => ({ rateLimits: { primary: { usedPercent: 0 }, secondary: { usedPercent: 0 } } });
	const manual = createClaudeQuotaGuard(healthy, m => sent.push(m), () => {});
	manual.observe({ method: 'turn/completed', params: { threadId: 'manual', turn: { id: 'manual-stop', status: 'interrupted' } } });
	await manual.poll(); expect(sent).toHaveLength(0);
	const archived = createClaudeQuotaGuard(healthy, m => sent.push(m), () => {}, { waiting: [paused] });
	await archived.allow({ method: 'thread/archive', params: { threadId: 'thread' } });
	await archived.poll(); expect(sent).toHaveLength(0);
	const newer = createClaudeQuotaGuard(healthy, m => sent.push(m), () => {}, { waiting: [paused] });
	await newer.poll();
	newer.observe({ id: sent[0].id, result: { thread: { turns: [{ id: 'other-work', status: 'completed' }] } } });
	await newer.poll(); expect(sent).toHaveLength(1);
});

test('unknown quota or a still-blocked weekly window prevents automatic starts', async () => {
	for (const secondary of [null, { usedPercent: 95 }]) {
		const sent: any[] = [];
		const guard = createClaudeQuotaGuard(async () => ({ rateLimits: { primary: { usedPercent: 0 }, secondary } }), m => sent.push(m), () => {}, { waiting: [paused] });
		await guard.poll(); expect(sent).toHaveLength(0);
	}
});

test('an unanswered history check is retried without duplicating task starts', async () => {
	let time = 1000;
	const sent: any[] = [];
	const guard = createClaudeQuotaGuard(async () => ({ rateLimits: { primary: { usedPercent: 0 }, secondary: { usedPercent: 0 } } }), m => sent.push(m), () => {}, { waiting: [paused], now: () => time });
	await guard.poll();
	time += 30_001;
	await guard.poll();
	expect(sent.map(m => m.method)).toEqual(['thread/read', 'thread/read']);
	guard.observe({ id: sent[0].id, result: { thread: { turns: [{ id: 'paused', status: 'interrupted' }] } } });
	expect(sent).toHaveLength(2);
	guard.observe({ id: sent[1].id, result: { thread: { turns: [{ id: 'paused', status: 'interrupted' }] } } });
	expect(sent[2].method).toBe('turn/start');
	await guard.poll(); expect(sent).toHaveLength(3);
});

test('start acknowledgement clears persisted resume even without a started notification', async () => {
	const sent: any[] = [], saved: any[][] = [];
	const guard = createClaudeQuotaGuard(async () => ({ rateLimits: { primary: { usedPercent: 0 }, secondary: { usedPercent: 0 } } }), m => sent.push(m), () => {}, { waiting: [paused], saveWaiting: entries => saved.push(structuredClone(entries)) });
	await guard.poll();
	guard.observe({ id: sent[0].id, result: { thread: { turns: [{ id: 'paused', status: 'interrupted' }] } } });
	guard.observe({ id: sent[1].id, result: { turn: { id: 'resumed' } } });
	expect(saved.at(-1)).toEqual([]);
	guard.close();
});

test('unavailable usage after reset retries in two minutes, respecting rate-limit retry times', async () => {
	const now = 1_000_000;
	for (const retryAt of [null, now + 300_000]) {
		const saved: any[][] = [];
		const guard = createClaudeQuotaGuard(async () => ({ rateLimits: { primary: null, secondary: null }, usageError: retryAt ? { retryAt } : null }), () => {}, () => {}, { waiting: [paused], now: () => now, saveWaiting: entries => saved.push(structuredClone(entries)) });
		await guard.poll();
		expect(saved.at(-1)?.[0].checkAt).toBe(retryAt ?? now + 120_000);
	}
});

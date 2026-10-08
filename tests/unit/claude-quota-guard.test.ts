import { expect, test } from 'bun:test';
import { createClaudeQuotaGuard } from '../../scripts/claude-quota-guard.mjs';

const limits = (five: number | null, seven: number | null) => ({ rateLimits: {
	primary: five === null ? null : { usedPercent: five },
	secondary: seven === null ? null : { usedPercent: seven }
} });

function harness(five: number | null, seven: number | null) {
	const sent: any[] = [], replies: any[] = [];
	const guard = createClaudeQuotaGuard(async () => limits(five, seven), (m: any) => sent.push(m), (m: any) => replies.push(m));
	return { guard, sent, replies };
}

test('either Claude window at 90% used blocks new work and reports why', async () => {
	for (const pair of [[90, 0], [0, 90], [100, 20]]) {
		const h = harness(pair[0], pair[1]);
		expect(await h.guard.allow({ id: 8, method: 'turn/start' })).toBe(false);
		expect(h.replies[0].error.message).toContain(pair[0] >= 90 ? '5-hour' : '7-day');
		expect(await h.guard.allow({ method: 'account/read' })).toBe(true);
	}
});

test('unknown allowance blocks starts; both windows above reserve permit them', async () => {
	const unknown = harness(null, 20);
	expect(await unknown.guard.allow({ id: 1, method: 'review/start' })).toBe(false);
	expect(unknown.replies[0].error.message).toContain('Cannot verify');
	const clear = harness(89.99, 89.99);
	expect(await clear.guard.allow({ id: 2, method: 'turn/start' })).toBe(true);
	expect(clear.replies).toHaveLength(0);
});

test('crossing cutoff interrupts active turns once and records the interruption reason', async () => {
	let five = 89;
	const sent: any[] = [], replies: any[] = [];
	const guard = createClaudeQuotaGuard(async () => limits(five, 12), (m: any) => sent.push(m), (m: any) => replies.push(m));
	guard.observe({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
	await new Promise(resolve => setTimeout(resolve, 0));
	five = 90;
	await guard.poll(); await guard.poll();
	expect(sent.filter(x => x.method === 'turn/interrupt')).toHaveLength(1);
	const stop = sent[0];
	expect(guard.observe({ id: stop.id, result: {} })).toBe(true);
	const completed: any = { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } };
	guard.observe(completed);
	expect(completed.params.turn.error.message).toContain('5-hour');
	expect(await guard.allow({ id: 3, method: 'turn/start' })).toBe(false);
	guard.close();
});

test('a failed interrupt can retry, completed work is not stopped, and unrelated turns continue', async () => {
	const h = harness(95, 5);
	h.guard.observe({ method: 'turn/started', params: { threadId: 't', turn: { id: 'a' } } });
	await new Promise(resolve => setTimeout(resolve, 0));
	const first = h.sent[0];
	h.guard.observe({ id: first.id, error: { message: 'temporary failure' } });
	await h.guard.poll();
	expect(h.sent.filter(x => x.method === 'turn/interrupt')).toHaveLength(2);
	h.guard.observe({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'a', status: 'completed' } } });
	h.guard.observe({ method: 'turn/started', params: { threadId: 't', turn: { id: 'b' } } });
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(h.sent.filter(x => x.method === 'turn/interrupt')).toHaveLength(3);
});

test('the browser lockout preference sets the reserve per session and is removed before Claude', async () => {
	const { takeAllowanceReserve } = await import('../../scripts/claude-quota-guard.mjs');
	const start = (text: string) => ({ id: 1, method: 'turn/start', params: { threadId: 't', input: [{ type: 'text', text }] } });
	const marked = start('Do it\n\n<!-- YACWU_ALLOWANCE_RESERVE percent=25 -->');
	expect(takeAllowanceReserve(marked)).toEqual({ reserve: 25, changed: true });
	expect(marked.params.input[0].text).toBe('Do it');
	expect(takeAllowanceReserve(start('Do it\n<!-- YACWU_ALLOWANCE_RESERVE percent=99 -->')).reserve).toBe(50);
	const plain = start('Do it');
	expect(takeAllowanceReserve(plain)).toEqual({ reserve: null, changed: false });
	expect(takeAllowanceReserve({ method: 'account/read' })).toEqual({ reserve: null, changed: false });
});

test('a custom reserve moves the cutoff for new starts; 0 turns the lockout off', async () => {
	const start = { id: 3, method: 'turn/start', params: { threadId: 't' } };
	// 80% used: allowed with the default 10% reserve, blocked with 25%.
	expect(await harness(80, 0).guard.allow(start)).toBe(true);
	const strict = harness(80, 0);
	expect(await strict.guard.allow(start, 25)).toBe(false);
	expect(strict.replies[0].error.message).toContain('blocked at 25% remaining');
	// 92% used: blocked by default, allowed with a 5% reserve.
	expect(await harness(92, 0).guard.allow(start)).toBe(false);
	expect(await harness(92, 0).guard.allow(start, 5)).toBe(true);
	// 0: neither exhausted nor unknown allowance blocks.
	expect(await harness(100, 100).guard.allow(start, 0)).toBe(true);
	expect(await harness(null, null).guard.allow(start, 0)).toBe(true);
});

test('running turns are stopped at their own session reserve', async () => {
	const h = harness(80, 0);
	await h.guard.allow({ id: 4, method: 'turn/start', params: { threadId: 'strict' } }, 25);
	await h.guard.allow({ id: 5, method: 'turn/start', params: { threadId: 'relaxed' } });
	h.guard.observe({ method: 'turn/started', params: { threadId: 'strict', turn: { id: 'turn-strict' } } });
	h.guard.observe({ method: 'turn/started', params: { threadId: 'relaxed', turn: { id: 'turn-relaxed' } } });
	await h.guard.poll();
	const stopped = h.sent.filter((m: any) => m.method === 'turn/interrupt').map((m: any) => m.params.turnId);
	expect(stopped).toEqual(['turn-strict']);
});

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

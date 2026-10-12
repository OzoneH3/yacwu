import { describe, expect, test } from 'bun:test';
import { createDeltaBatcher } from '../../src/lib/delta-batch';

type Msg = { method: string; params?: Record<string, any> };

function setup() {
	const dispatched: Msg[] = [];
	const scheduled: Array<() => void> = [];
	const batcher = createDeltaBatcher<Msg>((msg) => dispatched.push(msg), (flush) => scheduled.push(flush));
	return { batcher, dispatched, scheduled };
}

const delta = (itemId: string, text: string, method = 'item/agentMessage/delta'): Msg =>
	({ method, params: { threadId: 't1', turnId: 'u1', itemId, delta: text } });

describe('createDeltaBatcher', () => {
	test('joins a burst of deltas into one update per item and frame', () => {
		const { batcher, dispatched, scheduled } = setup();
		for (const piece of ['Hel', 'lo', ' wor', 'ld']) expect(batcher.push(delta('a1', piece))).toBe(true);
		expect(batcher.push(delta('r1', 'think', 'item/reasoning/summaryTextDelta'))).toBe(true);
		expect(dispatched).toEqual([]);
		expect(scheduled).toHaveLength(1);
		scheduled[0]();
		expect(dispatched.map((msg) => [msg.method, msg.params?.itemId, msg.params?.delta])).toEqual([
			['item/agentMessage/delta', 'a1', 'Hello world'],
			['item/reasoning/summaryTextDelta', 'r1', 'think']
		]);
		scheduled[0]();
		expect(dispatched).toHaveLength(2);
	});

	test('other notifications are not queued, and flushing first keeps their order', () => {
		const { batcher, dispatched } = setup();
		batcher.push(delta('a1', 'partial'));
		const completed = { method: 'item/completed', params: { threadId: 't1', item: { id: 'a1' } } };
		expect(batcher.push(completed)).toBe(false);
		batcher.flush();
		dispatched.push(completed);
		expect(dispatched.map((msg) => msg.method)).toEqual(['item/agentMessage/delta', 'item/completed']);
	});
});

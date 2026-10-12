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

	test('other notifications are not queued, and flush hands over pending deltas at once', () => {
		const { batcher, dispatched, scheduled } = setup();
		batcher.push(delta('a1', 'partial'));
		expect(batcher.push({ method: 'item/completed', params: { threadId: 't1', item: { id: 'a1' } } })).toBe(false);
		expect(batcher.push({ method: 'item/agentMessage/delta', params: { threadId: 't1' } })).toBe(false);
		batcher.flush(); // the layout does this before handling any other notification
		expect(dispatched.map((msg) => msg.params?.delta)).toEqual(['partial']);
		scheduled[0](); // the frame that was scheduled finds nothing left
		expect(dispatched).toHaveLength(1);
	});
});

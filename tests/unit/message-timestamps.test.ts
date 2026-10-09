import { describe, expect, test } from 'bun:test';
import { createMessageTimestampStore, MESSAGE_TIMESTAMPS_KEY, messageTimestampKey, readMessageTimestamps } from '../../src/lib/message-timestamps';

function memoryStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value)
	};
}

describe('persistent message timestamps', () => {
	test('keys are scoped to both thread and item', () => {
		expect(messageTimestampKey('thread:1', 'item/1')).toBe('thread%3A1:item%2F1');
		expect(messageTimestampKey('thread-1', 'item-1')).not.toBe(messageTimestampKey('thread-2', 'item-1'));
	});

	test('retains the first live timestamp and restores it after creating a new store', () => {
		const storage = memoryStorage();
		const live = createMessageTimestampStore(storage);
		expect(live.save('thread-1', 'item-1', 1_800_000_000_000)).toBe(1_800_000_000_000);
		expect(live.save('thread-1', 'item-1', 1_800_000_001_000)).toBe(1_800_000_000_000);
		const restored = createMessageTimestampStore(storage);
		expect(restored.get('thread-1', 'item-1')).toBe(1_800_000_000_000);
		expect(Object.keys(JSON.parse(storage.getItem(MESSAGE_TIMESTAMPS_KEY)!))).toEqual(['thread-1:item-1']);
	});

	test('ignores malformed, invalid and unavailable saved values', () => {
		expect(readMessageTimestamps('{bad json')).toEqual({});
		expect(readMessageTimestamps(JSON.stringify({ good: 123, zero: 0, bad: '123', infinite: Infinity }))).toEqual({ good: 123 });
		const storage = { getItem: () => null, setItem: () => { throw new Error('storage full'); } };
		expect(createMessageTimestampStore(storage).save('thread', 'item', 123)).toBe(123);
	});
});

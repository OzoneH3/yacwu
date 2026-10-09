export const MESSAGE_TIMESTAMPS_KEY = 'yacwu-message-timestamps';

type TimestampStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readMessageTimestamps(raw: string | null): Record<string, number> {
	try {
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, number] =>
				typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0
			)
		);
	} catch {
		return {};
	}
}

export function messageTimestampKey(threadId: string, itemId: string): string {
	return `${encodeURIComponent(threadId)}:${encodeURIComponent(itemId)}`;
}

export function createMessageTimestampStore(storage: TimestampStorage) {
	const timestamps = readMessageTimestamps(storage.getItem(MESSAGE_TIMESTAMPS_KEY));
	return {
		get(threadId: string, itemId: string): number | undefined {
			return timestamps[messageTimestampKey(threadId, itemId)];
		},
		save(threadId: string, itemId: string, at: number): number | undefined {
			if (!Number.isFinite(at) || at <= 0) return this.get(threadId, itemId);
			const key = messageTimestampKey(threadId, itemId);
			const existing = timestamps[key];
			if (existing !== undefined) return existing;
			timestamps[key] = at;
			try {
				storage.setItem(MESSAGE_TIMESTAMPS_KEY, JSON.stringify(timestamps));
			} catch {
				// Keep the current-page timestamp if browser storage is unavailable.
			}
			return at;
		}
	};
}

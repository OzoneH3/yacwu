/**
 * Memoize a pure function of a message's text. The transcript re-derives
 * every message on each update while only the streaming one has changed.
 * The budget bounds the cached text: a streaming message adds a new, longer
 * key each frame, so the cache clears itself instead of growing with it.
 */
export function textCache<T>(compute: (text: string) => T, budgetChars = 2_000_000): (text: string) => T {
	const cache = new Map<string, T>();
	let chars = 0;
	return (text: string) => {
		const cached = cache.get(text);
		if (cached !== undefined) return cached;
		const value = compute(text);
		if (chars + text.length > budgetChars) {
			cache.clear();
			chars = 0;
		}
		if (text.length <= budgetChars) {
			cache.set(text, value);
			chars += text.length;
		}
		return value;
	};
}

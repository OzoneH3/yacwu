/** A streamed text delta: agent message, reasoning or command output. */
interface DeltaNotification {
	method: string;
	params?: { threadId?: string; turnId?: string; itemId?: string; delta?: unknown; [key: string]: unknown };
}

const DELTA_METHODS = new Set([
	'item/agentMessage/delta',
	'item/reasoning/summaryTextDelta',
	'item/commandExecution/outputDelta'
]);

/**
 * Coalesce streamed deltas so the transcript updates once per frame, not once
 * per SSE message. Each update re-derives the whole transcript, so applying
 * hundreds of deltas a second in a long session queued work faster than the
 * page could do it, and the UI froze until the stream ended. Deltas for one
 * item are joined in order; any other notification flushes first, so it
 * still sees every delta that arrived before it.
 */
export function createDeltaBatcher<T extends DeltaNotification>(
	dispatch: (msg: T) => void,
	schedule: (flush: () => void) => void
) {
	const pending = new Map<string, T>();
	let scheduled = false;

	function flush() {
		scheduled = false;
		if (pending.size === 0) return;
		const batch = [...pending.values()];
		pending.clear();
		for (const msg of batch) dispatch(msg);
	}

	/** Queue `msg` if it is a delta; false means the caller handles it now. */
	function push(msg: T): boolean {
		const params = msg.params;
		if (!DELTA_METHODS.has(msg.method) || !params?.itemId || typeof params.delta !== 'string') return false;
		const key = `${msg.method}\u0000${params.threadId ?? ''}\u0000${params.itemId}`;
		const queued = pending.get(key);
		if (queued) queued.params = { ...queued.params, delta: `${queued.params?.delta ?? ''}${params.delta}` };
		else pending.set(key, { ...msg, params: { ...params } });
		if (!scheduled) {
			scheduled = true;
			schedule(flush);
		}
		return true;
	}

	return { push, flush };
}

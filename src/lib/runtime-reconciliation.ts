/** Loaded does not mean running: adapters can retain interrupted threads. */
export function runtimeOutcome(thread: {
	status?: { type: string };
	turns?: Array<{ id: string; status: string; error?: { message?: string } | null }>;
}): 'running' | 'interrupted' | 'idle' | 'unknown' {
	if (thread.status?.type === 'active') return 'running';
	if (thread.status?.type !== 'idle' && thread.status?.type !== 'notLoaded') return 'unknown';
	const latest = thread.turns?.at(-1);
	return latest?.status === 'interrupted' || latest?.status === 'failed' ? 'interrupted' : 'idle';
}

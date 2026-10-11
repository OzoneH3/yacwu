interface RuntimeThread {
	status?: { type: string };
	turns?: Array<{ id: string; status: string; error?: { message?: string } | null }>;
}

export function interruptionReason(thread: RuntimeThread, loaded: boolean): string {
	if (!loaded) return 'The worker is no longer loaded by the backend; no interruption reason was reported.';
	const reason = thread.turns?.at(-1)?.error?.message?.trim();
	return reason || 'The backend reports that the task was interrupted, but supplied no reason.';
}

/** Loaded does not mean running: adapters can retain interrupted threads. */
export function runtimeOutcome(thread: RuntimeThread): 'running' | 'interrupted' | 'idle' | 'unknown' {
	if (thread.status?.type === 'active') return 'running';
	if (thread.status?.type !== 'idle' && thread.status?.type !== 'notLoaded') return 'unknown';
	const latest = thread.turns?.at(-1);
	// No backend runs a thread it has not loaded: its unfinished turn was cut off.
	if (thread.status?.type === 'notLoaded' && latest?.status === 'inProgress') return 'interrupted';
	return latest?.status === 'interrupted' || latest?.status === 'failed' ? 'interrupted' : 'idle';
}

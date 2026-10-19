/** Positions match /todo and the session tooltip, including the initial task. */
export function removePendingTodo<T extends { tasks: string[]; startedCount: number; initialTask: string | null }>(queue: T | undefined, position: number): { queue: T; removed: string } | { error: string } {
	const index = position - 1 - (queue?.initialTask ? 1 : 0);
	if (!queue || !Number.isSafeInteger(position) || position < 1 || index >= queue.tasks.length) {
		return { error: `Todo ${position} does not exist. Use /todo to see task numbers.` };
	}
	if (index < queue.startedCount) return { error: `Todo ${position} has already started or finished and cannot be removed.` };
	return { queue: { ...queue, tasks: queue.tasks.filter((_, i) => i !== index) }, removed: queue.tasks[index] };
}

export type TodoEntryState = 'done' | 'current' | 'queued';

/**
 * Every task of a session's todo queue with its /todo number and state:
 * finished ("done"), being worked on ("current"), or not started ("queued",
 * the only ones /todo rm can remove). The initial task, when the queue was
 * started from one, is number 1.
 */
export function todoEntries(queue: { tasks: string[]; startedCount: number; initialTask: string | null; currentTask?: unknown } | undefined, running: boolean): Array<{ position: number; task: string; state: TodoEntryState }> {
	if (!queue?.tasks.length) return [];
	const offset = queue.initialTask ? 1 : 0;
	const entries = queue.tasks.map((task, index) => ({
		position: index + 1 + offset,
		task,
		state: (index < queue.startedCount
			? index === queue.startedCount - 1 && queue.currentTask ? 'current' : 'done'
			: 'queued') as TodoEntryState
	}));
	if (queue.initialTask) entries.unshift({ position: 1, task: queue.initialTask, state: queue.startedCount === 0 && running ? 'current' : 'done' });
	return entries;
}

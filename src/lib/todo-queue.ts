/** Positions match /todo and the session tooltip, including the initial task. */
export function removePendingTodo<T extends { tasks: string[]; startedCount: number; initialTask: string | null }>(queue: T | undefined, position: number): { queue: T; removed: string } | { error: string } {
	const index = position - 1 - (queue?.initialTask ? 1 : 0);
	if (!queue || !Number.isSafeInteger(position) || position < 1 || index >= queue.tasks.length) {
		return { error: `Todo ${position} does not exist. Use /todo to see task numbers.` };
	}
	if (index < queue.startedCount) return { error: `Todo ${position} has already started or finished and cannot be removed.` };
	return { queue: { ...queue, tasks: queue.tasks.filter((_, i) => i !== index) }, removed: queue.tasks[index] };
}

import type { ThreadItem } from './protocol';

export function compactActivityLabel(item: ThreadItem): string {
	const group = item as ThreadItem & { count: number; commandsOnly: boolean; status: string; failures: number };
	const noun = group.commandsOnly ? 'command' : 'activity';
	const label = group.count === 1 ? noun : group.commandsOnly ? 'commands' : 'activities';
	return `Background work · ${group.count} ${label} · ${group.status}${group.failures ? ` · ${group.failures} failed` : ''}`;
}

function backgroundActivity(item: ThreadItem): boolean {
	return ['commandExecution', 'fileChange', 'collabAgentToolCall', 'subAgentActivity'].includes(item.type);
}

function failed(item: ThreadItem): boolean {
	const activity = item as { status?: string; exitCode?: number | null };
	return ['failed', 'declined', 'interrupted', 'cancelled'].includes(activity.status ?? '')
		|| (typeof activity.exitCode === 'number' && activity.exitCode !== 0);
}

/** Keep the newest working activity or terminal failure; fold older rows in order. */
export function compactActivity(items: ThreadItem[], expanded: (groupId: string) => boolean, running = true): ThreadItem[] {
	const result: ThreadItem[] = [];
	const latest = items.findLastIndex(backgroundActivity);
	const keepLatest = latest >= 0 && (running || failed(items[latest]));
	let activities: ThreadItem[] = [];
	const flush = () => {
		if (!activities.length) return;
		const id = `activity-group:${activities[0].id}`;
		result.push({ id, type: 'compactActivity', count: activities.length,
			commandsOnly: activities.every((item) => item.type === 'commandExecution'), failures: activities.filter(failed).length,
			status: activities.some((activity) => (activity as { status?: string }).status === 'inProgress') ? 'running' : 'completed' });
		if (expanded(id)) result.push(...activities);
		activities = [];
	};
	for (const [index, item] of items.entries()) {
		if (backgroundActivity(item) && !(index === latest && keepLatest)) activities.push(item);
		else { flush(); result.push(item); }
	}
	flush();
	return result;
}

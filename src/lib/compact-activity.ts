import type { ThreadItem } from './protocol';

/** Only known successful/running commands are routine; failures stay visible. */
function routineCommand(item: ThreadItem): boolean {
	if (item.type !== 'commandExecution') return false;
	const command = item as { status?: string; exitCode?: number | null };
	return (command.status === 'completed' || command.status === 'inProgress')
		&& (command.exitCode == null || command.exitCode === 0);
}

/** Group adjacent commands without moving messages, questions or file changes. */
export function compactActivity(items: ThreadItem[], expanded: (groupId: string) => boolean): ThreadItem[] {
	const result: ThreadItem[] = [];
	let commands: ThreadItem[] = [];
	const flush = () => {
		if (!commands.length) return;
		const id = `activity-group:${commands[0].id}`;
		result.push({ id, type: 'compactActivity', count: commands.length,
			status: commands.some((command) => (command as { status?: string }).status === 'inProgress') ? 'running' : 'completed' });
		if (expanded(id)) result.push(...commands);
		commands = [];
	};
	for (const item of items) {
		if (routineCommand(item)) commands.push(item);
		else { flush(); result.push(item); }
	}
	flush();
	return result;
}

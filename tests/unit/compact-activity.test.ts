import { expect, test } from 'bun:test';
import { compactActivity } from '../../src/lib/compact-activity';
import type { ThreadItem } from '../../src/lib/protocol';

const command = (id: string, status = 'completed', exitCode: number | null = 0): ThreadItem => ({ id, type: 'commandExecution', status, exitCode, command: id });

test('compact groups preserve visible messages, questions, file changes and command failures in order', () => {
	const items: ThreadItem[] = [{ id: 'question', type: 'agentMessage', text: 'Which file?' }, command('one'), command('two'), { id: 'file', type: 'fileChange', changes: [] }, command('failed', 'failed', 1), command('nonzero', 'completed', 2), command('interrupted', 'interrupted'), command('three'), { id: 'answer', type: 'agentMessage', text: 'Done' }];
	expect(compactActivity(items, () => false).map((item) => item.id)).toEqual(['question', 'activity-group:one', 'file', 'failed', 'nonzero', 'interrupted', 'activity-group:three', 'answer']);
	expect(compactActivity(items, () => false)[1]).toMatchObject({ count: 2, status: 'completed' });
	const expanded = compactActivity(items, (id) => id === 'activity-group:one');
	expect(expanded.slice(2, 4)).toEqual(items.slice(1, 3));
	expect(items).toHaveLength(9);
});

test('live command groups retain their key and update status as commands finish', () => {
	const running = compactActivity([command('one'), command('two', 'inProgress', null)], () => false);
	const completed = compactActivity([command('one'), command('two')], () => false);
	expect(running[0]).toMatchObject({ id: 'activity-group:one', count: 2, status: 'running' });
	expect(completed[0]).toMatchObject({ id: 'activity-group:one', count: 2, status: 'completed' });
});

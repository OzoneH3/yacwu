import { expect, test } from 'bun:test';
import { compactActivity, compactActivityLabel } from '../../src/lib/compact-activity';
import type { ThreadItem } from '../../src/lib/protocol';

const command = (id: string, status = 'completed', exitCode: number | null = 0): ThreadItem => ({ id, type: 'commandExecution', status, exitCode, command: id });

test('finished work backgrounds a successful final row but retains a terminal failure', () => {
	expect(compactActivity([command('ok')], () => false, false).map((item) => item.type)).toEqual(['compactActivity']);
	expect(compactActivity([command('failed', 'failed', 1)], () => false, false).map((item) => item.id)).toEqual(['failed']);
});

test('older commands, failures and files fold away while messages and newest activity remain ordered', () => {
	const items: ThreadItem[] = [{ id: 'question', type: 'agentMessage', text: 'Which file?' }, command('one'), command('two'), { id: 'file', type: 'fileChange', changes: [] }, command('failed', 'failed', 1), command('nonzero', 'completed', 2), command('interrupted', 'interrupted'), command('three'), { id: 'answer', type: 'agentMessage', text: 'Done' }];
	expect(compactActivity(items, () => false).map((item) => item.id)).toEqual(['question', 'activity-group:one', 'three', 'answer']);
	expect(compactActivity(items, () => false)[1]).toMatchObject({ count: 6, status: 'completed', failures: 3, commandsOnly: false });
	const expanded = compactActivity(items, (id) => id === 'activity-group:one');
	expect(expanded.slice(2)).toEqual(items.slice(1));
	expect(items).toHaveLength(9);
});

test('new activity backgrounds the previous row, while the final failed test stays visible', () => {
	const items = [command('one'), command('test', 'failed', 1)];
	expect(compactActivity(items, () => false).map((item) => item.id)).toEqual(['activity-group:one', 'test']);
	const next = compactActivity([...items, { id: 'agent', type: 'subAgentActivity' }], () => false);
	expect(next.map((item) => item.id)).toEqual(['activity-group:one', 'agent']);
	expect(next[0]).toMatchObject({ count: 2, failures: 1 });
	expect(compactActivityLabel(next[0])).toBe('Background work · 2 commands · 1 failed');
	const more = compactActivity([...items, { id: 'agent', type: 'subAgentActivity' }, { id: 'collab', type: 'collabAgentToolCall' }, command('last')], () => false);
	expect(more[0]).toMatchObject({ count: 4, commandsOnly: false });
});

test('background labels omit completed while retaining running status', () => {
	const complete = compactActivity([command('one')], () => false, false)[0];
	expect(compactActivityLabel(complete)).toBe('Background work · 1 command');
	const running = compactActivity([command('one', 'inProgress'), command('two')], () => false)[0];
	expect(compactActivityLabel(running)).toBe('Background work · 1 command · running');
});

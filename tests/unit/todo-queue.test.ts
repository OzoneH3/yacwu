import { expect, test } from 'bun:test';
import { removePendingTodo } from '../../src/lib/todo-queue';
import { parseSlash } from '../../src/lib/slash';

test('rm parses only positive integer task numbers', () => {
	expect(parseSlash('/todo rm 1')).toEqual({ kind: 'todo-remove', position: 1 });
	for (const value of ['', '0', '-1', '1.5', 'two', '1 extra', '99999999999999999999']) {
		expect(parseSlash(`/todo rm ${value}`)).toEqual({ kind: 'unknown', command: '/todo rm' });
	}
});

test('only pending tasks can be removed, preserving started work and ordering', () => {
	const queue = { tasks: ['finished', 'current', 'pending', 'last'], startedCount: 2, initialTask: null, currentTask: 'current' };
	expect(removePendingTodo(queue, 1)).toHaveProperty('error');
	expect(removePendingTodo(queue, 2)).toHaveProperty('error');
	expect(removePendingTodo(queue, 3)).toEqual({ queue: { ...queue, tasks: ['finished', 'current', 'last'] }, removed: 'pending' });
	expect(queue.tasks).toHaveLength(4);
	for (const n of [0, -1, 5, 1.5]) expect(removePendingTodo(queue, n)).toHaveProperty('error');
	expect(removePendingTodo(undefined, 1)).toHaveProperty('error');
});

test('initial running prompt occupies position one and cannot be removed', () => {
	const queue = { tasks: ['pending', 'last'], startedCount: 0, initialTask: 'Original prompt' };
	expect(removePendingTodo(queue, 1)).toHaveProperty('error');
	expect(removePendingTodo(queue, 2)).toEqual({ queue: { ...queue, tasks: ['last'] }, removed: 'pending' });
	expect(removePendingTodo({ ...queue, initialTask: null }, 1)).toEqual({ queue: { ...queue, initialTask: null, tasks: ['last'] }, removed: 'pending' });
});

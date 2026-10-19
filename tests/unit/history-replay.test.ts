import { expect, test } from 'bun:test';
import { replayHistory } from '../../src/lib/history-replay';
import type { ThreadItem, Turn } from '../../src/lib/protocol';

test('history clears old Resume actions but preserves the latest turn and source objects', () => {
 const old = { type: 'localNote', id: 'old', resumeAvailable: true };
 const latest = { type: 'localNote', id: 'latest', resumeAvailable: true };
 const turns: Turn[] = [{ id: 'a', status: 'completed', items: [old] }, { id: 'b', status: 'inProgress', items: [latest] }];
 const visited: { item: ThreadItem; turn: string }[] = [];
 replayHistory(turns, (item, turn) => visited.push({ item, turn: turn.id }));
 expect(visited).toEqual([{ item: { ...old, resumeAvailable: false }, turn: 'a' }, { item: latest, turn: 'b' }]);
 expect(old.resumeAvailable).toBe(true);
 expect(visited[1].item).toBe(latest);
});

test('an empty subsequent turn still clears the previous Resume action', () => {
 const items: ThreadItem[] = [];
 replayHistory([{ id: 'a', status: 'completed', items: [{ type: 'localNote', id: 'stop', resumeAvailable: true }] }, { id: 'b', status: 'inProgress' }], item => items.push(item));
 expect(items).toEqual([{ type: 'localNote', id: 'stop', resumeAvailable: false }]);
});

import { expect, test } from 'bun:test';
import { transcriptWindow } from '../../src/lib/transcript-window';
test('completion collapsing rows cannot strand the viewport past the transcript', () => {
	const items = ['earlier message', 'collapsed commands', 'final response'];
	const view = transcriptWindow(items, () => 72, 24000, 600, 700, false);
	expect(view.items).toEqual(items);
	expect(view.before).toBe(0);
	expect(view.after).toBe(0);
	const longer = Array.from({ length: 30 }, (_, i) => i);
	const tail = transcriptWindow(longer, () => 72, 24000, 600, 700, false);
	expect(tail.items.length).toBeGreaterThan(0);
	expect(tail.items.at(-1)).toBe(29);
});
test('keeps a valid reading position and bottom intent in long histories', () => {
	const items = Array.from({ length: 100 }, (_, i) => i);
	const view = transcriptWindow(items, () => 100, 4500, 500, 100, false);
	expect(view.items[0]).toBe(43);
	expect(view.before).toBe(4300);
	expect(view.before + view.after + view.items.length * 100).toBe(10000);
	expect(transcriptWindow(items, () => 100, 0, 500, 100, true).items.at(-1)).toBe(99);
	expect(transcriptWindow([], () => 100, 9000, 500, 100, false)).toEqual({ items: [], before: 0, after: 0, total: 0 });
});

import { expect, test } from 'bun:test';
import { saveTodoAttachments, restoreTodoAttachments, validTodoAttachments } from '../../src/lib/todo-attachments';

test('todo files and images round-trip through JSON without changing bytes or metadata', async () => {
	const input = [
		{ file: new File(['task notes ☀'], 'notes.txt', { type: 'text/plain' }), name: 'notes.txt', kind: 'file' as const },
		{ file: new File([new Uint8Array([0, 255, 32, 128])], 'image.png', { type: 'image/png' }), name: 'image.png', kind: 'image' as const }
	];
	const saved = JSON.parse(JSON.stringify(await saveTodoAttachments(input)));
	expect(validTodoAttachments([saved])).toBe(true);
	const restored = restoreTodoAttachments(saved);
	for (let i = 0; i < input.length; i++) {
		expect(restored[i].name).toBe(input[i].name);
		expect(restored[i].kind).toBe(input[i].kind);
		expect(restored[i].file.type).toBe(input[i].file.type);
		expect(await restored[i].file.arrayBuffer()).toEqual(await input[i].file.arrayBuffer());
	}
	expect(validTodoAttachments([[{ name: 'broken' }]])).toBe(false);
	expect(validTodoAttachments({})).toBe(false);
});

import { describe, expect, test } from 'bun:test';
import { textCache } from '../../src/lib/text-cache';

describe('textCache', () => {
	test('reuses results per text and stays within its budget while text grows', () => {
		let calls = 0;
		const cached = textCache((text: string) => ({ length: text.length, call: ++calls }), 100);
		const first = cached('hello');
		expect(cached('hello')).toBe(first);
		expect(calls).toBe(1);
		// A streaming message: each frame is a new, longer text.
		let text = '';
		for (let i = 0; i < 50; i++) cached((text += 'xx'));
		// The budget forced a clear, so the old entry is gone and recomputed.
		expect(cached('hello')).not.toBe(first);
		expect(cached('y'.repeat(500)).length).toBe(500);
	});
});

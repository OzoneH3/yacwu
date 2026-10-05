import { describe, expect, test } from 'bun:test';
import { detectPromptKind, parseInteractiveChoice } from '../../src/lib/interactive-choice';

describe('parseInteractiveChoice', () => {
	test('recognizes a question followed by numbered options', () => {
		expect(parseInteractiveChoice('Which approach should I take?\n1. **Fix the bug**\n2. Add a regression test')).toEqual({
			question: 'Which approach should I take?',
			options: ['Fix the bug', 'Add a regression test']
		});
	});

	test('recognizes a question after context and blank lines', () => {
		expect(parseInteractiveChoice('I found two likely causes.\n\nWhat should I investigate?\n- The frontend\n- The server')).toEqual({
			question: 'What should I investigate?',
			options: ['The frontend', 'The server']
		});
	});

	test('ignores ordinary questions and oversized option lists', () => {
		expect(parseInteractiveChoice('Should I continue?')).toBeNull();
		expect(parseInteractiveChoice('Which one?\n- A\n- B\n- C\n- D\n- E\n- F\n- G')).toBeNull();
	});

	test('classifies freeform questions as unknown prompts', () => {
		expect(detectPromptKind('Which directory should I use?')).toBe('unknown');
		expect(detectPromptKind('Which approach should I take?\n- Fix the bug\n- Add a test')).toBe('choice');
		expect(detectPromptKind('The changes are ready.')).toBeNull();
	});
});

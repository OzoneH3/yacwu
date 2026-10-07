import { describe, expect, test } from 'bun:test';
import { detectPromptKind, parseInteractiveChoice, parseInteractiveQuestion, parseInteractiveQuestions, pendingQuestionsForThread } from '../../src/lib/interactive-choice';

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
		expect(parseInteractiveQuestion('Should I continue?')).toEqual({ question: 'Should I continue?', options: [] });
		expect(parseInteractiveChoice('Which one?\n- A\n- B\n- C\n- D\n- E\n- F\n- G')).toBeNull();
	});

	test('recognizes freeform questions followed by a proposed default', () => {
		const message = 'What is the measured distance from the mounting face to the metal grille? I can build an adjustable prototype assuming the flange sits 25 mm inside the grille.';
		expect(parseInteractiveQuestion(message)).toEqual({
			question: 'What is the measured distance from the mounting face to the metal grille?',
			options: []
		});
		expect(detectPromptKind(message)).toBe('choice');
		expect(detectPromptKind('Which directory should I use?')).toBe('choice');
		expect(detectPromptKind('Which approach should I take?\n- Fix the bug\n- Add a test')).toBe('choice');
		expect(detectPromptKind('The changes are ready.')).toBeNull();
	});

	test('research conclusions are not options because of request words elsewhere in the report', () => {
		const summary = 'Please review the current policy.\n\nThe resolver can select strategy after removing user intent.\n\nThis recommendation rests on three product considerations:\n\n1. Existing UI already explains automatic resume.\n2. Manual adjustments do not communicate rejection.\n3. Explicit resume adds complexity.';
		expect(parseInteractiveQuestions(summary)).toEqual([]);
		expect(detectPromptKind(summary)).toBeNull();
		expect(parseInteractiveChoice('What were the results?\n\nAll checks passed.\n\nEvidence:\n- Compiler succeeded\n- Tests passed')).toBeNull();
		expect(parseInteractiveQuestions('| Question | Answer |\n|---|---|\n| 1. Does current strategy auto-resume? | Yes, when eligible. |\n\nSTRATEGY_LIFECYCLE_PLAN_READY')).toEqual([]);
	});

	test('preserves adjacent action requests and multiple choice blocks, while ignoring code examples', () => {
		expect(parseInteractiveQuestions('Please configure Cycle mode. After saving, tell me whether the fan is running.\n\n- Saved; running\n- Saved; stopped\n- Not configured yet')).toHaveLength(1);
		expect(parseInteractiveQuestions('Is the physical fan stopped?\n- Yes\n- No\n\nAfter capture, authorize the retention test?\n- Authorize\n- Leave pending')).toHaveLength(2);
		expect(parseInteractiveQuestions('Example:\n```text\nWhich option?\n- A\n- B\n```\nThe report is complete.')).toEqual([]);
	});

	test('resolved questions clear the badge queue while retaining other unanswered questions', () => {
		const items = [{ type: 'userMessage', id: 'user' },
			{ type: 'agentMessage', id: 'answer', _completed: true, text: 'Which option?\n- A\n- B\n\nShould I continue?\n- Yes\n- No' },
			{ type: 'agentMessage', id: 'status', _completed: true, text: 'The passive capture is running.' }];
		expect(pendingQuestionsForThread(items, 'thread', {})).toHaveLength(2);
		expect(pendingQuestionsForThread(items, 'thread', { 'thread:answer:0': true })).toEqual([
			{ id: 'answer:1', threadId: 'thread', question: 'Should I continue?', options: ['Yes', 'No'] }
		]);
		expect(pendingQuestionsForThread(items, 'thread', { 'thread:answer:0': true, 'thread:answer:1': true })).toEqual([]);
		expect(pendingQuestionsForThread([...items, { type: 'userMessage', id: 'reply' }], 'thread', {})).toEqual([]);
	});
});

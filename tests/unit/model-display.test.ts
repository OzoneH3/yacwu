import { describe, expect, test } from 'bun:test';
import { filterAndSortModelChoices } from '../../src/lib/model-display';

const models = [
	{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
	{ id: 'gpt-6-astra', displayName: 'GPT-6 Astra' },
	{ id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
	{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
	{ id: 'gpt-6-luna', displayName: 'GPT-6 Luna' },
	{ id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
	{ id: 'gpt-6-sol', displayName: 'GPT-6 Sol' }
];

describe('model display ranking', () => {
	test('hides known dominated models and sorts by efficiency then capability', () => {
		expect(filterAndSortModelChoices(models).map((model) => model.id)).toEqual([
			'gpt-6-luna',
			'gpt-6.1-sol',
			'gpt-6-astra'
		]);
	});

	test('keeps unranked backend models available after ranked choices', () => {
		const choices = [...models, { id: 'custom-model', displayName: 'Custom Model' }];
		const visible = filterAndSortModelChoices(choices);
		expect(visible.at(-1)?.id).toBe('custom-model');
	});
});

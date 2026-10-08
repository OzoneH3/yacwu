import { describe, expect, test } from 'bun:test';
import { filterAndSortModelChoices, modelDisplayProfile } from '../../src/lib/model-display';

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
	test('removes Codex proxy choices from Claude catalogs without changing Codex catalogs', () => {
		const claude = [
			{ id: 'sonnet', displayName: 'Claude Sonnet' },
			{ id: 'claude-opus-4-6', displayName: 'Claude Opus' }
		];
		expect(filterAndSortModelChoices([...models, ...claude, { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini' }])).toEqual(claude);
		expect(filterAndSortModelChoices(models).map((choice) => choice.id)).toContain('gpt-6.1-sol');
	});
	test('rates value by capability per estimated allowance use', () => {
		expect(models.map((model) => [model.id, modelDisplayProfile(model)?.valueRating])).toEqual([
			['gpt-5.6-sol', 2],
			['gpt-6-astra', 1],
			['gpt-5.6-luna', 4.5],
			['gpt-6.1-sol', 3],
			['gpt-6-luna', 5],
			['gpt-5.6-terra', 3],
			['gpt-6-sol', 2.5]
		]);
	});

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

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
		expect(filterAndSortModelChoices([...models, ...claude, { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini' }])).toEqual([claude[1], claude[0]]);
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

	test('rates resolved Claude aliases, dated IDs, dotted versions, and extended context variants', () => {
		for (const choice of [
			{ id: 'haiku', displayName: 'Claude Haiku 4.5' },
			{ id: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
			{ id: 'claude-haiku-4.5', displayName: 'Haiku' }
		]) expect(modelDisplayProfile(choice)).toMatchObject({ capability: 65, efficiency: 'Excellent', valueRating: 4 });
		expect(modelDisplayProfile({ id: 'default', displayName: 'Claude Opus 5.5 (default)' })).toMatchObject({ capability: 98 });
		expect(modelDisplayProfile({ id: 'sonnet[1m]', displayName: 'Claude Sonnet 5 · 1M' })).toMatchObject({ capability: 84 });
		expect(modelDisplayProfile({ id: 'claude-sonnet-5-5[1m]', displayName: 'Sonnet' })).toMatchObject({ capability: 93 });
		expect(modelDisplayProfile({ id: 'claude-opus-4-6', displayName: 'Claude Opus 5.5' })).toMatchObject({ capability: 81 });
	});

	test('does not guess ratings for floating aliases or unresearched versions', () => {
		for (const id of ['sonnet', 'claude-opus-6', 'claude-sonnet-5-6', 'claude-opus-5-50', 'claude-mythos-5-1']) {
			expect(modelDisplayProfile({ id, displayName: id })).toBeNull();
		}
	});

	test('sorts the current Claude tradeoffs and hides older dominated versions', () => {
		const choices = [
			{ id: 'opus', displayName: 'Claude Opus 5.5' },
			{ id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' },
			{ id: 'haiku', displayName: 'Claude Haiku 4.5' },
			{ id: 'sonnet', displayName: 'Claude Sonnet 5' },
			...['opus-5', 'opus-4-8', 'opus-4-7', 'opus-4-6', 'sonnet-4-6', 'fable-5'].map((name) => ({ id: `claude-${name}`, displayName: name }))
		];
		expect(filterAndSortModelChoices(choices).map((choice) => choice.id)).toEqual(['haiku', 'sonnet', 'opus', 'claude-fable-5-1']);
		expect(modelDisplayProfile(choices[0])?.estimateBasis).toContain('not measured subscription allowance');
	});

	test('newer Claude models replace older tradeoffs only when offered by the backend', () => {
		const choices = ['fable-5-1', 'opus-5-5', 'sonnet-5', 'sonnet-5-5', 'haiku-4-5', 'haiku-5-5', 'experimental-model'].map((name) => ({ id: `claude-${name}`, displayName: name }));
		expect(filterAndSortModelChoices(choices).map((choice) => choice.id)).toEqual([
			'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-experimental-model'
		]);
	});

	test('removes Claude default and duplicate aliases while retaining context variants', () => {
		const choices = [
			{ id: 'default', displayName: 'Claude Opus 5.5 (default)' },
			{ id: 'opus', displayName: 'Claude Opus 5.5' },
			{ id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
			{ id: 'sonnet', displayName: 'Claude Sonnet 5.5' },
			{ id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
			{ id: 'claude-sonnet-5-5[1m]', displayName: 'Claude Sonnet 5.5 · 1M' }
		];
		expect(filterAndSortModelChoices(choices).map((choice) => choice.id)).toEqual([
			'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'claude-opus-5-5'
		]);
	});
});

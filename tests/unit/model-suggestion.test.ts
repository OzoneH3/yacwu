import { expect, test } from 'bun:test';
import { suggestPromptSettings } from '../../src/lib/model-suggestion';

const models = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map(id => ({
	id, displayName: id, defaultEffort: 'medium', efforts: ['low', 'medium', 'high']
}));

test('does not suggest for an empty draft or empty catalog', () => {
	expect(suggestPromptSettings('', models)).toBeNull();
	expect(suggestPromptSettings('hello', [])).toBeNull();
});
test('short scoped edits use efficient settings', () => {
	expect(suggestPromptSettings('Center the archive button', models)).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
});
test('technical work uses capable settings and demanding correctness uses strongest', () => {
	expect(suggestPromptSettings('Investigate a race condition', models)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
	expect(suggestPromptSettings('Prove correctness of distributed consensus', models)).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
});
test('general and attachment-only drafts use balanced settings', () => {
	expect(suggestPromptSettings('Help with this', models)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
	expect(suggestPromptSettings('', models, 1)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
});
test('only suggests available models and supported efforts, including unknown catalogs', () => {
	const limited = [{ ...models[0], efforts: ['low'] }];
	expect(suggestPromptSettings('Prove correctness', limited)).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
	expect(suggestPromptSettings('hello', [{ id: 'custom', displayName: 'Custom', efforts: ['max'], defaultEffort: 'max' }])).toMatchObject({ model: 'custom', effort: 'max' });
});

test('Claude suggestions use Haiku for scoped edits, Sonnet for routine work, Opus for complexity, and Fable for demanding reasoning', () => {
	const claude = [
		{ id: 'opus', displayName: 'Claude Opus 5.5' },
		{ id: 'sonnet', displayName: 'Claude Sonnet 5' },
		{ id: 'haiku', displayName: 'Claude Haiku 4.5' },
		{ id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' }
	].map((choice) => ({ ...choice, defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] }));
	expect(suggestPromptSettings('Center the archive button', claude)).toMatchObject({ model: 'haiku', effort: 'low' });
	expect(suggestPromptSettings('Help with this', claude)).toMatchObject({ model: 'sonnet', effort: 'medium' });
	expect(suggestPromptSettings('Investigate a race condition', claude)).toMatchObject({ model: 'opus', effort: 'high' });
	expect(suggestPromptSettings('Prove correctness of distributed consensus', claude)).toMatchObject({ model: 'claude-fable-5-1', effort: 'high' });
	expect(suggestPromptSettings('Prove correctness', claude.filter((choice) => choice.id !== 'claude-fable-5-1'))).toMatchObject({ model: 'opus' });
});

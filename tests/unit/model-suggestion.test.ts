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

test('new Claude versions preserve task tiers and use Claude guidance', () => {
	const claude = ['haiku', 'sonnet', 'opus'].map(family => ({
		id: `claude-${family}-5-5`, displayName: `Claude ${family} 5.5`,
		efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'medium'
	}));
	expect(suggestPromptSettings('Help with this', claude)).toMatchObject({model: 'claude-sonnet-5-5', effort: 'medium'});
	expect(suggestPromptSettings('Investigate a race condition', claude)).toMatchObject({model: 'claude-opus-5-5', effort: 'high'});
	expect(suggestPromptSettings('Rename the label', claude)?.guidanceUrl).toContain('platform.claude.com');
});
test('models without effort settings can still be suggested without invented thinking', () => {
	const result = suggestPromptSettings('Rename the label', [{id:'claude-haiku-5-5', displayName:'Claude Haiku 5.5', efforts:[], defaultEffort:''}]);
	expect(result?.effort).toBe('');
	expect(result?.reason).toContain('does not advertise');
	expect(result?.reason).not.toContain('low thinking');
});
test('reason describes the actual supported effort instead of an unavailable requested level', () => {
	const result = suggestPromptSettings('Investigate a race condition', [{...models[0], efforts:['low']}]);
	expect(result?.reason).toContain('supported low effort');
	expect(result?.reason).not.toContain('deeper thinking');
});

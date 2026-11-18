import { expect, test } from 'bun:test';
import { availableModelUpgrade } from '../../src/lib/model-display';
const model = (id: string, displayName = id) => ({ id, displayName });
test('finds a replacement for old models without flagging efficient tradeoffs', () => {
	const choices = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.2-astra'].map(id => model(id));
	expect(availableModelUpgrade(model('gpt-6.1-sol'), choices)?.id).toBe('gpt-6.2-sol');
	expect(availableModelUpgrade(model('gpt-6-astra'), choices)?.id).toBe('gpt-6.2-astra');
	expect(availableModelUpgrade(model('gpt-6-luna'), choices)).toBeNull();
	expect(availableModelUpgrade(model('gpt-6.2-sol'), choices)).toBeNull();
	expect(availableModelUpgrade(model('custom'), choices)).toBeNull();
	expect(availableModelUpgrade(model('gpt-6.1-sol'), [model('gpt-6.1-sol')])).toBeNull();
});
test('compares Claude aliases by rating and keeps provider pricing separate', () => {
	expect(availableModelUpgrade(model('opus', 'Claude Opus 5.5'), [model('claude-opus-5-5', 'Claude Opus 5.5')])).toBeNull();
	expect(availableModelUpgrade(model('sonnet', 'Claude Sonnet 5'), [model('claude-sonnet-5-5', 'Claude Sonnet 5.5')])?.id).toBe('claude-sonnet-5-5');
	expect(availableModelUpgrade(model('copilot/gpt-6-sol'), [model('copilot/gpt-6.1-sol')])?.id).toBe('copilot/gpt-6.1-sol');
	expect(availableModelUpgrade(model('copilot/gpt-6.1-sol'), [model('copilot/gpt-6.2-sol')])).toBeNull();
	expect(availableModelUpgrade(model('opencode/openai/gpt-6.1-sol'), [model('opencode/openai/gpt-6.2-sol')])?.id).toBe('opencode/openai/gpt-6.2-sol');
	expect(availableModelUpgrade(model('opencode/openai/gpt-6.1-sol'), [model('opencode/opencode-go/gpt-6.2-sol')])).toBeNull();
});

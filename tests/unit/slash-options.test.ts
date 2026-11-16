import { expect, test } from 'bun:test';
import { slashArgumentChoices } from '../../src/lib/slash';
const context = { providers: ['codex', 'opencode'], models: [{ id: 'gpt-6-luna', displayName: 'GPT-6 Luna', efforts: ['low', 'medium'] }, { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: ['high', 'xhigh'] }], currentModel: 'gpt-6-luna', profiles: ['fast', 'deep review'] };
const values = (input: string) => slashArgumentChoices(input, context).map(c => c.completion);
test('fixed provider and access options filter case-insensitively and exclude disabled providers', () => {
    expect(values('/fork ')).toEqual(['/fork codex', '/fork opencode']);
    expect(values('/fork OP')).toEqual(['/fork opencode']);
    expect(values('/mode r')).toEqual(['/mode r', '/mode rw']);
    expect(values('/mode rw')).toEqual(['/mode rw']);
});
test('models and effort options come from the selected catalog', () => {
    expect(values('/model luna')).toContain('/model gpt-6-luna ');
    expect(values('/model --effort ')).toEqual(['/model --effort low', '/model --effort medium']);
    expect(values('/model gpt-6.1-sol x')).toEqual(['/model gpt-6.1-sol xhigh']);
    expect(values('/model missing ')).toEqual([]);
});
test('fixed subcommands coexist with free-form arguments and existing todo picker', () => {
    expect(values('/todo c')).toEqual(['/todo clear']);
    expect(values('/todo r')).toEqual(['/todo rm ']);
    expect(values('/todo rm')).toEqual([]);
    expect(values('/todo rm ')).toEqual([]);
    expect(values('/goal --b')).toEqual(['/goal --budget ']);
    expect(values('/profile deep')).toEqual(['/profile deep review']);
    expect(values('/review please')).toEqual([]);
    expect(values('/todo investigate bug')).toEqual([]);
    expect(values('/fork opencode\nmore')).toEqual([]);
});

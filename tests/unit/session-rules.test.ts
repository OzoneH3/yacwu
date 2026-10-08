import { expect, test } from 'bun:test';
import { defaultSessionRules, readSessionRules, withSessionRules } from '../../src/lib/session-rules';
import { visibleUserText, withSharedChannelContext } from '../../src/lib/shared-channel';

test('session rules tolerate corrupt storage and preserve separate session settings', () => {
	expect(readSessionRules('bad')).toEqual({});
	expect(readSessionRules(JSON.stringify({ a: { progress: false, custom: 'Check README' }, b: {} }))).toEqual({ a: { progress: false, sharedChannel: true, custom: 'Check README' }, b: defaultSessionRules });
});

test('custom rules remain hidden from prompt presentation without dropping coordination instructions', () => {
	const text = withSessionRules(withSharedChannelContext('Do work', '/tmp/shared', 'a'), { progress: false, sharedChannel: true, custom: 'Always review README before committing.' });
	expect(text).toContain('Shared folder: /tmp/shared');
	expect(text).toContain('do not emit Yacwu progress markers');
	expect(text).toContain('Always review README before committing.');
	expect(visibleUserText(text)).toBe('Do work');
	expect(visibleUserText(withSessionRules('Do work', { ...defaultSessionRules, custom: 'Rule' }))).toBe('Do work');
	expect(withSessionRules('Do work', defaultSessionRules)).toBe('Do work');
});

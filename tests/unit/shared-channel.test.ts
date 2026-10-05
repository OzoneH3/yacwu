import { describe, expect, test } from 'bun:test';
import {
	hasSharedChannelContext,
	sharedChannelPath,
	visibleUserText,
	withSharedChannelContext
} from '../../src/lib/shared-channel';

describe('shared background channel', () => {
	test('sessions in the same normalized workspace and host share one opaque path', () => {
		const path = sharedChannelPath('local', '/work/project/');
		expect(path).toMatch(/^\/tmp\/yacwu-background-[0-9a-f]{16}$/);
		expect(sharedChannelPath('local', '/work//project')).toBe(path);
		expect(sharedChannelPath('remote', '/work/project')).not.toBe(path);
		expect(sharedChannelPath('local', '/work/other')).not.toBe(path);
	});

	test('channel instructions are added once and stripped from transcript text', () => {
		const prompt = 'Implement the feature';
		const withContext = withSharedChannelContext(prompt, '/tmp/shared', 'thread-a');
		expect(hasSharedChannelContext(withContext)).toBe(true);
		expect(withContext).toContain('Your session ID: thread-a');
		expect(visibleUserText(withContext)).toBe(prompt);
		expect(visibleUserText(withContext.replace('\n\n<!--', '<!--'))).toBe(prompt);
		expect(visibleUserText(prompt)).toBe(prompt);
	});
});

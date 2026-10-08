import { describe, expect, test } from 'bun:test';
import {
	hasSharedChannelContext,
	sessionWorkspace,
	sharedChannelPath,
	visibleUserText,
	withSharedChannelContext,
	withWorkspaceRule
} from '../../src/lib/shared-channel';

describe('shared background channel', () => {
	test('notes live in the session folder\'s own .workspace, shared by every session there', () => {
		expect(sharedChannelPath('/work/project')).toBe('/work/project/.workspace/coordination');
		// Any provider in the same (normalized) folder gets the same path.
		expect(sharedChannelPath('/work//project/')).toBe('/work/project/.workspace/coordination');
		expect(sharedChannelPath('/work/other')).not.toBe(sharedChannelPath('/work/project'));
		expect(sharedChannelPath('/')).toBe('/.workspace/coordination');
		expect(sharedChannelPath('  ')).toBeNull();
		expect(sessionWorkspace('/work/project/')).toBe('/work/project/.workspace');
	});

	test('sessions with old provider-specific instructions rejoin the common folder', () => {
		const old = withSharedChannelContext('Work', '/tmp/old-provider-folder', 'session');
		expect(hasSharedChannelContext(old)).toBe(true);
		expect(hasSharedChannelContext(old, '/tmp/common-machine-folder')).toBe(false);
		const updated = withSharedChannelContext(old, '/tmp/common-machine-folder', 'session');
		expect(hasSharedChannelContext(updated, '/tmp/common-machine-folder')).toBe(true);
		expect(updated).not.toContain('/tmp/old-provider-folder');
		expect(updated).toContain('including Codex and Claude sessions');
	});
	test('sessions that joined the old /tmp folder are moved to .workspace once', () => {
		const old = withSharedChannelContext('Work', '/tmp/yacwu-background-0af9592c8d15e3d8', 'session');
		const path = sharedChannelPath('/work/project')!;
		expect(hasSharedChannelContext(old, path)).toBe(false);
		const moved = withSharedChannelContext(old, path, 'session');
		expect(hasSharedChannelContext(moved, path)).toBe(true);
		expect(moved).not.toContain('/tmp/');
	});

	test('every prompt confines writes to the session folder, hidden from the transcript', () => {
		const text = withWorkspaceRule('Fix the bug', '/work/project/');
		expect(text).toContain('Write files only inside the session folder /work/project.');
		expect(text).toContain('/work/project/.workspace/');
		expect(text).toContain('not in other locations such as system temp directories');
		expect(visibleUserText(text)).toBe('Fix the bug');
		// No known folder: nothing to confine to.
		expect(withWorkspaceRule('Fix the bug', '')).toBe('Fix the bug');
	});

	test('channel instructions are added once and stripped from transcript text', () => {
		const prompt = 'Implement the feature';
		const withContext = withSharedChannelContext(prompt, '/tmp/shared', 'thread-a');
		expect(hasSharedChannelContext(withContext)).toBe(true);
		expect(withContext).toContain('Your session ID: thread-a');
		expect(visibleUserText(withContext)).toBe(prompt);
		expect(visibleUserText(withContext.replace('\n\n<!--', '<!--'))).toBe(prompt);
		expect(visibleUserText(prompt)).toBe(prompt);
		expect(visibleUserText(`${prompt}\n\n<!-- YACWU_TASK_PROGRESS -->private instructions`)).toBe(prompt);
	});
});

describe('direct-message guidance', () => {
	test('names the relay CLI with this session as sender', () => {
		const text = withSharedChannelContext('Work', '/tmp/shared', 'thread-a');
		expect(text).toContain('node "$YACWU_RELAY_CLI" send --from thread-a');
		expect(text).toContain('peers --session thread-a');
		expect(visibleUserText(text)).toBe('Work');
	});

	test('sessions joined before the relay existed receive the guidance once', () => {
		const legacy = withSharedChannelContext('Work', '/tmp/shared', 'thread-a').replace(/\n\nDirect messages[^\n]*/, '');
		expect(hasSharedChannelContext(legacy, '/tmp/shared')).toBe(false);
		expect(hasSharedChannelContext(withSharedChannelContext(legacy, '/tmp/shared', 'thread-a'), '/tmp/shared')).toBe(true);
	});
});

import { describe, expect, test } from 'bun:test';
import {
	hasSharedChannelContext,
	sharedChannelPath,
	visibleUserText,
	withSharedChannelContext
} from '../../src/lib/shared-channel';
import type { HostInfo } from '../../src/lib/protocol';

describe('shared background channel', () => {
	test('Claude and Codex providers on the same machine and workspace share notes', () => {
		const hosts: HostInfo[] = [
			{ name: 'local', kind: 'local', state: 'connected', provider: 'codex' },
			{ name: 'anthropic', kind: 'backend', state: 'connected', provider: 'claude' },
			{ name: 'claude', kind: 'remote', state: 'connected', provider: 'codex' }
		];
		const local = sharedChannelPath('local', '/work/project', hosts);
		expect(sharedChannelPath('anthropic', '/work/project/', hosts)).toBe(local);
		expect(sharedChannelPath('claude', '/work/project', hosts)).not.toBe(local);
		expect(sharedChannelPath('anthropic', '/work/other', hosts)).not.toBe(local);
		expect(sharedChannelPath('unknown', '/work/project', hosts)).not.toBe(local);
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
		expect(visibleUserText(`${prompt}\n\n<!-- YACWU_TASK_PROGRESS -->private instructions`)).toBe(prompt);
	});
});

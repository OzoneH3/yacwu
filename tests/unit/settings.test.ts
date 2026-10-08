import { describe, expect, test } from 'bun:test';
import { defaultSettings, readSettings, sendsMessage } from '../../src/lib/settings';

describe('global settings', () => {
	test('missing, invalid or partial storage falls back to defaults', () => {
		expect(readSettings(null)).toEqual(defaultSettings);
		expect(readSettings('not json')).toEqual(defaultSettings);
		expect(readSettings('[1,2]')).toEqual(defaultSettings);
		expect(readSettings('{"enterToSend":false}')).toEqual({ ...defaultSettings, enterToSend: false });
	});

	test('wrong types are ignored and numbers are clamped to their ranges', () => {
		const read = readSettings(JSON.stringify({ showAllActivity: 'yes', collapseOutputLines: 1, claudeReminderMinutes: 500, usageRefreshSeconds: '45' }));
		expect(read.showAllActivity).toBe(false);
		expect(read.collapseOutputLines).toBe(3);
		expect(read.claudeReminderMinutes).toBe(60);
		expect(read.usageRefreshSeconds).toBe(45);
		expect(readSettings('{"collapseOutputLines":"lots"}').collapseOutputLines).toBe(10);
	});

	test('Enter sends only when enabled; Ctrl/Cmd+Enter always sends; Shift+Enter never', () => {
		const key = (over: Partial<KeyboardEvent>) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, ...over });
		expect(sendsMessage(key({}), true)).toBe(true);
		expect(sendsMessage(key({}), false)).toBe(false);
		expect(sendsMessage(key({ ctrlKey: true }), false)).toBe(true);
		expect(sendsMessage(key({ metaKey: true }), false)).toBe(true);
		expect(sendsMessage(key({ shiftKey: true }), true)).toBe(false);
		expect(sendsMessage(key({ key: 'a' }), true)).toBe(false);
	});
});

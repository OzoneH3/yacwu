import { describe, expect, test } from 'bun:test';
import { appVersionTitle, parseAppVersion } from '../../src/lib/app-version';

describe('parseAppVersion', () => {
	test('splits the commit from the build time', () => {
		const version = parseAppVersion('29b8e90@2026-10-11T12:30:00.000Z');
		expect(version.commit).toBe('29b8e90');
		expect(version.builtAt?.toISOString()).toBe('2026-10-11T12:30:00.000Z');
	});

	test('keeps the uncommitted-changes mark and tolerates other names', () => {
		expect(parseAppVersion('29b8e90+@2026-10-11T12:30:00.000Z').commit).toBe('29b8e90+');
		expect(parseAppVersion('1791719199841')).toEqual({ commit: '1791719199841', builtAt: null });
		expect(parseAppVersion('abc@not a date').builtAt).toBeNull();
	});
});

test('appVersionTitle explains uncommitted builds', () => {
	expect(appVersionTitle('29b8e90+@2026-10-11T12:30:00.000Z')).toStartWith('Yacwu build from commit 29b8e90 with uncommitted changes, built ');
	expect(appVersionTitle('29b8e90')).toBe('Yacwu build from commit 29b8e90');
});

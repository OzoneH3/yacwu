import { expect, test } from 'bun:test';
import { readingNote, windowHasReset, windowLabel } from '../../src/lib/account-window';

const week = (usedPercent: number, resetsAt: number | null) => ({ usedPercent, windowDurationMins: 10_080, resetsAt });

test('a window past its reset no longer shows the old percentage', () => {
	const now = 1_793_644_742;
	expect(windowLabel(week(91, now + 3600), now)).toBe('9% left');
	expect(windowLabel(week(91, now - 9540), now)).toBe('reset · updating');
	expect(windowHasReset(week(0, null), now)).toBe(false);
	expect(windowLabel(week(12.5, null), now)).toBe('87.5% left');
});

test('a stale reading says why, how old it is and when the next try is', () => {
	const now = Date.parse('2026-11-02T19:40:00Z');
	expect(readingNote(null, now - 60_000, now)).toBeNull();
	const note = readingNote({ code: 'rate_limited', retryAt: now + 33 * 60_000 }, now - (4 * 60 + 5) * 60_000, now)!;
	expect(note).toContain('rate limiting');
	expect(note).toContain('Last reading 4 h 5 min ago.');
	expect(note).toContain('Next try around');
	expect(readingNote({ code: 'unavailable' }, null, now)).toBe('The usage reading could not be refreshed, so these figures may be out of date.');
});

test('missing allowance alone is not treated as missing authentication', async () => {
 const { claudeAccountNotice } = await import('../../src/lib/account-window');
 expect(claudeAccountNotice(null, true)).toBeNull();
 expect(claudeAccountNotice(null, false)?.authenticationRequired).toBe(false);
 expect(claudeAccountNotice({ code: 'rate_limited' }, false)?.authenticationRequired).toBe(false);
 const notice = claudeAccountNotice({ code: 'authentication_required' }, true);
 expect(notice?.authenticationRequired).toBe(true);
 expect(notice?.title).toContain('claude auth login');
});

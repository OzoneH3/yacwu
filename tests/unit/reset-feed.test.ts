import { expect, test } from 'bun:test';
import { announcedGlobalReset, expectedResetAt } from '../../src/lib/reset-feed';

const entry = (kind: string, text: string, at: string) => ({ kind, text, url: `https://willreset.com/r/${at}`, at });
const now = Date.parse('2026-10-13T03:00:00Z');

test('an announced reset is pending until one lands', () => {
	const preview = entry('reset_preview', 'Global reset landing by EOD PST time. Enjoy', '2026-10-13T01:03:59Z');
	const feed = [preview, entry('reset', 'Put the reset in the bag.', '2026-10-11T04:01:09Z')];
	expect(announcedGlobalReset(feed, now)).toEqual(preview);
	// Landed: nothing pending, even with chatter filed as a preview after it.
	const landed = [entry('reset_preview', 'Mashed @poteto on the house.', '2026-10-13T05:06:10Z'), entry('reset', "It's done.", '2026-10-13T05:06:06Z'), ...feed];
	expect(announcedGlobalReset(landed, Date.parse('2026-10-13T06:00:00Z'))).toBeNull();
	// Chatter alone, or an announcement over a day old, is not one.
	expect(announcedGlobalReset([entry('reset_preview', 'Also! Good evening!!', '2026-10-13T02:00:00Z')], now)).toBeNull();
	expect(announcedGlobalReset([preview], Date.parse('2026-10-14T02:00:00Z'))).toBeNull();
});

test('the feed relabelling a landed reset does not bring the notice back', () => {
	// As the feed later filed 13 Oct: the landing post as a preview, the landed
	// entry dated at the announcement.
	const feed = [
		entry('reset_preview', "What would you like with your side of reset? It's done.", '2026-10-13T05:06:06Z'),
		entry('reset', 'Day 8: the global reset promised by EOD PST', '2026-10-13T01:03:59Z'),
		entry('reset_preview', 'Day 8/ Reset', '2026-10-13T01:03:25Z')
	];
	const later = Date.parse('2026-10-13T09:00:00Z');
	expect(announcedGlobalReset(feed, later)).toBeNull();
	// The account's week began after the announcement: it has landed.
	const announced = [entry('reset_preview', 'Global reset by EOD.', '2026-10-13T05:00:00Z')];
	expect(announcedGlobalReset(announced, later, Date.parse('2026-10-13T06:49:32Z'))).toBeNull();
	expect(announcedGlobalReset(announced, later, Date.parse('2026-10-11T05:44:38Z'))).toEqual(announced[0]);
});

test('"by EOD PST" is due at the end of that day in Pacific time', () => {
	// Posted 01:03 UTC on 13 Oct: still 12 Oct in California (PDT, UTC-7).
	expect(expectedResetAt(entry('reset_preview', 'Global reset landing by EOD PST time. Enjoy', '2026-10-13T01:03:59Z'))).toBe(Date.parse('2026-10-13T06:59:59Z'));
	// In winter (PST, UTC-8).
	expect(expectedResetAt(entry('reset_preview', 'Global reset by EOD.', '2026-12-01T20:00:00Z'))).toBe(Date.parse('2026-12-02T07:59:59Z'));
	expect(expectedResetAt(entry('reset_preview', 'Day 8/ Reset', '2026-10-13T01:03:25Z'))).toBeNull();
});

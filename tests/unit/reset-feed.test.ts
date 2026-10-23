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

test('reset history uses only unique completed reports and recent historical gaps', async () => {
	const { resetHistory } = await import('../../src/lib/reset-feed');
	const reports = ['2026-10-01', '2026-10-03', '2026-10-07'].map((day) => entry('reset', 'Done', day+'T00:00:00Z'));
	const result = resetHistory([...reports, reports[0], entry('banked', 'Saved reset', '2026-10-08T00:00:00Z'), entry('reset_preview', 'Reset tomorrow', '2026-10-08T01:00:00Z'), entry('reset', 'Bad date', 'bad'), entry('reset', 'Future', '2027-01-01')], Date.parse('2026-10-08T12:00:00Z'));
	expect(result.reports).toHaveLength(3);
	expect(result.reports[0].at).toBe('2026-10-07T00:00:00Z');
	expect(result.medianGapMs).toBe(3 * 86400_000);
	expect(result.estimateAt).toBe(Date.parse('2026-10-10T00:00:00Z'));
	expect(result.gaps).toEqual([4 * 86400_000, 2 * 86400_000]);
	expect(resetHistory(reports.slice(0,2), Date.now()).estimateAt).toBeNull();
	expect(resetHistory([], Date.now()).reports).toEqual([]);
});


test('historical estimates use ten recent gaps and do not roll forward when overdue', async () => {
	const { resetHistory } = await import('../../src/lib/reset-feed');
	const start = Date.parse('2026-01-01T00:00:00Z');
	const reports = Array.from({ length: 20 }, (_, index) => entry('reset', 'Done', new Date(start + index * 86400_000).toISOString()));
	const history = resetHistory(reports, start + 100 * 86400_000);
	expect(history.reports).toHaveLength(20);
	expect(history.gaps).toHaveLength(10);
	expect(history.medianGapMs).toBe(86400_000);
	expect(history.estimateAt).toBe(start + 20 * 86400_000);
});

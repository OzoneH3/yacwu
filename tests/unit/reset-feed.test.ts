import { expect, test } from 'bun:test';
import { announcedGlobalReset } from '../../src/lib/reset-feed';

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

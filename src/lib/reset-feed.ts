/** An entry of the willreset.com feed, as GET /api/reset-feed returns it. */
export interface ResetFeedEntry {
	kind: string;
	text: string;
	url: string;
	at: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A post saying a reset is done is not an announcement of one to come. */
const LANDED = /\b(it'?s done|done\b|landed|propagated|in the bag|is live|went live)/i;

/**
 * A global Codex reset that has been announced but has not landed yet: the
 * newest reset preview that talks about a reset, under a day old, made after
 * the current weekly window began (a reset announced before it has already
 * happened; the account's own readings say so) and not after a landed reset.
 * The feed's labels are not reliable on their own: it files chatter, and
 * even "It's done", as previews, and dates its own landed entries at the
 * announcement.
 */
export function announcedGlobalReset(entries: ResetFeedEntry[], now: number, weekStartedAt: number | null = null): ResetFeedEntry | null {
	const dated = entries.map((entry) => ({ entry, at: Date.parse(entry.at) })).filter(({ at }) => Number.isFinite(at));
	const landed = Math.max(-Infinity, ...dated.filter(({ entry }) => entry.kind === 'reset').map(({ at }) => at));
	const pending = dated
		.filter(({ entry, at }) => entry.kind === 'reset_preview' && /\breset\b/i.test(entry.text) && !LANDED.test(entry.text)
			&& at > landed && at > (weekStartedAt ?? -Infinity) && now - at < DAY_MS)
		.sort((a, b) => b.at - a.at);
	return pending[0]?.entry ?? null;
}

function partsIn(ms: number, timeZone: string): Record<string, number> {
	const format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
	return Object.fromEntries(format.formatToParts(ms).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

/**
 * When an announced reset is due: announcements say "by EOD (PST)", the end
 * of that day in Pacific time, where the Codex team is. Null when the post
 * names no time.
 */
export function expectedResetAt(entry: ResetFeedEntry): number | null {
	if (!/\b(eod|end of (the )?day)\b/i.test(entry.text)) return null;
	const posted = Date.parse(entry.at);
	if (!Number.isFinite(posted)) return null;
	const zone = 'America/Los_Angeles';
	const day = partsIn(posted, zone);
	const guess = Date.UTC(day.year, day.month - 1, day.day, 23, 59, 59);
	const shown = partsIn(guess, zone);
	// The zone's offset at that moment turns the wall-clock time into UTC.
	return guess - (Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second) - guess);
}

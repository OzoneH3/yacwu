/** An entry of the codex-resets.com feed, as GET /api/reset-feed returns it. */
export interface ResetFeedEntry {
	kind: string;
	text: string;
	url: string;
	at: string;
	expectedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A post saying a reset is done is not an announcement of one to come. */
const LANDED = /\b(it'?s done|done\b|landed|propagated|in the bag|is live|went live)/i;

/**
 * A global Codex reset that has been announced but has not landed yet: the
 * newest reset preview that talks about a reset, under a day old, made after
 * the current weekly window began (a reset announced before it has already
 * happened; the account's own readings say so) and not after a landed reset.
 * Legacy preview labels can include chatter or completion posts, so the
 * text checks remain conservative alongside the structured schedule data.
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
 * When an announced reset is due: prefer the source's explicit schedule.
 * Older announcements say "by EOD (PST)", the end
 * of that day in Pacific time, where the Codex team is. Null when the post
 * names no time.
 */
export function expectedResetAt(entry: ResetFeedEntry): number | null {
	if (entry.expectedAt) {
		const expected = Date.parse(entry.expectedAt);
		return Number.isFinite(expected) ? expected : null;
	}
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

/** Completed public reports, not banked grants/previews or account reset dates. */
export function resetHistory(entries: ResetFeedEntry[], now: number) {
	const seen = new Set<number>();
	const reports = entries.filter((entry) => {
		const at = Date.parse(entry.at);
		if (entry.kind !== 'reset' || !Number.isFinite(at) || at > now || seen.has(at)) return false;
		seen.add(at);
		return true;
	}).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
	// Recent cadence only: at most ten completed intervals. Never slide a
	// missed estimate forward as if an unreported reset had occurred.
	const recent = reports.slice(0, 11);
	const gaps = recent.slice(1).map((entry, index) => Date.parse(recent[index].at) - Date.parse(entry.at));
	const sorted = [...gaps].sort((a, b) => a - b);
	const medianGapMs = sorted.length >= 2
		? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
		: null;
	return {
		reports, gaps, medianGapMs,
		estimateAt: medianGapMs === null ? null : Date.parse(reports[0].at) + medianGapMs
	};
}

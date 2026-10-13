/** An entry of the willreset.com feed, as GET /api/reset-feed returns it. */
export interface ResetFeedEntry {
	kind: string;
	text: string;
	url: string;
	at: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A global Codex reset that has been announced but has not landed yet: the
 * newest reset preview that talks about a reset, under a day old, with no
 * landed reset after it. (The feed's classifier also files chatter as
 * previews; requiring the word keeps those out.)
 */
export function announcedGlobalReset(entries: ResetFeedEntry[], now: number): ResetFeedEntry | null {
	const dated = entries.map((entry) => ({ entry, at: Date.parse(entry.at) })).filter(({ at }) => Number.isFinite(at));
	const landed = Math.max(-Infinity, ...dated.filter(({ entry }) => entry.kind === 'reset').map(({ at }) => at));
	const pending = dated
		.filter(({ entry, at }) => entry.kind === 'reset_preview' && /\breset\b/i.test(entry.text) && at > landed && now - at < DAY_MS)
		.sort((a, b) => b.at - a.at);
	return pending[0]?.entry ?? null;
}

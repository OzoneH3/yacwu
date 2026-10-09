export interface TaskProgressEstimate {
	percent: number;
	remainingMinutes: number | null;
}

export interface TaskProgressTranscriptEntry extends TaskProgressEstimate {
	type: 'taskProgress';
	id: string;
	at?: number;
	turnId?: string | null;
	[key: string]: unknown;
}

const PROGRESS_CONTEXT_MARKER = '<!-- YACWU_TASK_PROGRESS -->';
const PROGRESS_VALUE_RE = /\[\[YACWU_PROGRESS percent=(\d{1,3}) remaining_minutes=(\d{1,4}|unknown)\]\]/g;

/**
 * Add per-task reporting instructions without changing what the transcript
 * displays. `reminderMinutes` tells Yacwu's Claude backend how often to ask a
 * quiet turn for a fresh estimate (null: never); omitted, it keeps its default.
 */
export function withTaskProgressInstructions(text: string, reminderMinutes?: number | null): string {
	const markerAt = text.indexOf(PROGRESS_CONTEXT_MARKER);
	const visibleText = markerAt < 0 ? text : text.slice(0, markerAt).trimEnd();
	const reminders = reminderMinutes === undefined
		? ''
		: `\n<!-- YACWU_PROGRESS_REMINDERS ${reminderMinutes === null ? 'off' : `minutes=${Math.max(1, Math.round(reminderMinutes))}`} -->`;
	return `${visibleText}\n\n${PROGRESS_CONTEXT_MARKER}
Progress reporting is required for this task. Report progress as a standalone line in your progress commentary, using exactly this format: [[YACWU_PROGRESS percent=35 remaining_minutes=6]]. Percent is estimated completion from 0 to 100; remaining_minutes is a rough whole-minute estimate. These are estimates, not measured facts.
- Post the first line before your first tool call or substantive work.
- Then post one at least every few tool calls (about once a minute) and at every meaningful milestone. Never let a long run of tool calls pass without one.
- Give a numeric remaining_minutes whenever you can make even a rough guess; use “unknown” only when you truly cannot.
- Before your final answer, post a last line with percent=100 remaining_minutes=0. Never put the marker in the final answer itself.
Yacwu shows these lines as the task's progress, so a missing update makes working sessions look stalled.${reminders}
[/YACWU_TASK_PROGRESS]`;
}

export function parseTaskProgress(text: string): TaskProgressEstimate | null {
	let latest: TaskProgressEstimate | null = null;
	for (const match of text.matchAll(PROGRESS_VALUE_RE)) {
		const percent = Number(match[1]);
		if (!Number.isFinite(percent)) continue;
		latest = {
			percent: Math.max(0, Math.min(100, percent)),
			remainingMinutes: match[2] === 'unknown' ? null : Number(match[2])
		};
	}
	return latest;
}

/** Split progress protocol data out of assistant messages into its own transcript entry. */
export function separateTaskProgressEntries<T extends { type: string; id: string; text?: string }>(
	items: T[]
): Array<T | TaskProgressTranscriptEntry> {
	const result: Array<T | TaskProgressTranscriptEntry> = [];
	let lastEstimate: TaskProgressEstimate | null = null;
	for (const item of items) {
		if (item.type !== 'agentMessage' || typeof item.text !== 'string') {
			result.push(item);
			continue;
		}
		const estimate = parseTaskProgress(item.text);
		const visibleText = stripTaskProgressMarkers(item.text);
		if (visibleText || !estimate) result.push({ ...item, text: visibleText });
		if (estimate) {
			const isDuplicate = lastEstimate?.percent === estimate.percent
				&& lastEstimate.remainingMinutes === estimate.remainingMinutes;
			if (!isDuplicate) result.push({ type: 'taskProgress', id: `progress-${item.id}`, at: (item as T & { _at?: number })._at,
				turnId: (item as T & { _turnId?: string | null })._turnId, ...estimate });
			lastEstimate = estimate;
		}
	}
	return result;
}

/**
 * Minutes left for display. A stated estimate is shown as given, unless
 * `calibrate` is set: then it is first divided by `bias`, how many times
 * too long this agent's stated minutes have turned out to be, and once the
 * task has real progress (10% and a minute in), a figure that disagrees
 * with the elapsed-time pace by more than about 2× is replaced by that
 * pace. Claude cannot see elapsed time and tends to anchor its minutes on
 * an upfront guess, while its percentage tracks the work done.
 */
export function estimateRemainingMinutes(
	percent: number,
	explicitMinutes: number | null,
	elapsedMs: number,
	calibrate = false,
	bias = 1
): number | null {
	const paced = percent > 0 && percent < 100 && elapsedMs >= 30_000
		? Math.max(1, Math.ceil((elapsedMs * (100 - percent)) / percent / 60_000))
		: null;
	if (explicitMinutes === null) return percent >= 100 ? 0 : paced;
	if (calibrate && explicitMinutes > 0) explicitMinutes = Math.max(1, Math.round(explicitMinutes / bias));
	if (!calibrate || paced === null || percent < 10 || elapsedMs < 60_000) return explicitMinutes;
	const inconsistent = explicitMinutes > paced * 2 + 2 || explicitMinutes * 2 + 2 < paced;
	return inconsistent ? paced : explicitMinutes;
}

/** Measured on recent Claude turns: stated minutes ran a median 7.5× too long, rarely under 4×. */
export const DEFAULT_ESTIMATE_BIAS = 4;
const MIN_TURN_SAMPLES = 3;

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

/**
 * How many times too long one finished turn's stated minutes were: the
 * median over its estimates made with at least a minute actually left.
 * Null for turns too short to say.
 */
export function turnEstimateBias(
	estimates: Array<{ at: number; percent: number; remainingMinutes: number | null }>,
	startedAt: number,
	endedAt: number
): number | null {
	if (endedAt - startedAt < 2 * 60_000) return null;
	const ratios = estimates.flatMap(({ at, percent, remainingMinutes }) => {
		const actual = (endedAt - at) / 60_000;
		return remainingMinutes && percent < 100 && actual >= 1 ? [remainingMinutes / actual] : [];
	});
	return ratios.length ? median(ratios) : null;
}

/** The correction to apply: learned from recent turns, or the measured default. */
export function estimateBias(turnBiases: number[]): number {
	if (turnBiases.length < MIN_TURN_SAMPLES) return DEFAULT_ESTIMATE_BIAS;
	return Math.max(0.5, Math.min(20, median(turnBiases)));
}

/** Keep protocol markers out of the visible assistant transcript. */
export function stripTaskProgressMarkers(text: string): string {
	return text
		.replace(/(^|\n)[ \t]*\[\[YACWU_PROGRESS percent=\d{1,3} remaining_minutes=(?:\d{1,4}|unknown)\]\][ \t]*(?:\r?\n|$)/gm, '$1')
		.replace(/[ \t]*\[\[YACWU_PROGRESS percent=\d{1,3} remaining_minutes=(?:\d{1,4}|unknown)\]\][ \t]*/g, ' ')
		.replace(/(^|\n) +/g, '$1')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

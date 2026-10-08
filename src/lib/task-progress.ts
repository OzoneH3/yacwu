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

/** Add per-task reporting instructions without changing what the transcript displays. */
export function withTaskProgressInstructions(text: string): string {
	const markerAt = text.indexOf(PROGRESS_CONTEXT_MARKER);
	const visibleText = markerAt < 0 ? text : text.slice(0, markerAt).trimEnd();
	return `${visibleText}\n\n${PROGRESS_CONTEXT_MARKER}
Progress reporting is required for this task. Report progress as a standalone line in your progress commentary, using exactly this format: [[YACWU_PROGRESS percent=35 remaining_minutes=6]]. Percent is estimated completion from 0 to 100; remaining_minutes is a rough whole-minute estimate. These are estimates, not measured facts.
- Post the first line before your first tool call or substantive work.
- Then post one at least every few tool calls (about once a minute) and at every meaningful milestone. Never let a long run of tool calls pass without one.
- Give a numeric remaining_minutes whenever you can make even a rough guess; use “unknown” only when you truly cannot.
- Before your final answer, post a last line with percent=100 remaining_minutes=0. Never put the marker in the final answer itself.
Yacwu shows these lines as the task's progress, so a missing update makes working sessions look stalled.
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

/** Estimate remaining minutes from observed elapsed time when the agent omits it. */
export function estimateRemainingMinutes(percent: number, explicitMinutes: number | null, elapsedMs: number): number | null {
	if (explicitMinutes !== null) return explicitMinutes;
	if (percent >= 100) return 0;
	if (percent <= 0 || elapsedMs < 30_000) return null;
	return Math.max(1, Math.ceil((elapsedMs * (100 - percent)) / percent / 60_000));
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

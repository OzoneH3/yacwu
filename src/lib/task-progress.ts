export interface TaskProgressEstimate {
	percent: number;
	remainingMinutes: number | null;
}

const PROGRESS_CONTEXT_MARKER = '<!-- YACWU_TASK_PROGRESS -->';
const PROGRESS_VALUE_RE = /\[\[YACWU_PROGRESS percent=(\d{1,3}) remaining_minutes=(\d{1,4}|unknown)\]\]/g;

/** Add per-task reporting instructions without changing what the transcript displays. */
export function withTaskProgressInstructions(text: string): string {
	const markerAt = text.indexOf(PROGRESS_CONTEXT_MARKER);
	const visibleText = markerAt < 0 ? text : text.slice(0, markerAt).trimEnd();
	return `${visibleText}\n\n${PROGRESS_CONTEXT_MARKER}
For this user task, estimate how much work is complete and the rough time remaining. Include an initial estimate early, then update it about once a minute during long work and at meaningful milestones. Put a standalone line in your progress commentary using exactly this format: [[YACWU_PROGRESS percent=35 remaining_minutes=6]]. Percent is estimated completion from 0 to 100; remaining_minutes is a rough whole-minute estimate, or use “unknown” if you cannot estimate. Mark these as estimates, not measured facts. Finish with 100 percent and 0 minutes. Do not include the marker in the final answer.
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

/** Keep protocol markers out of the visible assistant transcript. */
export function stripTaskProgressMarkers(text: string): string {
	return text
		.replace(/(^|\n)[ \t]*\[\[YACWU_PROGRESS percent=\d{1,3} remaining_minutes=(?:\d{1,4}|unknown)\]\][ \t]*(?:\r?\n|$)/gm, '$1')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

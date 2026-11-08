// Allowance windows (5h / 7d) as the session header shows them. A reading
// can be out of date: Claude's usage endpoint rate-limits Yacwu's polling,
// sometimes for hours, and a window past its reset no longer means anything.

export interface UsageWindow {
	usedPercent: number;
	windowDurationMins: number;
	resetsAt: number | null;
}

/** Why the backend's reading may be stale, as Yacwu's Claude backend reports it. */
export interface UsageReadingError {
	code: string;
	/** Epoch ms of the next attempt. */
	retryAt?: number | null;
}

/** The window's reset time has passed: the percentage shown was for the previous window. */
export function windowHasReset(window: UsageWindow, nowSeconds: number): boolean {
	return typeof window.resetsAt === 'number' && window.resetsAt <= nowSeconds;
}

export function remainingPercentLabel(window: UsageWindow): string {
	const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
	return Number.isInteger(remaining) ? String(remaining) : remaining.toFixed(1);
}

/** What the header shows for one window. */
export function windowLabel(window: UsageWindow, nowSeconds: number): string {
	return windowHasReset(window, nowSeconds) ? 'reset · updating' : `${remainingPercentLabel(window)}% left`;
}

function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function ago(ms: number, nowMs: number): string {
	const minutes = Math.max(0, Math.round((nowMs - ms) / 60_000));
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours} h ${minutes % 60} min ago`;
}

/**
 * A sentence for the windows' tooltips when the reading is not current, or
 * null when it is. `readAt` is when the backend last read the account.
 */
export function readingNote(error: UsageReadingError | null | undefined, readAt: number | null | undefined, nowMs: number): string | null {
	if (!error) return null;
	const age = typeof readAt === 'number' && readAt > 0 ? ` Last reading ${ago(readAt, nowMs)}.` : '';
	const retry = typeof error.retryAt === 'number' && error.retryAt > nowMs ? ` Next try around ${clock(error.retryAt)}.` : '';
	const reason = error.code === 'rate_limited'
		? 'Claude’s usage endpoint is rate limiting Yacwu, so these figures may be out of date.'
		: 'The usage reading could not be refreshed, so these figures may be out of date.';
	return `${reason}${age}${retry}`;
}

/** Shared account warning; do not infer logout from a missing percentage alone. */
export function claudeAccountNotice(error: UsageReadingError | null | undefined, complete: boolean): { label: string; title: string; authenticationRequired: boolean } | null {
  if (error?.code === 'authentication_required') return {
    label: 'Claude sign-in required',
    title: 'Claude authentication is missing or expired. Run claude auth login on the machine running this Claude backend, then refresh. This applies to all sessions using that backend.',
    authenticationRequired: true
  };
  if (!complete) return {
    label: 'Claude allowance unavailable',
    title: 'Claude has not supplied both allowance readings. ' + (readingNote(error, null, Date.now()) ?? 'A later account refresh will retry.'),
    authenticationRequired: false
  };
  return null;
}

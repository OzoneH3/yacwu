import type { TokenStatistics } from './protocol';

/**
 * What a backend notification shows about a running turn: the kind of work
 * it reports, or null when it says nothing about progress.
 */
export function activityKind(method: string): string | null {
	if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') return 'thinking';
	if (method === 'item/agentMessage/delta') return 'writing';
	if (method === 'item/commandExecution/outputDelta') return 'command output';
	if (method === 'thread/tokenUsage/updated') return 'tokens';
	if (method.startsWith('item/') || method === 'turn/started') return 'step';
	return null;
}

/** Tokens a running turn has used so far: the thread total now, less at its start. */
export function turnTokens(start: TokenStatistics | null | undefined, now: TokenStatistics | null | undefined): number | null {
	if (!now) return null;
	return Math.max(0, now.totalTokens - (start?.totalTokens ?? 0));
}

function compact(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
	return String(tokens);
}

/** Characters of text an event streamed (thinking, writing, command output). */
export function streamedChars(method: string, params: { delta?: unknown } | undefined): number {
	if (!['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta'].includes(method)) return 0;
	return typeof params?.delta === 'string' ? params.delta.length : 0;
}

/**
 * The running token count for a turn: the backend's own figure when it has
 * reported one (Codex does as it goes), otherwise an estimate from the text
 * streamed so far, about four characters a token (until the backend's
 * first report).
 */
export function turnTokenLabel(reported: number | null, streamed: number): string {
	if (reported) return `${compact(reported)} tokens`;
	const estimate = Math.round(streamed / 4);
	return estimate > 0 ? `~${compact(estimate)} tokens` : '';
}

/** "thinking 3s ago" — the latest sign that a turn is moving. */
export function liveActivityLabel(kind: string | null, at: number | null, now: number): string {
	if (!kind || at === null) return '';
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	const ago = seconds < 2 ? 'just now' : seconds < 120 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
	return `${kind === 'step' ? 'last update' : kind} ${ago}`;
}

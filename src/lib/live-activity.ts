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

/** "thinking 3s ago · 12.4k tokens this turn" — evidence that a turn is moving. */
export function liveActivityLabel(kind: string | null, at: number | null, tokens: number | null, now: number): string {
	const parts: string[] = [];
	if (kind && at !== null) {
		const seconds = Math.max(0, Math.round((now - at) / 1000));
		const ago = seconds < 2 ? 'just now' : seconds < 120 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
		parts.push(`${kind === 'step' ? 'last update' : kind} ${ago}`);
	}
	if (tokens) parts.push(`${compact(tokens)} tokens this turn`);
	return parts.join(' · ');
}

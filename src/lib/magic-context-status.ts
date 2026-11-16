/**
 * Render the status the Magic Context plugin reports for an OpenCode session.
 *
 * The plugin's own `/ctx-status` is a TUI dialog action Yacwu cannot display,
 * so `/ctx-status` reads the same `status-detail` payload from the plugin's
 * loopback RPC and prints the fields its chat clients show. Keep the labels
 * and order aligned with the plugin's status summary.
 */

/** The subset of the plugin's status-detail reply this view renders. */
export interface MagicContextStatus {
	sessionId?: string;
	pluginVersion?: string;
	usagePercentage: number;
	inputTokens: number;
	contextLimit: number;
	cacheTtl?: string;
	compaction_enabled?: boolean;
	executeThreshold?: number;
	compartmentCount?: number;
	historianRunning?: boolean;
	compartmentInProgress?: boolean;
	recompProgress?: { phase?: string; kind?: string } | null;
	tailHygiene?: { reclaimableToolOutputCount?: number; u?: number } | null;
	memoryCount?: number;
	sessionNoteCount?: number;
	embedding?: { state?: string; indexed?: number; total?: number } | null;
	lastTransformError?: string | null;
	historianFailureCount?: number;
	configParseFailures?: unknown[] | null;
	loggerDiagnostics?: { swallowedWriteCount?: number } | null;
	memoryMirror?: { stalled?: boolean } | null;
	compactionMarker?: { code?: string | null; attempts?: number; lastError?: string | null } | null;
	memoryAuthorityMismatch?: boolean;
	dreamerFailures?: unknown[] | null;
	dreamerTickFailure?: unknown;
	dreamerSkipped?: string[];
	hiddenModelSkips?: string[];
	hostLimitations?: string[];
	hiddenVariantWarnings?: string[];
}

/** A warning code from the plugin, with the sentence its dialog prints. */
const WARNINGS: Record<string, string> = {
	transform_update_failed: 'The last context update failed; the next message retries it.',
	historian_unavailable: 'History compression could not reach its model.',
	configuration_warning: 'The plugin configuration has parse errors.',
	embedding_unavailable: 'Search indexing stopped after an issue.',
	status_log_unavailable: 'Some status log writes were dropped.',
	memory_mirror_stalled: 'The memory mirror has stopped updating.',
	compaction_marker_missing: 'The history boundary marker is missing; a repair is pending.',
	memory_authority_mismatch: 'Memory ownership disagrees with the running module.',
	dreamer_task_failing: 'A background maintenance task is failing.',
	dreamer_tick_blocked: 'A background maintenance pass could not start.'
};

function count(value: number | undefined): string {
	return Math.round(Math.max(0, value ?? 0)).toLocaleString('en-US');
}

function compressionState(status: MagicContextStatus): string {
	const blocks = Math.max(0, status.compartmentCount ?? 0);
	const historyBlocks = `${count(blocks)} history block${blocks === 1 ? '' : 's'}`;
	if (status.compaction_enabled === false) return 'Off';
	const recompressing =
		status.recompProgress?.phase === 'recomp' && status.recompProgress?.kind !== 'embed';
	if (status.historianRunning || status.compartmentInProgress || recompressing) {
		return `Compressing history · ${historyBlocks}`;
	}
	return blocks > 0 ? `Ready · ${historyBlocks}` : 'Waiting for enough conversation history';
}

function reclaimableText(status: MagicContextStatus): string {
	const outputs = Math.max(0, Math.floor(status.tailHygiene?.reclaimableToolOutputCount ?? 0));
	if (outputs === 0) return 'none';
	const tokens = Math.max(0, status.tailHygiene?.u ?? 0);
	return `${count(outputs)} spent tool output${outputs === 1 ? '' : 's'} (~${Math.round(tokens / 1000)}k tokens)`;
}

function indexingText(status: MagicContextStatus): string {
	const embedding = status.embedding;
	if (!embedding || !embedding.state || embedding.state === 'off') return 'Off';
	const coverage = `${count(embedding.indexed)} / ${count(embedding.total)} history blocks indexed`;
	switch (embedding.state) {
		case 'running':
			return `Running · ${coverage}`;
		case 'paused':
			return `Paused · ${coverage}`;
		case 'stopped':
			return `Paused after an issue · ${coverage}`;
		case 'ready':
			return `Ready · ${coverage}`;
		default:
			return `Waiting · ${coverage}`;
	}
}

/** Warning codes in the plugin's display order, deduplicated. */
export function magicContextWarnings(status: MagicContextStatus): string[] {
	const warnings: string[] = [];
	if (status.lastTransformError) warnings.push('transform_update_failed');
	if ((status.historianFailureCount ?? 0) > 0) warnings.push('historian_unavailable');
	if ((status.configParseFailures?.length ?? 0) > 0) warnings.push('configuration_warning');
	if (status.embedding?.state === 'stopped') warnings.push('embedding_unavailable');
	if ((status.loggerDiagnostics?.swallowedWriteCount ?? 0) > 0) warnings.push('status_log_unavailable');
	if (status.memoryMirror?.stalled) warnings.push('memory_mirror_stalled');
	if (status.compactionMarker?.code) warnings.push('compaction_marker_missing');
	if (status.memoryAuthorityMismatch) warnings.push('memory_authority_mismatch');
	if ((status.dreamerFailures?.length ?? 0) > 0) warnings.push('dreamer_task_failing');
	if (status.dreamerTickFailure) warnings.push('dreamer_tick_blocked');
	warnings.push(...(status.hostLimitations ?? []));
	return [...new Set(warnings)];
}

export function formatMagicContextStatus(status: MagicContextStatus): string {
	const percent = `${status.usagePercentage.toFixed(1)}%`;
	const context =
		status.contextLimit > 0
			? `${percent} of usable context (${count(status.inputTokens)} / ${count(status.contextLimit)} tokens)`
			: `${percent} of usable context (${count(status.inputTokens)} tokens)`;
	const lines = [
		'Magic Context Status',
		`Context: ${context}`,
		`Cache lifetime: ${status.cacheTtl || 'unknown'}`,
		`Automatic compression: ${
			status.compaction_enabled === false
				? 'Off'
				: `at ${(status.executeThreshold ?? 65).toFixed(1)}% of usable context`
		}`,
		`History compression: ${compressionState(status)}`,
		`Reclaimable: ${reclaimableText(status)}`,
		`Memory: ${count(status.memoryCount)} memories · ${count(status.sessionNoteCount)} notes`,
		`Search indexing: ${indexingText(status)}`
	];
	for (const skipped of status.dreamerSkipped ?? []) lines.push(`Dreamer skipped: ${skipped}`);
	for (const quota of status.hiddenModelSkips ?? []) lines.push(`Hidden model quota: ${quota}`);
	if (status.compactionMarker?.code) {
		lines.push(
			`History boundary marker: ${status.compactionMarker.code} · ${status.compactionMarker.attempts ?? 0} attempts · last error: ${status.compactionMarker.lastError ?? 'unknown'}`
		);
	}
	if (status.pluginVersion) lines.push(`Plugin: ${status.pluginVersion}`);
	for (const warning of status.hiddenVariantWarnings ?? []) lines.push(`Warning: ${warning}`);
	for (const warning of magicContextWarnings(status)) {
		lines.push(`Warning: ${WARNINGS[warning] ?? warning}`);
	}
	return lines.join('\n');
}

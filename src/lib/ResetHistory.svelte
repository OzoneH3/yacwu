<script lang="ts">
	import { onMount } from 'svelte';
	import { observeWhileVisible } from './polling';
	import { resetHistory, announcedGlobalReset, expectedResetAt, type ResetFeedEntry } from './reset-feed';
	let { entries }: { entries: ResetFeedEntry[] } = $props();
	let now = $state(Date.now());
	const history = $derived(resetHistory(entries, now));
	const announcement = $derived(announcedGlobalReset(entries, now));
	const due = $derived(announcement ? expectedResetAt(announcement) : null);
	const date = (at: string | number) => new Date(at).toLocaleString();
	const gap = (ms: number) => `${(ms / 86400_000).toFixed(1)} days`;
	function source(url: string): string | undefined {
		try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.href : undefined; }
		catch { return undefined; }
	}
	onMount(() => observeWhileVisible(() => { now = Date.now(); }, 60_000));
</script>

<section aria-labelledby="reset-history-title">
	<h3 id="reset-history-title">Codex public reset reports</h3>
	<p class="meta">Twitter/X reports via <a href="https://codex-resets.com" target="_blank" rel="noopener noreferrer">codex-resets.com</a>. Dates are report times, not verified resets of your account. The feed may show cached records when its source is unavailable. Banked resets and boosts are excluded.</p>
	{#if announcement}
		<p>Reset announced{due ? ` · expected by ${date(due)}` : ' · no precise time available'}: <a href={source(announcement.url)} target="_blank" rel="noopener noreferrer">{announcement.text}</a></p>
	{/if}
	{#if history.reports[0]}
		<p>Latest recorded reset report: <a href={source(history.reports[0].url)} target="_blank" rel="noopener noreferrer"><time datetime={history.reports[0].at}>{date(history.reports[0].at)}</time></a></p>
		{#if history.estimateAt !== null}
			<p class="estimate"><strong>Historical estimate:</strong> {date(history.estimateAt)}{history.estimateAt <= now ? ' · typical gap already elapsed; awaiting a new report' : ''}.</p>
			<p class="meta">Median gap {gap(history.medianGapMs!)} across the latest {history.gaps.length} intervals (observed range {gap(Math.min(...history.gaps))}–{gap(Math.max(...history.gaps))}). This is not a scheduled reset or a guarantee. Your account’s reset countdown remains separate.</p>
		{:else}
			<p class="meta">At least three completed reset reports are needed for a historical estimate.</p>
		{/if}
		<details>
			<summary>Reset report history ({history.reports.length})</summary>
			<div class="table-wrap"><table>
				<thead><tr><th>Reported at (local time)</th><th>Gap since previous report</th><th>Report</th></tr></thead>
				<tbody>{#each history.reports as report, index (report.at)}
					<tr><td><time datetime={report.at}>{date(report.at)}</time></td><td>{history.reports[index + 1] ? gap(Date.parse(report.at) - Date.parse(history.reports[index + 1].at)) : '—'}</td><td><a href={source(report.url)} target="_blank" rel="noopener noreferrer">{report.text || 'Open report'}</a></td></tr>
				{/each}</tbody>
			</table></div>
		</details>
	{:else}
		<p class="meta">No completed reset reports available. The feed may be unavailable or disabled; no next-reset estimate can be made.</p>
	{/if}
</section>

<style>
	section { margin-block: var(--space-sm); padding: var(--space-sm); border: var(--rule-hair) solid var(--color-rule); border-radius: var(--radius-input); }
	h3 { margin: 0; font-size: var(--text-sm); }
	p, summary { font-size: var(--text-sm); line-height: 1.5; }
	.meta { color: var(--color-muted); font-size: var(--text-xs); }
	a { color: inherit; text-decoration: underline; }
	summary { cursor: pointer; }
	.table-wrap { overflow: auto; max-height: 35dvh; margin-block-start: var(--space-xs); }
	table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
	th, td { padding: var(--space-xs); border-block-end: var(--rule-hair) solid var(--color-rule); text-align: start; vertical-align: top; }
	th { position: sticky; top: 0; background: var(--color-paper-2); }
	td:first-child { white-space: nowrap; }
</style>

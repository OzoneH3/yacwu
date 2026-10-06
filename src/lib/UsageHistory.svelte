<script lang="ts">
	import { onMount } from 'svelte';
	import { hostQuery } from './protocol';
	import { analyzeUsage, type UsageEvent } from './usage-analysis';
	let { host, sessionId, onclose }: { host: string; sessionId: string; onclose: () => void } = $props();
	let dialog = $state<HTMLDialogElement>();
	let events = $state<UsageEvent[]>([]);
	let loading = $state(false);
	let error = $state('');
	let onlySession = $state(true);
	const analysis = $derived(analyzeUsage(events));
	const sessionThreads = $derived.by(() => {
		const ids = new Set([sessionId]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const task of analysis.tasks) if (task.parentThreadId && ids.has(task.parentThreadId) && !ids.has(task.threadId)) { ids.add(task.threadId); changed = true; }
		}
		return ids;
	});
	const tasks = $derived(analysis.tasks.filter((task) => !onlySession || sessionThreads.has(task.threadId)).slice(0, 100));
	const percent = (value: number | null) => value === null ? '—' : `~${value.toFixed(2)}%`;
	const tokens = (value: number) => value.toLocaleString();
	function duration(start: number, end: number | null) {
		const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000));
		return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	}
	async function refresh() {
		loading = true; error = '';
		try {
			const response = await fetch(`/api/usage${hostQuery(host)}`);
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? 'Could not load usage history');
			events = data.events ?? [];
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { loading = false; }
	}
	onMount(() => { dialog?.showModal(); void refresh(); });
</script>

<dialog bind:this={dialog} aria-labelledby="usage-history-title" oncancel={onclose} onclick={(event) => { if (event.target === dialog) onclose(); }}>
	<div class="panel">
		<header>
			<h2 id="usage-history-title">Task allowance usage</h2>
			<button type="button" onclick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
			<button type="button" onclick={onclose} aria-label="Close usage history">×</button>
		</header>
		<p>Estimates learn from tokens and weekly allowance readings on {host === 'local' ? 'this machine' : host}. Account usage also includes other apps and hosts.</p>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<h3>Model and thinking level</h3>
		<p class="meta">{analysis.observations} pooled observations · {analysis.excludedIntervals} incomplete observations excluded. Readings are pooled across at least 2% used.</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Model</th><th>Thinking</th><th>Samples</th><th>Tokens sampled</th><th>Weekly cost / 100k tokens</th></tr></thead>
				<tbody>
					{#each analysis.rates as rate}
						<tr><td>{rate.model}</td><td>{rate.effort}</td><td>{rate.samples}</td><td>{tokens(rate.tokens)}</td><td>{rate.percentPer100kTokens === null ? 'Learning…' : percent(rate.percentPer100kTokens)}</td></tr>
					{:else}<tr><td colspan="5">No tasks recorded yet. Recording begins after the updated backend starts.</td></tr>{/each}
				</tbody>
			</table>
		</div>
		<h3>Recorded tasks</h3>
		<label><input type="checkbox" bind:checked={onlySession} /> This session and its agents</label>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Started / status</th><th>Model / thinking</th><th>Tokens</th><th>Time</th><th>Week left</th><th>Account change</th><th>Task estimate</th></tr></thead>
				<tbody>
					{#each tasks as task}
						<tr>
							<td>{new Date(task.startedAt).toLocaleString()}<small>{task.status}{task.parentThreadId ? ' · agent' : ''}{task.overlapping ? ' · overlapping' : ''}</small></td>
							<td>{task.model}<small>{task.effort}</small></td>
							<td title={`Input ${tokens(task.tokens.inputTokens)}, cached ${tokens(task.tokens.cachedInputTokens)}, output ${tokens(task.tokens.outputTokens)}, reasoning ${tokens(task.tokens.reasoningOutputTokens)}`}>{tokens(task.tokens.totalTokens)}{task.partialTokens ? ' (partial)' : ''}</td>
							<td>{duration(task.startedAt, task.endedAt)}</td>
							<td>{task.weeklyLeftBefore ?? '—'}% → {task.weeklyLeftAfter ?? '—'}%</td>
							<td>{task.sharedAllowanceDelta === null ? '—' : `${task.sharedAllowanceDelta}%`}</td>
							<td>{percent(task.estimatedWeeklyPercent)}</td>
						</tr>
					{:else}<tr><td colspan="7">No recorded tasks for this selection.</td></tr>{/each}
				</tbody>
			</table>
		</div>
		<p class="meta">Each task is one Codex turn; agents have their own rows. Account change is shared usage, not an exact charge for that task. Estimates need several independent observations; partial recordings remain unestimated. Tokens count cumulative usage deltas, including cached input. Tool waiting time does not imply token use.</p>
	</div>
</dialog>

<style>
	dialog { position: fixed; inset: 0; width: min(calc(100% - 2rem), 76rem); max-width: none; max-height: calc(100dvh - 2rem); margin: auto; padding: 0; overflow: auto; border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-card); color: var(--color-ink); background: var(--color-paper); box-shadow: var(--shadow-card); }
	dialog::backdrop { background: var(--color-overlay); }
	.panel { padding: var(--space-sm); }
	header { display: flex; align-items: center; gap: var(--space-xs); }
	h2 { flex: 1; margin: 0; font-size: var(--text-lg); }
	h3 { font-size: var(--text-sm); margin: var(--space-md) 0 var(--space-xs); }
	p, label { font-size: var(--text-sm); }
	p { line-height: 1.5; }
	.meta, small { color: var(--color-muted); font-size: var(--text-xs); }
	.error { color: var(--color-error); }
	button { min-height: var(--control-height-compact); padding: var(--space-2xs) var(--space-xs); border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-input); background: var(--color-paper-2); color: var(--color-ink); cursor: pointer; }
	button:disabled { opacity: .5; cursor: wait; }
	.table-wrap { overflow: auto; max-height: 40dvh; margin-block: var(--space-xs); }
	table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
	th, td { padding: var(--space-xs); border-block-end: var(--rule-hair) solid var(--color-rule); text-align: start; vertical-align: top; white-space: nowrap; }
	th { position: sticky; top: 0; background: var(--color-paper-2); color: var(--color-muted); }
	small { display: block; margin-block-start: var(--space-3xs); }
</style>

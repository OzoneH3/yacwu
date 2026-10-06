<script lang="ts">
	import { onMount } from 'svelte';
	import { hostQuery } from './protocol';
	import { analyzeUsage, type UsageEvent } from './usage-analysis';
	import BenchmarkControls from './BenchmarkControls.svelte';
	import type { CostEstimate } from './usage-fit';
	let { host, sessionId, models, selectedModel, selectedEffort, onclose }: { host: string; sessionId: string; models: Array<{ id: string; displayName: string; efforts: string[] }>; selectedModel?: string; selectedEffort?: string; onclose: () => void } = $props();
	let dialog = $state<HTMLDialogElement>();
	let events = $state<UsageEvent[]>([]);
	let loading = $state(false);
	let error = $state('');
	let onlySession = $state(true);
	const analysis = $derived(analyzeUsage(events, { host }));
	const sessionThreads = $derived.by(() => {
		const ids = new Set([sessionId]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const task of analysis.tasks) if (task.parentThreadId && ids.has(task.parentThreadId) && !ids.has(task.threadId)) { ids.add(task.threadId); changed = true; }
		}
		return ids;
	});
	const tasks = $derived(analysis.tasks.filter((task) => !onlySession || (task.host === host && sessionThreads.has(task.threadId))).slice(0, 100));
	const percent = (value: number | null) => value === null ? '—' : `~${value.toFixed(value > 0 && value < .01 ? 3 : 2)}%`;
	const range = (estimate: CostEstimate | null) => estimate ? `${percent(estimate.value)} (${estimate.low.toFixed(3)}–${estimate.high.toFixed(3)}%)` : 'Learning…';
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
		<p>Estimates use token usage from hosts with matching account fingerprints: {analysis.hosts.join(', ')}. Weekly readings come from {host}. Usage outside Yacwu can still affect the allowance.</p>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<BenchmarkControls {host} {models} {selectedModel} {selectedEffort} oncomplete={() => void refresh()} />
		<h3>Model and thinking level</h3>
		<p class="meta">{analysis.observations} pooled observations · {analysis.excludedIntervals} incomplete observations excluded. Intervals close after at least 2% used and 60 seconds without token activity. Ranges are indicative uncertainty estimates, not guaranteed bounds.</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Model</th><th>Thinking</th><th>Samples</th><th>Tokens sampled</th><th>Weekly cost / 100k (observed mix)</th><th>Uncached / cached / output per 100k</th></tr></thead>
				<tbody>
					{#each analysis.rates as rate}
						<tr><td>{rate.model}</td><td>{rate.effort}</td><td>{rate.samples}</td><td>{tokens(rate.tokens)}</td><td>{range(rate.estimate)}{#if rate.estimate}<small>{rate.estimate.weighted ? 'Separate token weights' : 'Total-token fallback'}</small>{/if}</td><td>{percent(rate.weights.uncached)} / {percent(rate.weights.cached)} / {percent(rate.weights.output)}</td></tr>
					{:else}<tr><td colspan="6">No tasks recorded yet. Recording begins after the updated backend starts.</td></tr>{/each}
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
							<td>{new Date(task.startedAt).toLocaleString()}<small>{task.host} · {task.status}{task.benchmark ? ' · benchmark' : ''}{task.parentThreadId ? ' · agent' : ''}{task.overlapping ? ' · overlapping' : ''}{task.settling ? ' · settling' : ''}</small></td>
							<td>{task.model}<small>{task.effort}</small></td>
							<td title={`Input ${tokens(task.tokens.inputTokens)}, cached ${tokens(task.tokens.cachedInputTokens)}, output ${tokens(task.tokens.outputTokens)}, reasoning ${tokens(task.tokens.reasoningOutputTokens)}`}>{tokens(task.tokens.totalTokens)}{task.partialTokens ? ' (partial)' : ''}</td>
							<td>{duration(task.startedAt, task.endedAt)}</td>
							<td>{task.weeklyLeftBefore ?? '—'}% → {task.weeklyLeftAfter ?? '—'}%</td>
							<td>{task.sharedAllowanceDelta === null ? '—' : `${task.sharedAllowanceDelta}%`}</td>
							<td>{task.partialTokens ? 'Partial recording' : range(task.estimate)}{#if task.estimate}<small>{task.estimate.samples} samples · {task.estimate.weighted ? 'weighted' : 'total-token fallback'}</small>{/if}</td>
						</tr>
					{:else}<tr><td colspan="7">No recorded tasks for this selection.</td></tr>{/each}
				</tbody>
			</table>
		</div>
		<p class="meta">Each task is one Codex turn; agents have their own rows. Account change includes a settling period and can overlap later work. Separate uncached input, cached input and output weights are learned when identifiable; reasoning is included in output only once. Partial recordings remain unestimated. Tool waiting time does not imply token use.</p>
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

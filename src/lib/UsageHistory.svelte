<script lang="ts">
	import { onMount } from 'svelte';
	import { hostQuery } from './protocol';
	import { analyzeUsage, type UsageEvent, type UsagePool } from './usage-analysis';
	import BenchmarkControls from './BenchmarkControls.svelte';
	import type { CostEstimate } from './usage-fit';
	let { host, sessionId, models, selectedModel, selectedEffort, onclose }: { host: string; sessionId: string; models: Array<{ id: string; displayName: string; efforts: string[] }>; selectedModel?: string; selectedEffort?: string; onclose: () => void } = $props();
	let dialog = $state<HTMLDialogElement>();
	let events = $state<UsageEvent[]>([]);
	let loading = $state(false);
	let error = $state('');
	let onlySession = $state(true);
	let onlyConcurrentPools = $state(false);
	let poolSetting = $state('');
	let windowDurationMins = $state<300 | 10080>(10080);
	const windowLabel = $derived(windowDurationMins === 300 ? '5-hour' : 'Weekly');
	const analysis = $derived(analyzeUsage(events, { host, windowDurationMins }));
	const pools = $derived(analysis.pools.filter((pool) =>
		pool.groups.some((group) => (!poolSetting || JSON.stringify([group.model, group.effort]) === poolSetting)
			&& (!onlyConcurrentPools || group.peakWorkers > 1))
	).slice(0, 100));
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
	const accountChange = (pool: UsagePool) => pool.weeklyLeftBefore - pool.weeklyLeftAfter;
	function observedRate(pool: UsagePool, tokenCount: number) {
		return pool.status === 'settled' && pool.groups.length === 1 && tokenCount > 0
			? accountChange(pool) / tokenCount * 100_000 : null;
	}
	function roundingRange(pool: UsagePool, tokenCount: number) {
		if (!tokenCount) return '';
		const change = accountChange(pool);
		return `Rounded endpoints allow roughly ${percent(Math.max(0, change - 1) / tokenCount * 100_000)}–${percent((change + 1) / tokenCount * 100_000)} per 100k tokens. External usage and reporting delay can add uncertainty.`;
	}
	function duration(start: number, end: number | null) {
		const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000));
		return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	}
	async function refresh() {
		if (loading) return;
		loading = true; error = '';
		try {
			const response = await fetch(`/api/usage${hostQuery(host)}`);
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? 'Could not load usage history');
			events = data.events ?? [];
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { loading = false; }
	}
	onMount(() => {
		dialog?.showModal(); void refresh();
		const timer = setInterval(() => void refresh(), 30_000);
		return () => clearInterval(timer);
	});
</script>

<dialog bind:this={dialog} aria-labelledby="usage-history-title" oncancel={onclose} onclick={(event) => { if (event.target === dialog) onclose(); }}>
	<div class="panel">
		<header>
			<h2 id="usage-history-title">Task allowance usage</h2>
			<button type="button" onclick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
			<button type="button" onclick={onclose} aria-label="Close usage history">×</button>
		</header>
		<label>Allowance window <select bind:value={windowDurationMins}><option value={10080}>7-day</option><option value={300}>5-hour</option></select></label>
		<p>Estimates use token usage from hosts with matching account fingerprints: {analysis.hosts.join(', ')}. {windowLabel} readings come from {host}. Each allowance window is calibrated separately. Usage outside Yacwu can still affect the allowance.</p>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<BenchmarkControls {host} {models} {selectedModel} {selectedEffort} oncomplete={() => void refresh()} />
		{#if windowDurationMins === 300}<p class="meta">Manual benchmarks target weekly allowance. Their 5-hour readings are analyzed independently here. Earlier recordings contain weekly readings only.</p>{/if}
		<h3>Model and thinking level</h3>
		<p class="meta">A clean single-setting window supplies a provisional rate immediately, including rounding uncertainty. It applies only to a similar token mix and upgrades to a fitted estimate with sufficient independent evidence. Mixed windows alone cannot identify a model's individual cost.</p>
		<p class="meta">{analysis.observations} pooled observations · {analysis.excludedIntervals} incomplete observations excluded, including windows where an agent ran without reporting tokens. Ordinary intervals close after at least 2% used, stable readings, and 60 seconds without token activity. Ranges are indicative uncertainty estimates, not guaranteed bounds.</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Model</th><th>Thinking</th><th>Samples</th><th>Tokens sampled</th><th>{windowLabel} cost / 100k (observed mix)</th><th>Uncached / cached / output per 100k</th></tr></thead>
				<tbody>
					{#each analysis.rates as rate}
						<tr><td>{rate.model}</td><td>{rate.effort}</td><td>{rate.samples}<small>{rate.singleSettingSamples} single-setting</small></td><td>{tokens(rate.tokens)}</td><td>{range(rate.estimate)}{#if rate.estimate}<small>{rate.estimate.provisional ? `Provisional · ${rate.estimate.samples} single-setting samples` : rate.estimate.weighted ? 'Fitted on token categories' : 'Total-token fallback'}</small>{:else if rate.samples && !rate.singleSettingSamples}<small>Only mixed windows so far</small>{/if}</td><td>{#if Object.values(rate.weights).some((weight) => weight !== null)}{percent(rate.weights.uncached)} / {percent(rate.weights.cached)} / {percent(rate.weights.output)}{:else}—<small>Not separable yet: windows had similar token mixes</small>{/if}</td></tr>
					{:else}<tr><td colspan="6">No tasks recorded yet. Recording begins after the updated backend starts.</td></tr>{/each}
				</tbody>
			</table>
		</div>
		<h3>Combined observation windows</h3>
		<p class="meta">All sessions on this account are included here. Sessions and agents using the same model and thinking level are added together; the selected allowance change is counted once per window. Single-setting windows provide a direct observed rate, even before enough samples exist for a fitted estimate.</p>
		<div class="pool-filters">
			<label>Model / thinking <select bind:value={poolSetting}>
				<option value="">All combinations</option>
				{#each analysis.rates as rate}<option value={JSON.stringify([rate.model, rate.effort])}>{rate.model} · {rate.effort}</option>{/each}
			</select></label>
			<label><input type="checkbox" bind:checked={onlyConcurrentPools} /> Concurrent workers only</label>
		</div>
		<div class="pool-list">
			{#each pools as pool}
				<details class="pool">
					<summary>
						<span>{new Date(pool.startedAt).toLocaleString()} → {new Date(pool.endedAt).toLocaleTimeString()}</span>
						<span class="pool-state">{pool.status}{pool.benchmark ? ' · benchmark' : ''} · {pool.groups.length === 1 ? `${pool.groups[0].model} · ${pool.groups[0].effort}` : 'Mixed settings'}</span>
						<span>{tokens(pool.groups.reduce((sum, group) => sum + group.tokens.totalTokens, 0))} tokens · {accountChange(pool)}% account change</span>
						<span>{Math.max(...pool.groups.map((group) => group.peakWorkers))} concurrent workers in one setting</span>
						{#if pool.groups.length === 1 && pool.status === 'settled'}
							<span class="pool-rate" title={roundingRange(pool, pool.groups[0].tokens.totalTokens)}>{percent(observedRate(pool, pool.groups[0].tokens.totalTokens))} / 100k</span>
						{/if}
					</summary>
					<p class="meta">Account {windowLabel.toLowerCase()} left: {pool.weeklyLeftBefore}% → {pool.weeklyLeftAfter}%. Window: {duration(pool.startedAt, pool.endedAt)}.
						{#if pool.status === 'accumulating'}Waiting for enough usage and stable readings; this window is not used for calibration yet.
						{:else if pool.status === 'excluded'}Incomplete or contaminated recording; excluded from calibration.
						{:else if pool.groups.length > 1}The account change belongs to the whole window; separate model costs require independent mixtures.
						{/if}
					</p>
					<div class="table-wrap">
						<table>
							<thead><tr><th>Model / thinking</th><th>Workers / turns</th><th>Combined tokens</th><th>Worker time</th><th>Observed {windowLabel.toLowerCase()} cost / 100k</th></tr></thead>
							<tbody>
								{#each pool.groups as group}
									<tr>
										<td>{group.model}<small>{group.effort}</small></td>
										<td>{new Set(group.contributors.map(({ task }) => `${task.host}:${task.threadId}`)).size} workers · {group.contributors.length} turns<small>{group.peakWorkers} running at once</small></td>
										<td title={`Input ${tokens(group.tokens.inputTokens)}, cached ${tokens(group.tokens.cachedInputTokens)}, output ${tokens(group.tokens.outputTokens)}, reasoning ${tokens(group.tokens.reasoningOutputTokens)}`}>{tokens(group.tokens.totalTokens)}<small>In {tokens(group.tokens.inputTokens)} · cached {tokens(group.tokens.cachedInputTokens)} · out {tokens(group.tokens.outputTokens)}</small></td>
										<td>{duration(0, group.workerMs)}<small>Sum of workers' time within this window</small></td>
										<td title={observedRate(pool, group.tokens.totalTokens) !== null ? roundingRange(pool, group.tokens.totalTokens) : undefined}>{pool.status !== 'settled' ? 'Pending / excluded' : pool.groups.length > 1 ? 'Shared across settings' : percent(observedRate(pool, group.tokens.totalTokens))}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<details class="contributors">
						<summary>Contributing sessions and agents</summary>
						{#each pool.groups as group}
							{#each group.contributors as contributor}
								<p class="meta" title={`Thread ${contributor.task.threadId} · turn ${contributor.task.turnId}`}>
									{contributor.task.host} · {contributor.task.parentThreadId ? 'agent' : 'session'} {contributor.task.threadId.slice(-8)} · {group.model} / {group.effort} · {tokens(contributor.tokens.totalTokens)} tokens
								</p>
							{/each}
						{/each}
					</details>
				</details>
			{:else}<p class="meta">No observation windows for this selection yet.</p>{/each}
		</div>
		<h3>Recorded tasks</h3>
		<label><input type="checkbox" bind:checked={onlySession} /> This session and its agents</label>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Started / status</th><th>Model / thinking</th><th>Tokens</th><th>Time</th><th>Account {windowLabel.toLowerCase()} left</th><th>Task estimate</th></tr></thead>
				<tbody>
					{#each tasks as task}
						<tr>
							<td title={`Thread ${task.threadId} · turn ${task.turnId}`}>{new Date(task.startedAt).toLocaleString()}<small>{task.host} · {task.threadId.slice(-8)} · {task.status}{task.benchmark ? ' · benchmark' : ''}{task.parentThreadId ? ' · agent' : ''}{task.overlapping ? ' · overlapping' : ''}{task.settling ? ' · settling' : ''}</small></td>
							<td>{task.model}<small>{task.effort}</small></td>
							<td title={`Input ${tokens(task.tokens.inputTokens)}, cached ${tokens(task.tokens.cachedInputTokens)}, output ${tokens(task.tokens.outputTokens)}, reasoning ${tokens(task.tokens.reasoningOutputTokens)}`}>{tokens(task.tokens.totalTokens)}{task.partialTokens ? ' (partial)' : ''}</td>
							<td>{duration(task.startedAt, task.endedAt)}</td>
							<td>{task.weeklyLeftBefore ?? '—'}% → {task.weeklyLeftAfter ?? '—'}%</td>
							<td>{task.partialTokens ? 'Partial recording' : range(task.estimate)}{#if task.estimate}<small>{task.estimate.samples} samples · {task.estimate.provisional ? 'provisional, similar token mix' : task.estimate.weighted ? 'weighted' : 'total-token fallback'}</small>{/if}</td>
						</tr>
					{:else}<tr><td colspan="6">No recorded tasks for this selection.</td></tr>{/each}
				</tbody>
			</table>
		</div>
		<p class="meta">Each task is one Codex turn; agents have their own rows. Shared account changes appear once in the combined windows above. Account readings on task rows include a settling period and can overlap later work. Separate uncached input, cached input and output weights are learned when identifiable; reasoning is included in output only once. Partial recordings remain unestimated. Tool waiting time does not imply token use.</p>
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
	.pool-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); }
	select { max-width: 100%; padding: var(--space-2xs); color: var(--color-ink); background: var(--color-paper-2); border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-input); }
	.pool-list { max-height: 50dvh; overflow: auto; margin-block: var(--space-xs); }
	.pool { padding: var(--space-xs); margin-block: var(--space-xs); border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-input); }
	summary { cursor: pointer; font-size: var(--text-xs); line-height: 1.6; }
	.pool > summary span { margin-inline-end: var(--space-sm); }
	.pool-state { color: var(--color-muted); }
	.pool-rate { font-weight: 600; }
	.contributors { padding-block: var(--space-xs); }
	table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
	th, td { padding: var(--space-xs); border-block-end: var(--rule-hair) solid var(--color-rule); text-align: start; vertical-align: top; white-space: nowrap; }
	th { position: sticky; top: 0; background: var(--color-paper-2); color: var(--color-muted); }
	small { display: block; margin-block-start: var(--space-3xs); }
</style>

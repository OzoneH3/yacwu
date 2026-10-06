<script lang="ts">
	import { onMount } from 'svelte';
	import { hostQuery } from './protocol';
	interface Choice { id: string; displayName: string; efforts: string[] }
	interface Status { status: string; message?: string; threadId?: string; turns?: number; usedPercent?: number; targetPercent?: number; model?: string; effort?: string; startedAt?: number; endedAt?: number; deadlineAt?: number; phase?: string; stableSeconds?: number; settleElapsedSeconds?: number; sampledAt?: number }
	let { host, models, selectedModel, selectedEffort, oncomplete }: { host: string; models: Choice[]; selectedModel?: string; selectedEffort?: string; oncomplete: () => void } = $props();
	let model = $state('');
	let effort = $state('');
	let targetPercent = $state(2);
	let maxTurns = $state(12);
	let minutes = $state(20);
	let status = $state<Status>({ status: 'idle' });
	let error = $state('');
	let pending = $state(false);
	let clock = $state(Date.now() / 1000);
	let pollPending = false;
	let requestVersion = 0;
	const efforts = $derived(models.find((choice) => choice.id === model)?.efforts ?? []);
	const running = $derived(['starting', 'running', 'settling', 'stopping'].includes(status.status));
	const elapsed = $derived(status.startedAt ? Math.max(0, Math.floor(((status.endedAt ?? clock) - status.startedAt) / 60)) : 0);
	const minutesLeft = $derived(status.deadlineAt ? Math.max(0, Math.ceil((status.deadlineAt - clock) / 60)) : 0);
	$effect(() => {
		if (!models.some((choice) => choice.id === model) && models.length) model = selectedModel && models.some((choice) => choice.id === selectedModel) ? selectedModel : models[0].id;
		if (efforts.length && !efforts.includes(effort)) effort = selectedEffort && efforts.includes(selectedEffort) ? selectedEffort : efforts[0];
	});
	async function poll() {
		if (pollPending) return;
		pollPending = true;
		const requestedHost = host;
		const version = requestVersion;
		try {
			const response = await fetch(`/api/usage/benchmark${hostQuery(requestedHost)}`);
			if (!response.ok) return;
			const next: Status = await response.json();
			if (requestedHost !== host || pending || version !== requestVersion) return;
			const wasRunning = running;
			status = next;
			if (['starting', 'running', 'settling', 'stopping'].includes(next.status) && models.some((choice) => choice.id === next.model)) {
				model = next.model!;
				if (next.effort) effort = next.effort;
			}
			if (wasRunning && !['starting', 'running', 'settling', 'stopping'].includes(next.status)) oncomplete();
		} catch { /* keep the last state through reconnects */ }
		finally { pollPending = false; }
	}
	async function submit(stop = false) {
		requestVersion++;
		pending = true; error = '';
		try {
			const response = await fetch(`/api/usage/benchmark${stop ? '/stop' : ''}${hostQuery(host)}`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify(stop ? {} : { model, effort, targetPercent, maxTurns, minutes })
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? 'Could not start benchmark');
			status = data;
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { pending = false; }
	}
	onMount(() => { void poll(); const timer = setInterval(() => { clock = Date.now() / 1000; void poll(); }, 3000); return () => clearInterval(timer); });
</script>

<details>
	<summary>Manual calibration benchmark</summary>
	<p>Measures allowance use with text workloads in a dedicated session. Only one benchmark can run across all hosts. Pause other work on the same account first. A target of at least 2 percentage points reduces rounding noise; the final turn can exceed it.</p>
	<form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
		<label>Model <select bind:value={model} disabled={running || pending}>{#each models as choice}<option value={choice.id}>{choice.displayName || choice.id}</option>{/each}</select></label>
		<label>Thinking <select bind:value={effort} disabled={running || pending}>{#each efforts as choice}<option value={choice}>{choice}</option>{/each}</select></label>
		<label>Weekly target (percentage points) <input type="number" min="2" max="5" step="1" required bind:value={targetPercent} disabled={running || pending} /></label>
		<label>Maximum turns <input type="number" min="1" max="100" required bind:value={maxTurns} disabled={running || pending} /></label>
		<label>Maximum minutes <input type="number" min="3" max="60" step="1" required bind:value={minutes} disabled={running || pending} /></label>
		{#if running}<button type="button" onclick={() => submit(true)} disabled={pending || status.status === 'stopping'}>Stop benchmark</button>
		{:else}<button type="submit" disabled={pending || !model || !effort}>Start benchmark — uses allowance</button>{/if}
	</form>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if status.status !== 'idle'}<p role="status">{status.status}: {status.message ?? ''}{#if status.turns !== undefined} · {status.turns} turns{/if}{#if status.usedPercent !== undefined} · {status.usedPercent}% observed / {status.targetPercent}% target{/if}{#if status.threadId} · <a href={`/s/${status.threadId}${hostQuery(host)}`}>Open benchmark session</a>{/if}</p>{/if}
	{#if status.startedAt}
		<p>{status.model} · {status.effort} thinking · {elapsed}m elapsed{#if running} · {minutesLeft}m until runtime limit{/if}</p>
	{/if}
	{#if status.status === 'settling'}
		<p>Sampling every 10 seconds · {status.settleElapsedSeconds ?? 0}s waiting · reading unchanged for {status.stableSeconds ?? 0}s (60s required).</p>
	{/if}
	{#if running && status.sampledAt && clock - status.sampledAt > 30 && status.status === 'settling'}<p class="meta">Waiting for a fresh allowance reading…</p>{/if}
	<p class="meta">Stable readings are provisional: delayed accounting and activity outside Yacwu can affect the result. This measures usage, not answer quality. Multiple runs may be needed to learn token costs.</p>
	<p class="meta">The runner continues with the browser closed. It stops at the target, a limit, a manual stop, or when other Yacwu work starts. A backend restart ends the runner; it does not restart automatically.</p>
</details>

<style>
	details { padding: var(--space-xs); border: var(--rule-hair) solid var(--color-rule); border-radius: var(--radius-input); }
	summary { cursor: pointer; font-weight: 600; font-size: var(--text-sm); }
	p { font-size: var(--text-xs); line-height: 1.5; }
	form { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-xs); }
	label { display: grid; gap: var(--space-3xs); font-size: var(--text-xs); }
	input { width: 7rem; }
	input, select, button { padding: var(--space-2xs); min-height: var(--control-height-compact); color: var(--color-ink); background: var(--color-paper-2); border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-input); }
	button { cursor: pointer; }
	:disabled { opacity: .5; }
	.error { color: var(--color-error); }
	.meta { color: var(--color-muted); }
	a { color: var(--color-accent); }
</style>

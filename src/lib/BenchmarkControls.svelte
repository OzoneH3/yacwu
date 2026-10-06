<script lang="ts">
	import { onMount } from 'svelte';
	import { hostQuery } from './protocol';
	interface Choice { id: string; displayName: string; efforts: string[] }
	interface Status { status: string; message?: string; threadId?: string; turns?: number; usedPercent?: number; targetPercent?: number; model?: string; effort?: string; startedAt?: number; endedAt?: number; deadlineAt?: number; phase?: string; stableSeconds?: number; settleElapsedSeconds?: number; sampledAt?: number; stageIndex?: number; stageTotal?: number; batchUsedPercent?: number; batchTargetPercent?: number; results?: Status[]; plan?: { model: string; effort: string; targetPercent: number }[] }
	let { host, models, selectedModel, selectedEffort, oncomplete }: { host: string; models: Choice[]; selectedModel?: string; selectedEffort?: string; oncomplete: () => void } = $props();
	let model = $state('');
	let effort = $state('');
	let targetPercent = $state(2);
	let maxTurns = $state(12);
	let minutes = $state(20);
	let batch = $state(false);
	let economical = $state(true);
	let selectedBatchModels = $state<string[] | null>(null);
	const eligibleModels = $derived(models.filter((choice) => choice.efforts.includes('low') && choice.efforts.includes('medium')));
	const batchModels = $derived((selectedBatchModels ?? eligibleModels.slice(0, 3).map((choice) => choice.id)).filter((id) => eligibleModels.some((choice) => choice.id === id)));
	const batchTarget = $derived(batchModels.length * (economical ? 2 : 4) + (economical && batchModels.length ? 1 : 0));
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
				body: JSON.stringify(stop ? {} : batch ? { batch: true, models: batchModels, economical, maxTurns, minutes } : { model, effort, targetPercent, maxTurns, minutes })
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
	<p>Measures allowance use with text workloads in dedicated sessions. Only one benchmark can run across all hosts. Pause other work on the same account first.</p>
	<form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
		<label>Mode <select bind:value={batch} disabled={running || pending}><option value={false}>Single combination</option><option value={true}>Models × Low / Medium</option></select></label>
		{#if batch}
			<fieldset disabled={running || pending}>
				<legend>Choose up to three models</legend>
				{#each eligibleModels as choice}
					<label class="check"><input type="checkbox" checked={batchModels.includes(choice.id)} disabled={!batchModels.includes(choice.id) && batchModels.length >= 3} onchange={(event) => { selectedBatchModels = event.currentTarget.checked ? [...batchModels, choice.id] : batchModels.filter((id) => id !== choice.id); }} />{choice.displayName || choice.id}</label>
				{/each}
				<label class="check"><input type="checkbox" bind:checked={economical} />Economical: 2% first, then 1% per combination</label>
			</fieldset>
		{:else}
		<label>Model <select bind:value={model} disabled={running || pending}>{#each models as choice}<option value={choice.id}>{choice.displayName || choice.id}</option>{/each}</select></label>
		<label>Thinking <select bind:value={effort} disabled={running || pending}>{#each efforts as choice}<option value={choice}>{choice}</option>{/each}</select></label>
		<label>Weekly target (percentage points) <input type="number" min="2" max="5" step="1" required bind:value={targetPercent} disabled={running || pending} /></label>
		{/if}
		<label>Maximum turns per combination <input type="number" min="1" max="100" required bind:value={maxTurns} disabled={running || pending} /></label>
		<label>Maximum minutes per combination <input type="number" min="3" max="60" step="1" required bind:value={minutes} disabled={running || pending} /></label>
		{#if running}<button type="button" onclick={() => submit(true)} disabled={pending || status.status === 'stopping'}>Stop benchmark</button>
		{:else}<button type="submit" disabled={pending || (batch ? !batchModels.length : !model || !effort)}>Start benchmark — uses allowance</button>{/if}
	</form>
	{#if batch && !running}
		<p>{batchModels.length * 2} combinations · {batchTarget} percentage points nominal target · up to {batchModels.length * 2 * minutes} minutes total. {economical ? 'The first combination targets 2%; later ones target 1% each.' : 'Each combination targets 2%.'}</p>
		<ol>{#each batchModels as id, index}{#each ['low', 'medium'] as level, effortIndex}<li>{models.find((choice) => choice.id === id)?.displayName || id} · {level} · {economical && (index > 0 || effortIndex > 0) ? 1 : 2}%</li>{/each}{/each}</ol>
	{/if}
	{#if (status.stageTotal ?? 0) > 1}<p>Combination {status.stageIndex ?? 1}/{status.stageTotal} · finished combinations: {status.batchUsedPercent ?? 0}% observed / {status.batchTargetPercent}% total target</p>{/if}
	{#if running && (status.stageTotal ?? 0) > 1 && status.plan}
		<ol>{#each status.plan as stage, index}<li>{index + 1 === status.stageIndex ? 'Current: ' : ''}{models.find((choice) => choice.id === stage.model)?.displayName || stage.model} · {stage.effort} · {stage.targetPercent}%</li>{/each}</ol>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if status.status !== 'idle'}<p role="status">{status.status}: {status.message ?? ''}{#if status.turns !== undefined} · {status.turns} turns{/if}{#if status.usedPercent !== undefined} · {status.usedPercent}% observed / {status.targetPercent}% target{/if}{#if status.threadId} · <a href={`/s/${status.threadId}${hostQuery(host)}`}>Open benchmark session</a>{/if}</p>{/if}
	{#if status.startedAt}
		<p>{status.model} · {status.effort} thinking · {elapsed}m elapsed{#if running} · {minutesLeft}m until runtime limit{/if}</p>
	{/if}
	{#if status.status === 'settling'}
		<p>Sampling every 10 seconds · {status.settleElapsedSeconds ?? 0}s waiting · reading unchanged for {status.stableSeconds ?? 0}s (60s required).</p>
	{/if}
	{#if running && status.sampledAt && clock - status.sampledAt > 30 && status.status === 'settling'}<p class="meta">Waiting for a fresh allowance reading…</p>{/if}
	{#if status.results?.length}
		<ol>{#each status.results as result}<li>{result.model} · {result.effort} · {result.usedPercent}% observed / {result.targetPercent}% target · {result.turns} turns{#if result.threadId} · <a href={`/s/${result.threadId}${hostQuery(host)}`}>Session</a>{/if}</li>{/each}</ol>
	{/if}
	<p class="meta">Switches after a completed turn and settled allowance reading, carrying that baseline into the next combination. Turns and delayed reporting can overshoot targets; 1% samples retain rounding uncertainty. A partial combination stops the remaining batch.</p>
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
	fieldset { display: grid; gap: var(--space-2xs); border: var(--rule-hair) solid var(--color-rule); }
	legend, li { font-size: var(--text-xs); }
	.check { display: flex; align-items: center; }
	.check input { width: auto; }
	input, select, button { padding: var(--space-2xs); min-height: var(--control-height-compact); color: var(--color-ink); background: var(--color-paper-2); border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-input); }
	button { cursor: pointer; }
	:disabled { opacity: .5; }
	.error { color: var(--color-error); }
	.meta { color: var(--color-muted); }
	a { color: var(--color-accent); }
</style>

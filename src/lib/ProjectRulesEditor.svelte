<script lang="ts">
	import { onMount } from 'svelte';
	import { projectRulesStatusText, type ProjectRulesState } from './project-rules';

	let {
		api,
		onstatus
	}: {
		/** URL of this session's /project-rules endpoint. */
		api: string;
		onstatus?: (state: ProjectRulesState) => void;
	} = $props();

	let info = $state<ProjectRulesState | null>(null);
	let text = $state('');
	let message = $state('');
	let saving = $state(false);

	async function load() {
		try {
			const response = await fetch(api);
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? `Could not load project rules (${response.status})`);
			info = data;
			text = data.current.text;
			onstatus?.(data);
		} catch (error) {
			message = error instanceof Error ? error.message : 'Could not load project rules';
		}
	}

	async function save() {
		saving = true;
		message = '';
		try {
			const response = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? `Could not save project rules (${response.status})`);
			await load();
			message = 'Saved. New sessions in this project start with these rules.';
		} catch (error) {
			message = error instanceof Error ? error.message : 'Could not save project rules';
		} finally {
			saving = false;
		}
	}

	onMount(() => { void load(); });
</script>

<section class="project-rules" aria-labelledby="project-rules-title">
	<h3 id="project-rules-title">{info ? `Project rules · ${info.current.name}` : 'Project rules'}</h3>
	<p>Shared by every session and worktree of this project, in addition to the repository's AGENTS.md or CLAUDE.md. A session receives them once, when it starts; editing them does not change sessions that are already running.</p>
	{#if info}
		<p class="status" class:outdated={info.status === 'outdated'} role="status">{projectRulesStatusText(info)}</p>
		<label for="project-rules-text">{info.current.version ? `Rules (version ${info.current.version})` : 'Rules'}</label>
		<textarea id="project-rules-text" bind:value={text} rows="7" placeholder="For example: Reuse before creating. Extend existing code before adding a parallel implementation, and explain why when you can't."></textarea>
		<div class="actions">
			<button type="button" onclick={save} disabled={saving || text.trim() === info.current.text}>{saving ? 'Saving…' : 'Save project rules'}</button>
			{#if message}<span role="status">{message}</span>{/if}
		</div>
	{:else if message}
		<p class="status" role="alert">{message}</p>
	{:else}
		<p class="status">Loading…</p>
	{/if}
</section>

<style>
	.project-rules { margin-block: 1rem; padding-block-end: 1rem; border-block-end: 1px solid var(--color-rule); }
	h3 { margin: 0 0 .5rem; font-size: .95rem; }
	p { margin: .4rem 0 .8rem; color: var(--color-muted); font-size: .8rem; line-height: 1.45; }
	.status { color: var(--color-ink-2); }
	.status.outdated { color: var(--color-error); }
	label { display: block; font-size: .85rem; margin-top: .75rem; }
	textarea { width: 100%; box-sizing: border-box; margin-top: .5rem; padding: .6rem; border: 1px solid var(--color-rule); border-radius: .4rem; background: var(--color-paper); color: var(--color-ink); font: inherit; font-size: .85rem; resize: vertical; }
	.actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-top: .5rem; }
	button { color: var(--color-ink); background: var(--color-paper); border: 1px solid var(--color-rule); border-radius: .4rem; padding: .4rem .6rem; cursor: pointer; }
	button:disabled { opacity: .55; cursor: default; }
	.actions span { color: var(--color-muted); font-size: .8rem; }
</style>

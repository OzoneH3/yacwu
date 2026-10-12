<script lang="ts">
	import { onMount } from 'svelte';

	interface DirectoryChoice {
		name: string;
		kind: string;
		symlink?: boolean;
	}

	/**
	 * Browse folders on a host and pick one. Browsing into a folder selects it
	 * (`onnavigate`), so a caller never silently keeps the folder shown before;
	 * the current-path button uses it (`onuse`).
	 */
	let {
		id,
		host = null,
		start = '',
		label = 'Choose a folder',
		loading = $bindable(false),
		onnavigate,
		onuse
	}: {
		id?: string;
		/** A remote host to list folders on; null lists this machine's. */
		host?: string | null;
		/** Folder to open first; empty opens the server's default folder. */
		start?: string;
		label?: string;
		loading?: boolean;
		onnavigate: (path: string) => void;
		onuse: (path: string) => void;
	} = $props();

	let path = $state('');
	let entries = $state<DirectoryChoice[]>([]);
	let error = $state<string | null>(null);
	let showHidden = $state(false);
	let request = 0;
	const visibleEntries = $derived(entries.filter((entry) => showHidden || !entry.name.startsWith('.')));

	function parentOf(folder: string): string {
		const normalized = folder.replace(/[\\/]+$/, '');
		const slash = normalized.lastIndexOf('/');
		if (slash <= 0) return normalized.startsWith('/') ? '/' : normalized;
		return normalized.slice(0, slash);
	}

	async function browse(folder?: string) {
		const current = ++request;
		loading = true;
		error = null;
		try {
			const params = new URLSearchParams();
			if (host) params.set('host', host);
			if (folder) params.set('path', folder);
			const res = await fetch(`/api/directories?${params.toString()}`);
			const data = await res.json();
			if (current !== request) return;
			if (!res.ok) throw new Error(data.error ?? 'Could not list this directory');
			path = data.path ?? '';
			if (path) onnavigate(path);
			entries = (data.entries ?? []).filter((entry: DirectoryChoice) => entry.kind === 'dir');
		} catch (err) {
			if (current !== request) return;
			error = err instanceof Error ? err.message : 'Could not list this directory';
			entries = [];
		} finally {
			if (current === request) loading = false;
		}
	}

	onMount(() => {
		void browse(start || undefined);
		return () => {
			request++;
			loading = false;
		};
	});
</script>

<div class="cwd-browser" {id} aria-label={label}>
	<div class="cwd-browser-toolbar">
		<button class="cwd-up" type="button" onclick={() => browse(parentOf(path))} disabled={!path || parentOf(path) === path} aria-label="Go to parent folder" title="Parent folder">↑</button>
		<button
			class="cwd-current"
			type="button"
			title="Use this folder"
			aria-label={`Use folder ${path || 'current directory'}`}
			disabled={!path || loading}
			onclick={() => onuse(path)}
		>{path || 'Choose a folder'}</button>
	</div>
	<label class="cwd-hidden-toggle">
		<input type="checkbox" bind:checked={showHidden} />
		<span>Show hidden folders</span>
	</label>
	{#if loading}
		<p class="cwd-browser-message">Loading folders…</p>
	{:else if error}
		<p class="cwd-browser-message error">{error}</p>
	{:else if visibleEntries.length === 0}
		<p class="cwd-browser-message">No subfolders here.</p>
	{:else}
		<div class="cwd-directory-list" role="group" aria-label="Subfolders">
			{#each visibleEntries as entry (entry.name)}
				<button class="cwd-directory" type="button" onclick={() => browse(`${path.replace(/[\\/]+$/, '')}/${entry.name}`)}>
					<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
					<span>{entry.name}</span><span aria-hidden="true">›</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.cwd-browser {
		display: flex;
		flex-direction: column;
		min-width: 0;
		max-height: 17rem;
		overflow: hidden;
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-input);
		background: var(--color-paper);
		box-shadow: var(--shadow-card);
	}

	.cwd-browser-toolbar {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		min-width: 0;
		padding: var(--space-2xs);
		border-block-end: var(--rule-hair) solid var(--color-rule);
	}

	.cwd-up {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: var(--control-height-compact);
		min-height: var(--control-height-compact);
		padding: 0;
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-input);
		background: var(--color-paper);
		color: var(--color-neutral);
		cursor: pointer;
		font-size: var(--text-md);
		font-weight: 600;
	}

	.cwd-up:disabled {
		cursor: default;
		opacity: 0.48;
	}

	.cwd-current {
		appearance: none;
		border: 0;
		padding: var(--space-3xs);
		background: transparent;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		color: var(--color-muted);
		cursor: pointer;
		font-family: var(--font-outlier);
		font-size: 0.68rem;
		text-align: start;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cwd-current:hover:not(:disabled),
	.cwd-current:focus-visible {
		color: var(--color-accent-active);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	.cwd-current:disabled {
		cursor: default;
	}

	.cwd-hidden-toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		min-height: var(--control-height-compact);
		padding-inline: var(--space-xs);
		border-block-end: var(--rule-hair) solid var(--color-rule);
		color: var(--color-muted);
		cursor: pointer;
		font-size: var(--text-xs);
	}

	.cwd-hidden-toggle input {
		width: 1rem;
		height: 1rem;
		margin: 0;
		accent-color: var(--color-accent-active);
	}

	.cwd-directory-list {
		min-height: 0;
		overflow: auto;
		padding: var(--space-3xs);
	}

	.cwd-directory {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		width: 100%;
		min-height: var(--control-height-compact);
		padding: var(--space-3xs) var(--space-2xs);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-neutral);
		cursor: pointer;
		font-size: var(--text-sm);
		text-align: start;
	}

	.cwd-directory svg {
		width: 1rem;
		height: 1rem;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.75;
	}

	.cwd-directory span:first-of-type {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cwd-browser-message {
		margin: 0;
		padding: var(--space-xs);
		color: var(--color-muted);
		font-size: var(--text-xs);
	}

	.cwd-browser-message.error {
		color: var(--color-error);
	}

	@media (hover: hover) and (pointer: fine) {
		.cwd-up:hover:not(:disabled),
		.cwd-directory:hover {
			background: var(--color-paper-3);
			color: var(--color-ink);
		}
	}
</style>

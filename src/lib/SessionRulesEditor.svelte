<script lang="ts">
	import { defaultSessionRules, type SessionRules } from './session-rules';
	let {
		rules,
		onsave,
		relayEnabled = null,
		onrelaychange,
		defaults = defaultSessionRules
	}: {
		rules: SessionRules;
		/** What "Reset defaults" restores: the global session rule defaults. */
		defaults?: SessionRules;
		onsave: (rules: SessionRules) => boolean;
		/** Server-side setting; null until loaded. */
		relayEnabled?: boolean | null;
		onrelaychange?: (enabled: boolean) => Promise<boolean>;
	} = $props();
	let progress = $state(true);
	let sharedChannel = $state(true);
	let custom = $state('');
	$effect(() => { progress = rules.progress; sharedChannel = rules.sharedChannel; custom = rules.custom; });
	let saved = $state(false);
	let relayStatus = $state('');
	function save() { saved = onsave({ progress, sharedChannel, custom }); }
	async function changeRelay(event: Event) {
		const enabled = (event.currentTarget as HTMLInputElement).checked;
		relayStatus = 'Saving…';
		relayStatus = (await onrelaychange?.(enabled)) ? 'Saved on the server' : 'Could not save; reload to see the current setting';
	}
</script>

<section class="session-rules" aria-labelledby="session-rules-title">
	<h3 id="session-rules-title">Session rules</h3>
	<p>Saved in this browser for this session. Changes apply to future prompts, not a task already running.</p>
	<label><input type="checkbox" bind:checked={progress} onchange={() => saved = false} /> Progress reporting</label>
	<p class="description">Estimate completion and time remaining, update roughly once a minute, and finish at 100%.</p>
	<label><input type="checkbox" bind:checked={sharedChannel} onchange={() => saved = false} /> Shared background coordination</label>
	<p class="description">Check and publish coordination notes for sessions in the same project folder, and send direct messages to them. Disabling does not erase existing notes or transcript instructions.</p>
	<label><input type="checkbox" checked={relayEnabled ?? true} disabled={relayEnabled === null} onchange={changeRelay} /> Accept direct messages from other sessions</label>
	<p class="description">Stored on the server and applied immediately, for every browser. Turning it off refuses new messages and drops ones still queued. Without a choice here the session follows the default in Settings; a choice here lasts until the server restarts.{#if relayStatus} <span role="status">{relayStatus}</span>{/if}</p>
	<details><summary>Image display rule · built-in</summary><p>Show generated images using a local file and an <code>&lt;agent-img&gt;</code> block. This is a backend instruction, not an editable per-prompt rule.</p></details>
	<label for="session-custom-rules">Additional instructions</label>
	<textarea id="session-custom-rules" bind:value={custom} oninput={() => saved = false} rows="5" placeholder="For example: check the README before committing feature changes."></textarea>
	<div class="actions">
		<button type="button" onclick={save}>Save rules</button>
		<button type="button" onclick={() => { progress = defaults.progress; sharedChannel = defaults.sharedChannel; custom = ''; save(); }}>Reset defaults</button>
		{#if saved}<span role="status">Saved</span>{/if}
	</div>
</section>

<style>
	.session-rules { margin-block: 1rem; padding-block: 1rem; border-block: 1px solid var(--color-rule); }
	h3 { margin: 0 0 .5rem; font-size: .95rem; }
	p { margin: .4rem 0 .8rem; color: var(--color-muted); font-size: .8rem; line-height: 1.45; }
	label { display: flex; align-items: center; gap: .5rem; font-size: .85rem; margin-top: .75rem; }
	.description { margin-left: 1.5rem; }
	textarea { width: 100%; box-sizing: border-box; margin-top: .5rem; padding: .6rem; border: 1px solid var(--color-rule); border-radius: .4rem; background: var(--color-paper); color: var(--color-ink); font: inherit; font-size: .85rem; resize: vertical; }
	details { font-size: .85rem; margin-block: .8rem; }
	summary { cursor: pointer; }
	.actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-top: .5rem; }
	button { color: var(--color-ink); background: var(--color-paper); border: 1px solid var(--color-rule); border-radius: .4rem; padding: .4rem .6rem; cursor: pointer; }
	.actions span { color: var(--color-muted); font-size: .8rem; }
</style>

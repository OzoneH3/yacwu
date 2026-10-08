<script lang="ts">
	import { suggestPromptSettings, type SuggestionModel } from './model-suggestion';
	let { prompt, models, attachments = 0, disabled = false, running = false, onapply } = $props<{
		prompt: string; models: SuggestionModel[]; attachments?: number; disabled?: boolean;
		running?: boolean; onapply: (model: string, effort: string) => Promise<void>;
	}>();
	let open = $state(false);
	const suggestion = $derived(suggestPromptSettings(prompt, models, attachments));
</script>

<div class="suggestion">
	<button type="button" class="suggest" disabled={!suggestion || disabled} onclick={() => open = !open} aria-expanded={open}>Suggest settings</button>
	{#if open && suggestion}
		<section class="panel" aria-label="Suggested prompt settings">
			<div class="heading"><strong>{suggestion.name}{#if suggestion.effort} · {suggestion.effort} effort{/if}</strong><button type="button" onclick={() => open = false} aria-label="Close suggestion">×</button></div>
			<p>{suggestion.reason}</p>
			<small>{suggestion.caveat}</small>
			{#if running}<p>Applies to the next turn. Use the restart button to change the running prompt.</p>{/if}
			<footer><a href={suggestion.guidanceUrl} target="_blank" rel="noreferrer">Selection guidance</a><button type="button" disabled={disabled} onclick={() => onapply(suggestion!.model, suggestion!.effort)}>Apply settings</button></footer>
		</section>
	{/if}
</div>

<style>
	.suggestion { position: relative; }
	button { font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--color-rule); background: var(--color-paper); border-radius: 6px; padding: 5px 9px; }
	button:disabled { opacity: .5; cursor: default; }
	.suggest { font-size: 12px; white-space: nowrap; }
	.panel { position: absolute; bottom: calc(100% + 12px); right: 0; width: min(380px, calc(100vw - 48px)); padding: 14px; background: var(--color-paper-3); color: var(--color-ink); border: 1px solid var(--color-rule); border-radius: 10px; box-shadow: var(--shadow-popover); z-index: 25; font-size: 13px; }
	.heading, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	p { margin: 10px 0; }
	small { opacity: .75; }
	footer { margin-top: 12px; }
	a { color: inherit; }
	@media (max-width: 600px) {
		.panel { position: fixed; left: 16px; right: 16px; bottom: 140px; width: auto; max-height: 55vh; overflow: auto; }
	}
</style>

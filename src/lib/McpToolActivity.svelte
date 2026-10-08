<script lang="ts">
	import type { ThreadItem } from './protocol';
	import { mcpActivityDetails, mcpActivityLabel } from './mcp-activity';
	let { item }: { item: ThreadItem } = $props();
	let expanded = $state(false);
	const status = $derived((item as any).status === 'inProgress' ? 'running' : (item as any).status ?? 'tool call');
</script>

<div class="mcp-activity">
	<details ontoggle={(event) => expanded = event.currentTarget.open}>
		<summary><span class="tool-label">{mcpActivityLabel(item)}</span><span class="status" class:failed={status === 'failed'}>{status}{#if typeof (item as any).durationMs === 'number'} · {((item as any).durationMs / 1000).toFixed(1)}s{/if}</span></summary>
		{#if expanded}<pre>{mcpActivityDetails(item) || 'No arguments or result reported yet.'}</pre>{/if}
	</details>
</div>

<style>
	.mcp-activity { padding-block: var(--space-2xs); color: var(--color-ink-2); font-size: var(--text-sm); }
	summary { cursor: pointer; padding: var(--space-2xs) var(--space-xs); border: 1px solid var(--color-rule); border-radius: var(--radius-input); background: var(--color-paper-2); }
	.tool-label { overflow-wrap: anywhere; }
	.status { margin-left: var(--space-xs); color: var(--color-muted); white-space: nowrap; }
	.status.failed { color: var(--color-error); }
	pre { margin: var(--space-xs) 0; padding: var(--space-xs); max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--color-paper-2); color: var(--color-ink); font-size: var(--text-xs); }
</style>

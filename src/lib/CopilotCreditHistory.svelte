<script lang="ts">
 import { onMount } from 'svelte';
 import type { UsageTask } from './usage-analysis';
 import { copilotTaskCredits, creditLabel, creditTitle, COPILOT_RATE_CARD_DATE } from './copilot-credits';
 let { tasks, host, sessionId, onclose, onrefresh }: { tasks: UsageTask[]; host: string; sessionId: string | null; onclose: () => void; onrefresh: () => Promise<void> } = $props();
 let dialog = $state<HTMLDialogElement>();
 let onlySession = $state(true);
 let loading = $state(false);
 const rows = $derived(tasks.filter(task => task.host === host && (!task.parentThreadId || task.threadId === sessionId) && (!onlySession || task.threadId === sessionId)).slice(0, 100));
 async function refresh() { loading = true; try { await onrefresh(); } finally { loading = false; } }
 onMount(() => { dialog?.showModal(); void refresh(); });
</script>

<dialog bind:this={dialog} aria-labelledby="copilot-credit-title" oncancel={onclose} onclick={event => { if (event.target === dialog) onclose(); }}>
 <header><h2 id="copilot-credit-title">Copilot task credits</h2><button type="button" onclick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button><button type="button" onclick={onclose} aria-label="Close credit history">×</button></header>
 <p>Account allowance unavailable. These task estimates are not your account balance.</p>
 <p class="meta">Rates dated {COPILOT_RATE_CARD_DATE}. Cache-write splits and per-request context tiers are not available in current recordings, so estimates may be ranges. Recorded descendant work is included. Incomplete rows show known subtotals.</p>
 <label><input type="checkbox" bind:checked={onlySession} /> This session</label>
 <div class="table-wrap"><table>
  <thead><tr><th>Task started</th><th>Model</th><th>Status</th><th>Estimated credits used</th></tr></thead>
  <tbody>{#each rows as task (`${task.threadId}:${task.turnId}`)}
   {@const estimate = copilotTaskCredits(tasks, task)}
   <tr><td>{new Date(task.startedAt).toLocaleString()}<small>{task.threadId.slice(-8)}</small></td><td>{task.model}<small>{task.effort}</small></td><td>{task.status}</td><td title={creditTitle(estimate)}>{creditLabel(estimate)}</td></tr>
  {:else}<tr><td colspan="4">No recorded tasks for this selection.</td></tr>{/each}</tbody>
 </table></div>
</dialog>

<style>
 dialog { position: fixed; inset: 0; margin: auto; width: min(calc(100% - 2rem), 68rem); max-height: calc(100dvh - 2rem); overflow: auto; padding: var(--space-sm); border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-card); color: var(--color-ink); background: var(--color-paper); }
 dialog::backdrop { background: var(--color-overlay); }
 header { display: flex; align-items: center; gap: var(--space-xs); }
 h2 { flex: 1; font-size: var(--text-lg); }
 p, label { font-size: var(--text-sm); line-height: 1.5; }
 .meta, small { color: var(--color-muted); font-size: var(--text-xs); }
 small { display: block; }
 button { padding: var(--space-xs); color: var(--color-ink); background: var(--color-paper-2); border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-input); cursor: pointer; }
 .table-wrap { overflow: auto; margin-block: var(--space-xs); }
 table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
 th, td { padding: var(--space-xs); border-bottom: var(--rule-hair) solid var(--color-rule); text-align: start; }
</style>

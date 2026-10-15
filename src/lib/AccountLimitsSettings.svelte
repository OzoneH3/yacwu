<script lang="ts">
 import { onMount } from 'svelte';
 let codex = $state(0), copilot = $state(0);
 let loading = $state(true), saving = $state(false), loaded = $state(false);
 let status = $state('');
 onMount(() => { void load(); });
 async function load() {
  try {
   const res = await fetch('/api/account/limits');
   if (!res.ok) throw new Error();
   const data = await res.json();
   if (!Number.isInteger(data.codexReservePercent) || !Number.isInteger(data.copilotCreditLimit)) throw new Error();
   codex = data.codexReservePercent; copilot = data.copilotCreditLimit; loaded = true;
  } catch { status = 'Could not load account limits. Reopen Settings to retry.'; }
  finally { loading = false; }
 }
 async function save(event: SubmitEvent) {
  event.preventDefault(); saving = true; status = '';
  try {
   const res = await fetch('/api/account/limits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codexReservePercent: codex, copilotCreditLimit: copilot }) });
   if (!res.ok) throw new Error();
   status = 'Account limits saved on the server.';
  } catch { status = 'Could not confirm account limits were saved. Reopen Settings to check.'; }
  finally { saving = false; }
 }
</script>
<section aria-labelledby="settings-account-limits">
 <h3 id="settings-account-limits">Account usage limits</h3>
 <p>Saved on this server for all browsers and sessions. Reaching a limit stops running tasks and blocks new prompts and queued messages. 0 disables that provider’s limit.</p>
 <form onsubmit={save}>
  <fieldset disabled={loading || saving || !loaded}>
   <label>Codex reserve (% remaining)<input type="number" min="0" max="100" step="1" required bind:value={codex} /></label>
   <p>Keep this percentage of either Codex allowance window unused.</p>
   <label>Copilot credit limit (used this cycle)<input type="number" min="0" max="1000000000" step="1" required bind:value={copilot} /></label>
   <p>Stop at this billing-cycle account credit total, including usage outside Yacwu. Uses the GitHub CLI account shown in the session; it may differ from the Copilot CLI login.</p>
   <button type="submit">{saving ? 'Saving…' : 'Save account limits'}</button>
  </fieldset>
 </form>
 <p>Enabled limits block work when account usage cannot be verified. Stops follow account readings, which may be delayed by several minutes, so usage can exceed the chosen limit. Existing stopped tasks require you to resume them.</p>
 {#if status}<p role="status">{status}</p>{/if}
</section>
<style>
 section { border-top: 1px solid var(--color-rule-1); padding-top: var(--space-sm); margin-top: var(--space-sm); }
 h3 { font-size: var(--text-sm); margin: 0 0 var(--space-xs); }
 p { font-size: var(--text-xs); color: var(--color-ink-2); margin: var(--space-xs) 0; }
 fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
 label { display: flex; justify-content: space-between; align-items: center; gap: var(--space-sm); font-size: var(--text-sm); padding: var(--space-xs) 0; }
 input { width: 9rem; max-width: 40%; color: var(--color-ink); background: var(--color-paper); border: 1px solid var(--color-rule-2); padding: .3rem; }
 button { margin-top: var(--space-xs); }
</style>

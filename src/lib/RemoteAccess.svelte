<script lang="ts">
 import { onMount } from 'svelte';
 import type { HostInfo } from './protocol';
 let { hosts, onconnected, onremoved, onclose }: { hosts: HostInfo[]; onconnected: (host: string) => void | Promise<void>; onremoved: (host: string) => void | Promise<void>; onclose: () => void } = $props();
 let dialog: HTMLDialogElement;
 let hostname = $state(''), username = $state(''), port = $state(22), hours = $state(24), password = $state('');
 let busy = $state(false), error = $state(''), message = $state(''), removing = $state('');
 let confirmation = $state<{ fingerprint: string; prompt: string } | null>(null);
 const managed = $derived(hosts.filter(host => typeof host.temporaryAccessExpiresAt === 'number'));
 function changed() { confirmation = null; error = ''; }
 function close() { if (!busy) { password = ''; confirmation = null; onclose(); } }
 async function submit(action: 'setup' | 'revoke', host = removing, confirm = false) {
  if (busy) return;
  busy = true; error = ''; message = '';
  const body = action === 'setup' ? { hostname, username, port, hours, password } : { host, password };
  try {
   const response = await fetch(action === 'setup' ? '/api/hosts/access' : '/api/hosts/access/revoke', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, ...(confirm && confirmation ? { confirmedFingerprint: confirmation.fingerprint } : {}) })
   });
   const data = await response.json();
   if (data.confirmationRequired && typeof data.fingerprint === 'string') {
    confirmation = { fingerprint: data.fingerprint, prompt: data.prompt }; return;
   }
   confirmation = null;
   password = '';
   if (!response.ok || !data.ok) {
    if (data.needsPassword) removing = host;
    throw new Error(data.error ?? 'SSH access could not be updated.');
   }
   if (action === 'setup') {
    await onconnected(data.host);
    message = `Access created. Expires ${new Date(data.expiresAt).toLocaleString()}.`;
   } else {
    await onremoved(host); removing = ''; message = 'SSH key revoked and local copy removed.';
   }
  } catch (e) { error = e instanceof Error ? e.message : 'SSH access could not be updated.'; }
  finally { busy = false; }
 }
 onMount(() => { dialog.showModal(); return () => { password = ''; }; });
</script>

<dialog bind:this={dialog} aria-labelledby="ssh-access-title" oncancel={event => { event.preventDefault(); close(); }}>
 <div class="access-panel">
  <header><h2 id="ssh-access-title">Remote SSH access</h2><button type="button" onclick={close} disabled={busy} aria-label="Close remote SSH access">×</button></header>
  <p>Sign in once to create an expiring SSH key. Your password is used for setup and is not saved.</p>
  {#if managed.length}
   <section aria-label="Temporary SSH access">
    {#each managed as host (host.name)}
     <div class="managed"><div><strong>{host.name.replace(/^yacwu-/, '')}</strong><small>{host.temporaryAccessExpiresAt! <= Date.now() ? 'Expired' : 'Expires'} {new Date(host.temporaryAccessExpiresAt!).toLocaleString()}</small></div>
      <button type="button" disabled={busy} onclick={() => { removing = host.name; password = ''; confirmation = null; void submit('revoke', host.name); }}>Remove access</button>
     </div>
    {/each}
   </section>
  {/if}
  {#if removing}
   <form onsubmit={event => { event.preventDefault(); void submit('revoke'); }}>
    <p>Removing access for {removing.replace(/^yacwu-/, '')}. If the key expired, enter the account password to remove it remotely.</p>
    <label>Password<input type="password" bind:value={password} autocomplete="off" disabled={busy} /></label>
    <div class="actions"><button type="button" disabled={busy} onclick={() => { removing = ''; password = ''; confirmation = null; error = ''; }}>Cancel removal</button><button type="submit" disabled={busy}>Retry removal</button></div>
   </form>
  {:else}
   <form onsubmit={event => { event.preventDefault(); void submit('setup'); }}>
    <fieldset disabled={busy}>
     <label>Host<input bind:value={hostname} oninput={changed} placeholder="server.example.com" autocomplete="off" required /></label>
     <label>Username<input bind:value={username} oninput={changed} autocomplete="off" required /></label>
     <label>Port<input type="number" bind:value={port} oninput={changed} min="1" max="65535" required /></label>
     <label>Access lasts<select bind:value={hours} onchange={changed}><option value={1}>1 hour</option><option value={8}>8 hours</option><option value={24}>24 hours</option><option value={168}>7 days</option></select></label>
     <label>Password<input type="password" bind:value={password} autocomplete="off" required /></label>
     <button type="submit">{busy ? 'Setting up…' : 'Create temporary access'}</button>
    </fieldset>
   </form>
  {/if}
  {#if confirmation}
   <section class="confirmation" aria-label="Confirm SSH host">
    <p>Confirm this host fingerprint with the server owner before connecting:</p>
    <strong>{confirmation.fingerprint}</strong>
    <details><summary>Host details</summary><pre>{confirmation.prompt}</pre></details>
    <button type="button" disabled={busy} onclick={() => void submit(removing ? 'revoke' : 'setup', removing, true)}>Trust host and continue</button>
   </section>
  {/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <p class="note">The remote server needs OpenSSH with expiring-key support and Codex installed. Expiry closes Yacwu’s connection; remote tasks keep running. Removing access revokes this key.</p>
 </div>
</dialog>

<style>
 dialog { width: min(34rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); border: 1px solid var(--color-rule-2); border-radius: var(--radius-input); padding: 0; color: var(--color-ink-1); background: var(--color-paper); }
 dialog::backdrop { background: #0006; }
 .access-panel { padding: 1.25rem; }
 header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
 h2 { margin: 0; font-size: 1.2rem; }
 p { line-height: 1.5; }
 fieldset { border: 0; padding: 0; display: grid; gap: .7rem; margin: 0; }
 label { display: grid; gap: .25rem; font-size: .85rem; }
 input, select { min-width: 0; padding: .45rem; color: inherit; background: var(--color-paper); border: 1px solid var(--color-rule-2); border-radius: .25rem; }
 button { padding: .45rem .65rem; cursor: pointer; }
 button:disabled { cursor: wait; opacity: .6; }
 .managed { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .7rem 0; border-bottom: 1px solid var(--color-rule-2); }
 .managed strong, small { display: block; overflow-wrap: anywhere; }
 small, .note { color: var(--color-ink-2); font-size: .8rem; }
 .confirmation { margin-top: 1rem; padding: .7rem; border: 1px solid var(--color-rule-2); }
 .confirmation strong { overflow-wrap: anywhere; }
 pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .75rem; }
 .error { color: var(--color-error, #c33); }
 .actions { display: flex; gap: .5rem; margin-top: .5rem; }
</style>

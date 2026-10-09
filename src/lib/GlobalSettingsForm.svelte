<script lang="ts">
	import { clampSetting, defaultSettings, settingRanges, type GlobalSettings } from './settings';

	let {
		settings,
		theme,
		onchange,
		onthemechange,
		relayDefault = null,
		onrelaydefaultchange
	}: {
		settings: GlobalSettings;
		theme: 'light' | 'dark';
		onchange: (settings: GlobalSettings) => void;
		onthemechange: (theme: 'light' | 'dark') => void;
		/** Server-side default for direct messages; null until loaded. */
		relayDefault?: boolean | null;
		onrelaydefaultchange?: (accept: boolean) => Promise<boolean>;
	} = $props();
	let relayStatus = $state('');
	async function changeRelayDefault(event: Event) {
		const accept = (event.currentTarget as HTMLInputElement).checked;
		relayStatus = 'Saving…';
		relayStatus = (await onrelaydefaultchange?.(accept)) ? 'Saved on the server' : 'Could not save; reopen Settings to see the current value';
	}

	function set<K extends keyof GlobalSettings>(key: K, value: GlobalSettings[K]) {
		onchange({ ...settings, [key]: value });
	}

	function setNumber(key: keyof typeof settingRanges, event: Event) {
		set(key, clampSetting(key, (event.currentTarget as HTMLInputElement).value));
	}
</script>

<div class="global-settings">
	<p class="intro">Saved in this browser and applied to every session straight away.</p>

	<section aria-labelledby="settings-appearance">
		<h3 id="settings-appearance">Appearance</h3>
		<label class="row">
			<span>Theme</span>
			<select value={theme} onchange={(e) => onthemechange((e.currentTarget as HTMLSelectElement).value as 'light' | 'dark')}>
				<option value="light">Light</option>
				<option value="dark">Dark</option>
			</select>
		</label>
	</section>

	<section aria-labelledby="settings-composer">
		<h3 id="settings-composer">Composer</h3>
		<label class="check"><input type="checkbox" checked={settings.enterToSend} onchange={(e) => set('enterToSend', e.currentTarget.checked)} /> Enter sends the message</label>
		<p class="description">Shift+Enter adds a new line. When off, Enter adds a new line and Ctrl/⌘+Enter sends. On phones, Enter always adds a new line.</p>
	</section>

	<section aria-labelledby="settings-transcript">
		<h3 id="settings-transcript">Transcript</h3>
		<label class="check"><input type="checkbox" checked={settings.showAllActivity} onchange={(e) => set('showAllActivity', e.currentTarget.checked)} /> Show all activity by default</label>
		<p class="description">Off keeps routine commands folded into “Background work” rows.</p>
		<label class="row">
			<span>Collapse command output longer than</span>
			<span class="number"><input type="number" min={settingRanges.collapseOutputLines.min} max={settingRanges.collapseOutputLines.max} value={settings.collapseOutputLines} onchange={(e) => setNumber('collapseOutputLines', e)} /> lines</span>
		</label>
	</section>

	<section aria-labelledby="settings-new-sessions">
		<h3 id="settings-new-sessions">Session rule defaults</h3>
		<p class="description note">For sessions without their own saved rules. Session details can still override them per session.</p>
		<label class="check"><input type="checkbox" checked={settings.defaultProgressReporting} onchange={(e) => set('defaultProgressReporting', e.currentTarget.checked)} /> Default: progress reporting</label>
		<label class="check"><input type="checkbox" checked={settings.defaultSharedCoordination} onchange={(e) => set('defaultSharedCoordination', e.currentTarget.checked)} /> Default: shared background coordination</label>
		<label class="check"><input type="checkbox" checked={relayDefault ?? true} disabled={relayDefault === null} onchange={changeRelayDefault} /> Default: accept direct messages from other sessions</label>
		<p class="description">Stored on the server for every browser and kept across restarts. Turning it off refuses new messages to sessions without their own choice and drops ones still queued for them.{#if relayStatus} <span role="status">{relayStatus}</span>{/if}</p>
	</section>

	<section aria-labelledby="settings-claude">
		<h3 id="settings-claude">Claude progress</h3>
		<label class="check"><input type="checkbox" checked={settings.claudeTimeCalibration} onchange={(e) => set('claudeTimeCalibration', e.currentTarget.checked)} /> Correct time-left estimates from elapsed progress</label>
		<p class="description">Scales Claude’s stated time left by how far it overshot on recent finished tasks in this browser (by 4× until three have finished), then replaces it when it is more than about twice off the pace of the work so far.</p>
		<label class="check"><input type="checkbox" checked={settings.claudeProgressReminders} onchange={(e) => set('claudeProgressReminders', e.currentTarget.checked)} /> Remind quiet turns to report progress</label>
		<label class="row" class:disabled={!settings.claudeProgressReminders}>
			<span>Remind after</span>
			<span class="number"><input type="number" disabled={!settings.claudeProgressReminders} min={settingRanges.claudeReminderMinutes.min} max={settingRanges.claudeReminderMinutes.max} value={settings.claudeReminderMinutes} onchange={(e) => setNumber('claudeReminderMinutes', e)} /> minutes without an update</span>
		</label>
		<p class="description note">Applies to prompts sent from now on.</p>
	</section>

	<section aria-labelledby="settings-allowance">
		<h3 id="settings-allowance">Claude allowance lockout</h3>
		<label class="row">
			<span>Stop and block Claude tasks at</span>
			<span class="number"><input type="number" aria-label="Lockout at % remaining" min={settingRanges.claudeAllowanceReserve.min} max={settingRanges.claudeAllowanceReserve.max} value={settings.claudeAllowanceReserve} onchange={(e) => setNumber('claudeAllowanceReserve', e)} /> % remaining</span>
		</label>
		<p class="description note">Applies to the 5-hour and 7-day allowance. Running tasks are interrupted and new ones refused once either has this much or less left. 0 turns the lockout off. Takes effect with the next prompt to each session.</p>
	</section>

	<section aria-labelledby="settings-monitoring">
		<h3 id="settings-monitoring">Monitoring</h3>
		<label class="check"><input type="checkbox" checked={settings.quietWorkerNotices} onchange={(e) => set('quietWorkerNotices', e.currentTarget.checked)} /> Notify when a worker has been quiet for a while</label>
		<label class="row">
			<span>Refresh task usage every</span>
			<span class="number"><input type="number" min={settingRanges.usageRefreshSeconds.min} max={settingRanges.usageRefreshSeconds.max} value={settings.usageRefreshSeconds} onchange={(e) => setNumber('usageRefreshSeconds', e)} /> seconds</span>
		</label>
	</section>

	<div class="actions">
		<button type="button" onclick={() => onchange({ ...defaultSettings })}>Reset to defaults</button>
	</div>
</div>

<style>
	.global-settings { display: grid; gap: .25rem; }
	.intro { margin: 0 0 .5rem; color: var(--color-muted); font-size: .8rem; }
	section { padding-block: .75rem; border-top: 1px solid var(--color-rule); }
	h3 { margin: 0 0 .5rem; font-size: .9rem; }
	.check { display: flex; align-items: center; gap: .5rem; font-size: .85rem; margin-top: .5rem; }
	.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; font-size: .85rem; margin-top: .5rem; }
	.row.disabled { color: var(--color-muted); }
	.number { display: inline-flex; align-items: center; gap: .4rem; }
	.description { margin: .25rem 0 .25rem 1.5rem; color: var(--color-muted); font-size: .8rem; line-height: 1.45; }
	.note { margin-left: 0; }
	input[type='number'] { width: 4.5rem; padding: .3rem .4rem; border: 1px solid var(--color-rule); border-radius: .4rem; background: var(--color-paper); color: var(--color-ink); font: inherit; }
	select { padding: .3rem .4rem; border: 1px solid var(--color-rule); border-radius: .4rem; background: var(--color-paper); color: var(--color-ink); font: inherit; }
	.actions { display: flex; justify-content: flex-end; padding-top: .75rem; border-top: 1px solid var(--color-rule); }
	button { color: var(--color-ink); background: var(--color-paper); border: 1px solid var(--color-rule); border-radius: .4rem; padding: .4rem .6rem; cursor: pointer; }
</style>

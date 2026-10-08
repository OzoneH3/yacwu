// Global settings: preferences that apply to every session in this browser.
// Stored once in localStorage; anything missing or invalid falls back to the
// default, so older browsers and partial values keep working.

export interface GlobalSettings {
	/** Desktop composer: Enter sends (Shift+Enter for a newline). Off: Ctrl/⌘+Enter sends. */
	enterToSend: boolean;
	/** Transcript starts with every activity row instead of the compact view. */
	showAllActivity: boolean;
	/** Command output longer than this many lines starts collapsed. */
	collapseOutputLines: number;
	/** Progress reporting for sessions without their own saved rules. */
	defaultProgressReporting: boolean;
	/** Shared coordination for sessions without their own saved rules. */
	defaultSharedCoordination: boolean;
	/** Replace Claude's stated time left when it contradicts its elapsed pace. */
	claudeTimeCalibration: boolean;
	/** Silently ask working Claude turns for a fresh progress estimate. */
	claudeProgressReminders: boolean;
	/** Minutes without a progress update before a reminder. */
	claudeReminderMinutes: number;
	/** Offer the "no activity for N minutes" notice for quiet workers. */
	quietWorkerNotices: boolean;
	/** Seconds between task usage refreshes while a session is open. */
	usageRefreshSeconds: number;
}

export const GLOBAL_SETTINGS_KEY = 'yacwu-settings';

export const defaultSettings: GlobalSettings = {
	enterToSend: true,
	showAllActivity: false,
	collapseOutputLines: 10,
	defaultProgressReporting: true,
	defaultSharedCoordination: true,
	claudeTimeCalibration: true,
	claudeProgressReminders: true,
	claudeReminderMinutes: 5,
	quietWorkerNotices: true,
	usageRefreshSeconds: 30
};

/** Allowed ranges for numeric settings. */
export const settingRanges = {
	collapseOutputLines: { min: 3, max: 200 },
	claudeReminderMinutes: { min: 1, max: 60 },
	usageRefreshSeconds: { min: 10, max: 600 }
} as const;

export function clampSetting(key: keyof typeof settingRanges, value: unknown): number {
	const { min, max } = settingRanges[key];
	const number = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(number)) return defaultSettings[key];
	return Math.min(max, Math.max(min, Math.round(number)));
}

export function readSettings(raw: string | null): GlobalSettings {
	let parsed: Record<string, unknown> = {};
	try {
		const value = JSON.parse(raw ?? '{}');
		if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value;
	} catch {
		/* Defaults. */
	}
	const flag = (key: keyof GlobalSettings) =>
		typeof parsed[key] === 'boolean' ? (parsed[key] as boolean) : (defaultSettings[key] as boolean);
	return {
		enterToSend: flag('enterToSend'),
		showAllActivity: flag('showAllActivity'),
		collapseOutputLines: key(parsed, 'collapseOutputLines'),
		defaultProgressReporting: flag('defaultProgressReporting'),
		defaultSharedCoordination: flag('defaultSharedCoordination'),
		claudeTimeCalibration: flag('claudeTimeCalibration'),
		claudeProgressReminders: flag('claudeProgressReminders'),
		claudeReminderMinutes: key(parsed, 'claudeReminderMinutes'),
		quietWorkerNotices: flag('quietWorkerNotices'),
		usageRefreshSeconds: key(parsed, 'usageRefreshSeconds')
	};
}

function key(parsed: Record<string, unknown>, name: keyof typeof settingRanges): number {
	return name in parsed ? clampSetting(name, parsed[name]) : defaultSettings[name];
}

/** Whether a composer keydown should send, per the Enter setting. */
export function sendsMessage(
	event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey'>,
	enterToSend: boolean
): boolean {
	if (event.key !== 'Enter' || event.shiftKey) return false;
	// Ctrl/⌘+Enter always sends; plain Enter sends only when enabled.
	return enterToSend || event.ctrlKey || event.metaKey;
}

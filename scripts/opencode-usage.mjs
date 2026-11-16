// OpenCode's "Go" allowance (rolling 5 hours, weekly 7 days, monthly) is served
// by the Go inference API, authenticated with the `opencode-go` API key that
// OpenCode stores in its own database. OpenCode's `GET /api/experimental/
// usage/limits` route only reports a Console *workspace* (integration
// `opencode`), so it answers `null` for a key-based Go login; read the gateway
// directly instead and map its meters to the app-server rate-limit windows the
// other backends report.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** URL of the Go allowance endpoint (the same origin the Go models use). */
export const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/** Where OpenCode keeps its database inside an XDG data home. */
export function openCodeDatabasePath(dataHome) {
	return join(dataHome, 'opencode', 'opencode.db');
}

/**
 * The active `opencode-go` API key from an OpenCode database, or null when no
 * Go credential is stored. Read-only: never rewrites the database.
 */
export function readGoKey(dbPath) {
	let db;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	} catch {
		return null;
	}
	try {
		const rows = db
			.prepare("select value from credential where integration_id = 'opencode-go' and active = 1")
			.all();
		for (const row of rows) {
			let value;
			try {
				value = JSON.parse(row.value);
			} catch {
				continue;
			}
			if (value?.type === 'key' && typeof value.key === 'string' && value.key) return value.key;
		}
		return null;
	} catch {
		return null;
	} finally {
		db.close();
	}
}

/** Parse an ISO reset time to epoch seconds, or null. */
function resetTime(value) {
	const at = typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(at) ? Math.floor(at / 1000) : null;
}

/**
 * Map the Go allowance (`{ rolling, weekly, monthly }`, each
 * `{ percent, status, resetsAt }`) to app-server rate-limit windows:
 * `rolling` is the 5-hour window, `weekly` the 7-day one. Percent → used
 * percent, ISO reset → epoch seconds, `rate-limited` status → reached.
 */
export function mapGoUsage(usage) {
	const meter = (value, minutes) => {
		if (!value || typeof value !== 'object') return null;
		const percent = value.percent;
		if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
		return { usedPercent: percent, windowDurationMins: minutes, resetsAt: resetTime(value.resetsAt) };
	};
	const rateLimited =
		usage?.rolling?.status === 'rate-limited' || usage?.weekly?.status === 'rate-limited';
	const rateLimits = {
		limitId: 'opencode',
		limitName: 'OpenCode',
		primary: meter(usage?.rolling, 300),
		secondary: meter(usage?.weekly, 10080),
		credits: null,
		planType: 'go',
		rateLimitReachedType: rateLimited ? 'primary' : null,
		readAt: null
	};
	return { rateLimits, rateLimitsByLimitId: { opencode: rateLimits } };
}

/** The Go allowance payload (`{ rolling, weekly, monthly }`), or null on failure. */
export async function fetchGoUsage(key, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
	if (!key) return null;
	let response;
	try {
		response = await fetchImpl(GO_USAGE_URL, {
			headers: { authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const body = await response.json().catch(() => null);
	return body?.usage ?? null;
}

/**
 * Rate limits for the managed OpenCode environment: read the Go key from its
 * database, fetch the allowance, and map it. Any failure yields empty windows
 * so the rest of the usage analysis is unaffected.
 */
export async function openCodeRateLimits(dataHome, options = {}) {
	const key = readGoKey(openCodeDatabasePath(dataHome));
	if (!key) return mapGoUsage(null);
	return mapGoUsage(await fetchGoUsage(key, options));
}

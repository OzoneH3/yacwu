// Optional, read-only GitHub CLI account usage. The internal endpoint can change;
// require explicit credit units and fail closed when authentication/schema differ.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/** @param {any} data */
export function normalizeCopilotAccount(data) {
 const q = data?.quota_snapshots?.premium_interactions;
 if (q?.token_based_billing !== true || typeof q.credits_used !== 'number' || !Number.isFinite(q.credits_used) || q.credits_used < 0) return null;
 return {
  login: typeof data.login === 'string' ? data.login : null,
  used: q.credits_used,
  max: q.unlimited === false && Number.isFinite(q.entitlement) && q.entitlement >= 0 ? q.entitlement : null,
  unlimited: q.unlimited === true,
  resetAt: typeof data.quota_reset_date === 'string' ? data.quota_reset_date : null
 };
}

/** The gh account may differ from Copilot CLI's; always show its login. */
export function createCopilotAccountReader({ fetch = async () => {
 const { stdout } = await exec('gh', ['api', '/copilot_internal/user'], { timeout: 5000, maxBuffer: 1024 * 1024 });
 return JSON.parse(stdout);
}, now = Date.now } = {}) {
 let at = -Infinity;
 /** @type {ReturnType<typeof normalizeCopilotAccount>} */ let cached = null;
 /** @type {Promise<ReturnType<typeof normalizeCopilotAccount>> | null} */ let pending = null;
 return () => {
  if (pending) return pending;
  if (now() - at < 300000) return Promise.resolve(cached);
  pending = Promise.resolve().then(fetch).then(normalizeCopilotAccount, () => null).then(value => {
   cached = value; at = now(); return value;
  }).finally(() => { pending = null; });
  return pending;
 };
}

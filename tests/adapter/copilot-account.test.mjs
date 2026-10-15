import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCopilotAccount, createCopilotAccountReader } from '../../scripts/copilot-account.mjs';
const quota = { token_based_billing: true, credits_used: 1913, entitlement: 0, unlimited: true };
const payload = q => ({ login: 'tester', quota_reset_date: '2026-11-01', quota_snapshots: { premium_interactions: q } });
test('normalizes explicit AI credit usage without interpreting legacy requests as credits', () => {
 assert.deepEqual(normalizeCopilotAccount(payload(quota)), { login: 'tester', used: 1913, max: null, unlimited: true, resetAt: '2026-11-01' });
 assert.equal(normalizeCopilotAccount(payload({ ...quota, token_based_billing: false })), null);
 assert.equal(normalizeCopilotAccount(payload({ ...quota, credits_used: undefined })), null);
 assert.equal(normalizeCopilotAccount(payload({ ...quota, credits_used: -1 })), null);
 assert.equal(normalizeCopilotAccount(payload({ ...quota, unlimited: false, entitlement: 10000 })).max, 10000);
 assert.equal(normalizeCopilotAccount(payload({ ...quota, unlimited: false, entitlement: 0 })).max, 0);
});
test('reader coalesces calls, caches failures and never returns stale account data after an auth failure', async () => {
 let now = 0, calls = 0, fail = false;
 const read = createCopilotAccountReader({ now: () => now, fetch: async () => { calls++; if (fail) throw new Error('not signed in'); return payload(quota); } });
 const values = await Promise.all([read(), read()]);
 assert.equal(values[0].used, 1913);
 assert.equal(calls, 1);
 await read(); assert.equal(calls, 1);
 now = 300001; fail = true;
 assert.equal(await read(), null);
 assert.equal(await read(), null);
 assert.equal(calls, 2);
});

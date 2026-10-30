/** User-supplied Oct 29 announcement: all Pro tiers and Business Premium doubled.
 * The post time is the assumed boundary; it is not an observed rollout time.
 * Keep raw journals unchanged. Other plans and separate dot limits are excluded.
 */
export const CODEX_ALLOWANCE_CHANGE_AT = Date.parse('2026-10-29T17:56:00+01:00');
const doubledPlans = new Set(['prolite', 'pro', 'promax', 'business_premium']);

export function hasDoubledAllowance(plan: string | null | undefined, limit: string | null | undefined): boolean {
 return limit === 'codex' && doubledPlans.has(plan ?? '');
}

/** Percentage-cost conversion to current capacity; null means a mixed interval. */
export function allowanceCostScale(start: number, end: number, plan: string | null | undefined, limit: string | null | undefined): number | null {
 if (!hasDoubledAllowance(plan, limit)) return 1;
 if (start >= CODEX_ALLOWANCE_CHANGE_AT) return 1;
 return end < CODEX_ALLOWANCE_CHANGE_AT ? 0.5 : null;
}

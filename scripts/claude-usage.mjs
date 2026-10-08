import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function readClaudeCredentials() {
  return JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json'), 'utf8')).claudeAiOauth;
}

/**
 * Claude counts cache reads separately; app-server input includes cache reads.
 * Preserve total consumption and normalize only the adapter's disjoint shape.
 * @param {{method?: string, params?: {tokenUsage?: {total?: Record<string, number>, last?: Record<string, number>}}}} message
 */
export function normalizeClaudeTokenUsage(message) {
  if (message.method !== 'thread/tokenUsage/updated' || !message.params?.tokenUsage) return message;
  /** @param {Record<string, number> | undefined} tokens */
  const normalize = (tokens) => {
    if (!tokens) return tokens;
    const { inputTokens, cachedInputTokens, outputTokens, totalTokens } = tokens;
    if (![inputTokens, cachedInputTokens, outputTokens, totalTokens].every((value) => Number.isFinite(value) && value >= 0)) return tokens;
    return cachedInputTokens > 0 && inputTokens + cachedInputTokens + outputTokens === totalTokens
      ? { ...tokens, inputTokens: inputTokens + cachedInputTokens } : tokens;
  };
  return { ...message, params: { ...message.params, tokenUsage: {
    ...message.params.tokenUsage,
    total: normalize(message.params.tokenUsage.total),
    last: normalize(message.params.tokenUsage.last)
  } } };
}

/**
 * Translate Claude subscription percentages and ISO reset times to app-server windows.
 * @param {{five_hour?: unknown, seven_day?: unknown} | null} usage
 * @param {string | null} planType
 */
export function claudeRateLimits(usage, planType = null) {
  /** @param {unknown} value @param {number} minutes */
  const window = (value, minutes) => {
    if (!value || typeof value !== 'object') return null;
    const data = /** @type {{resets_at?: unknown, utilization?: unknown}} */ (value);
    const resetsAt = typeof data.resets_at === 'string' ? Date.parse(data.resets_at) / 1000 : NaN;
    const usedPercent = data.utilization;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
    return { usedPercent, windowDurationMins: minutes, resetsAt: Number.isFinite(resetsAt) ? Math.floor(resetsAt) : null };
  };
  const rateLimits = {
    limitId: 'claude-code', limitName: 'Claude Code',
    primary: window(usage?.five_hour, 300),
    secondary: window(usage?.seven_day, 10_080),
    credits: null, planType, rateLimitReachedType: null
  };
  return { rateLimits, rateLimitsByLimitId: { 'claude-code': rateLimits } };
}

/**
 * Cache account reads across the browser and background usage collector.
 * @param {{credentials?: () => Promise<{accessToken?: string, subscriptionType?: string} | null>, fetchUsage?: (url: string, options: RequestInit) => Promise<Response>, now?: () => number}} options
 */
export function createClaudeUsageReader({
  credentials = readClaudeCredentials,
  fetchUsage = fetch,
  now = Date.now
} = {}) {
  let cached = claudeRateLimits(null);
  let nextRead = 0;
  let retryAt = 0;
  let lastSuccess = 0;
  let rateLimited = false;
  /** @type {Promise<ReturnType<typeof claudeRateLimits> & {usageError?: {code: string, retryAt: number} | null}> | undefined} */
  let pending;
  /** @type {string | undefined} */
  let accountToken;
  function currentReading() {
    const limits = cached.rateLimits;
    return [limits.primary, limits.secondary].every(window => window && (window.resetsAt === null || window.resetsAt * 1000 > now()))
      && lastSuccess > 0 && now() - lastSuccess < 120_000;
  }
  function unavailable() {
    return { ...claudeRateLimits(null), usageError: rateLimited ? { code: 'rate_limited', retryAt } : null };
  }
  return async ({ force = false } = {}) => {
    if (pending) {
      const reading = await pending;
      return force && !currentReading() ? unavailable() : reading;
    }
    // A page reload/start must not turn a fresh reading into another HTTP call.
    if (currentReading()) return cached;
    // Honor throttling even when callers need a fresh safety check.
    if (now() < retryAt) return force ? unavailable() : { ...cached, usageError: { code: 'rate_limited', retryAt } };
    if (!force && now() < nextRead) return cached;
    pending = (async () => {
      nextRead = now() + 120_000;
      try {
        const auth = await credentials().catch(() => null);
        const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || auth?.accessToken;
        if (token !== accountToken) {
          cached = claudeRateLimits(null);
          lastSuccess = 0;
          accountToken = token;
        }
        if (!token) return force ? claudeRateLimits(null) : cached;
        const response = await fetchUsage('https://api.anthropic.com/api/oauth/usage', {
          headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
          signal: AbortSignal.timeout(8_000)
        });
        if (response.status === 429) {
          const retry = Number(response.headers.get('retry-after'));
          retryAt = now() + Math.max(120_000, Number.isFinite(retry) ? retry * 1000 : 0);
          nextRead = retryAt;
          rateLimited = true;
        }
        if (!response.ok) return force ? unavailable() : { ...cached, usageError: rateLimited ? { code: 'rate_limited', retryAt } : null };
        cached = claudeRateLimits(await response.json(), auth?.subscriptionType ?? null);
        lastSuccess = now();
        retryAt = 0;
        rateLimited = false;
      } catch {
        // Keep display data on ordinary reads; safety checks require a current reading.
        if (force) return claudeRateLimits(null);
      }
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}

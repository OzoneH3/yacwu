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
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 || !Number.isFinite(resetsAt)) return null;
    return { usedPercent, windowDurationMins: minutes, resetsAt: Math.floor(resetsAt) };
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
  /** @type {Promise<ReturnType<typeof claudeRateLimits>> | undefined} */
  let pending;
  /** @type {string | undefined} */
  let accountToken;
  return async ({ force = false } = {}) => {
    if (pending) return pending;
    if (!force && now() < nextRead) return cached;
    pending = (async () => {
      nextRead = now() + 120_000;
      try {
        const auth = await credentials().catch(() => null);
        const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || auth?.accessToken;
        if (token !== accountToken) {
          cached = claudeRateLimits(null);
          accountToken = token;
        }
        if (!token) return force ? claudeRateLimits(null) : cached;
        const response = await fetchUsage('https://api.anthropic.com/api/oauth/usage', {
          headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
          signal: AbortSignal.timeout(8_000)
        });
        if (response.status === 429) {
          const retry = Number(response.headers.get('retry-after'));
          nextRead = now() + Math.max(120_000, Number.isFinite(retry) ? retry * 1000 : 0);
        }
        if (!response.ok) return force ? claudeRateLimits(null) : cached;
        cached = claudeRateLimits(await response.json(), auth?.subscriptionType ?? null);
      } catch {
        // Missing login or a temporary service failure must not block Claude turns.
        if (force) return claudeRateLimits(null);
      }
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}

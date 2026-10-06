import { learnTokenCosts, type CostEstimate, type UsageObservation } from './usage-fit';

/** Only usage metadata is stored: never prompts, answers or tool output. */
export interface UsageEvent {
	at: number;
	host: string;
	event: string;
	threadId?: string;
	turnId?: string;
	model?: string | null;
	effort?: string | null;
	parentThreadId?: string | null;
	status?: string;
	total?: Partial<TokenTotals>;
	usedPercent?: number;
	resetsAt?: number;
	limitId?: string | null;
	planType?: string | null;
	fingerprint?: string | null;
	accountKey?: string;
}

export interface TokenTotals {
	totalTokens: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
}

export interface UsageTask {
	host: string;
	threadId: string;
	turnId: string;
	model: string;
	effort: string;
	parentThreadId: string | null;
	startedAt: number;
	endedAt: number | null;
	status: string;
	tokens: TokenTotals;
	partialTokens: boolean;
	overlapping: boolean;
	weeklyLeftBefore: number | null;
	weeklyLeftAfter: number | null;
	sharedAllowanceDelta: number | null;
	estimatedWeeklyPercent: number | null;
	quotaScope: string | null;
	accountKey: string;
	estimate: CostEstimate | null;
	settling: boolean;
	benchmark: boolean;
}

export interface UsageRate {
	model: string;
	effort: string;
	samples: number;
	tokens: number;
	percentPer100kTokens: number | null;
	estimate: CostEstimate | null;
	weights: Record<'uncached' | 'cached' | 'output', number | null>;
}

const emptyTokens = (): TokenTotals => ({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
const groupKey = (model: string, effort: string) => JSON.stringify([model, effort]);

/** Keep legacy host-only history, and combine known matching accounts without guessing identity. */
function accountEvents(events: UsageEvent[], host: string) {
	const accounts = new Map<string, string>();
	const annotated = [...events].sort((a, b) => a.at - b.at).map((event) => {
		if (event.event === 'account') {
			if (event.fingerprint) accounts.set(event.host, event.fingerprint);
			else accounts.delete(event.host);
		}
		return { ...event, accountKey: accounts.get(event.host) ?? `unidentified:${event.host}` };
	});
	const selected = accounts.get(host) ?? `unidentified:${host}`;
	return annotated.filter((event) => event.accountKey === selected || event.accountKey === `unidentified:${host}`);
}

export function analyzeUsage(rawEvents: UsageEvent[], options: { host?: string; settleMs?: number } = {}) {
	const host = options.host ?? 'local';
	const settleMs = options.settleMs ?? 60_000;
	const events = accountEvents(rawEvents, host);
	const tasks: UsageTask[] = [];
	const tasksByTurn = new Map<string, UsageTask>();
	const active = new Map<string, UsageTask>();
	const settings = new Map<string, { model: string; effort: string; parent: string | null }>();
	const totals = new Map<string, TokenTotals>();
	const quotas: UsageEvent[] = [];
	const observations: UsageObservation[] = [];
	const benchmarks = new Set<string>();
	let calibrationScope: string | null = null;
	let baseline: UsageEvent | null = null;
	let intervalTokens: Record<string, TokenTotals> = {};
	let lastTokenAt = -Infinity;
	let quotaStableSince = 0;
	let previousQuotaUsed: number | null = null;
	let quotaPeak = 0;
	let intervalIncomplete = false;
	let excludedIntervals = 0;
	// Stored file order disambiguates notifications in the same millisecond.
	for (const event of events) {
		if (!Number.isFinite(event.at)) continue;
		const id = event.threadId ? `${event.host}:${event.threadId}` : undefined;
		if (event.event === 'benchmark' && id) benchmarks.add(id);
		if (event.event === 'collectorStarted' || event.event === 'connectionLost') {
			for (const [key, task] of active) if (task.host === event.host) { task.endedAt = event.at; task.status = 'tracking gap'; task.partialTokens = true; active.delete(key); }
			for (const key of totals.keys()) if (key.startsWith(`${event.host}:`)) totals.delete(key);
			baseline = null; intervalTokens = {}; intervalIncomplete = false;
		} else if ((event.event === 'settings' || event.event === 'metadata') && id) {
			const previous = settings.get(id);
			settings.set(id, { model: event.model || previous?.model || 'Unknown', effort: event.effort || previous?.effort || 'Unknown', parent: event.parentThreadId || previous?.parent || null });
			const task = active.get(id);
			if (task) {
				if (task.model === 'Unknown' && event.model) task.model = event.model;
				if (task.effort === 'Unknown' && event.effort) task.effort = event.effort;
				if (!task.parentThreadId && event.parentThreadId) task.parentThreadId = event.parentThreadId;
			}
		} else if (event.event === 'newThread' && id) {
			totals.set(id, emptyTokens());
		} else if (event.event === 'turn/started' && id && event.turnId) {
			if (active.get(id)?.turnId === event.turnId) continue;
			const previous = active.get(id);
			if (previous) { previous.endedAt = event.at; previous.status = 'interrupted'; previous.partialTokens = true; }
			const config = settings.get(id);
			const task: UsageTask = {
				host: event.host, threadId: event.threadId!, turnId: event.turnId, model: config?.model ?? 'Unknown', effort: config?.effort ?? 'Unknown', parentThreadId: config?.parent ?? null,
				startedAt: event.at, endedAt: null, status: 'running', tokens: emptyTokens(), partialTokens: !totals.has(id), overlapping: active.size > 0,
				weeklyLeftBefore: null, weeklyLeftAfter: null, sharedAllowanceDelta: null, estimatedWeeklyPercent: null, quotaScope: calibrationScope,
				accountKey: event.accountKey!, estimate: null, settling: false, benchmark: benchmarks.has(id)
			};
			for (const other of active.values()) other.overlapping = true;
			active.set(id, task); tasks.push(task);
			tasksByTurn.set(`${id}:${event.turnId}`, task);
		} else if (event.event === 'tokens' && id && event.total) {
			const next = emptyTokens();
			for (const field of Object.keys(next) as (keyof TokenTotals)[]) {
				const value = event.total[field];
				next[field] = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
			}
			const previous = totals.get(id);
			totals.set(id, next);
			const task = event.turnId ? tasksByTurn.get(`${id}:${event.turnId}`) : active.get(id);
			const validTurn = task && (!event.turnId || event.turnId === task.turnId);
			if (!previous || next.totalTokens < previous.totalTokens) {
				if (task) task.partialTokens = true;
				if (baseline && next.totalTokens > 0) intervalIncomplete = true;
				continue;
			}
			const delta = next.totalTokens - previous.totalTokens;
			const deltaTokens = emptyTokens();
			for (const field of Object.keys(next) as (keyof TokenTotals)[]) deltaTokens[field] = Math.max(0, next[field] - previous[field]);
			if (delta > 0) lastTokenAt = event.at;
			if (validTurn) for (const field of Object.keys(next) as (keyof TokenTotals)[]) task.tokens[field] += Math.max(0, next[field] - previous[field]);
			if (baseline && delta > 0) {
				if (!validTurn || task.model === 'Unknown' || task.effort === 'Unknown') intervalIncomplete = true;
				else {
					const key = groupKey(task.model, task.effort), bucket = intervalTokens[key] ??= emptyTokens();
					for (const field of Object.keys(bucket) as (keyof TokenTotals)[]) bucket[field] += deltaTokens[field];
				}
			}
		} else if (event.event === 'turn/completed' && id) {
			const task = active.get(id);
			if (task && (!event.turnId || task.turnId === event.turnId)) {
				task.endedAt = event.at; task.status = event.status ?? 'completed'; active.delete(id);
			}
		} else if (event.event === 'quota' && typeof event.usedPercent === 'number' && event.usedPercent >= 0 && event.usedPercent <= 100 && typeof event.resetsAt === 'number') {
			// One quota source per account; merging duplicate host readings would double-charge or introduce stale decreases.
			if (event.host !== host) continue;
			quotas.push(event);
			const scope = JSON.stringify([event.accountKey, event.limitId ?? 'codex', event.planType ?? null]);
			for (const task of active.values()) if (!task.quotaScope) task.quotaScope = scope;
			if (calibrationScope && scope !== calibrationScope) observations.length = 0;
			calibrationScope = scope;
			const sameWindow = baseline && baseline.accountKey === event.accountKey && baseline.resetsAt === event.resetsAt && baseline.limitId === event.limitId && baseline.planType === event.planType;
			if (!sameWindow) { quotaStableSince = event.at; quotaPeak = event.usedPercent; }
			else {
				if (previousQuotaUsed !== event.usedPercent) quotaStableSince = event.at;
				quotaPeak = Math.max(quotaPeak, event.usedPercent);
			}
			previousQuotaUsed = event.usedPercent;
			if (!sameWindow || event.usedPercent < (baseline?.usedPercent ?? 0)) {
				baseline = event; intervalTokens = {}; intervalIncomplete = false;
			} else if (baseline && event.usedPercent - (baseline.usedPercent ?? 0) >= 2 && event.at - lastTokenAt >= settleMs && event.at - quotaStableSince >= settleMs && event.usedPercent >= quotaPeak) {
				// Pool across whole-percent rounding steps; unchanged readings don't imply free work.
				if (!intervalIncomplete && Object.values(intervalTokens).some((tokens) => tokens.totalTokens > 0)) observations.push({ percent: event.usedPercent - (baseline.usedPercent ?? 0), tokens: intervalTokens });
				else excludedIntervals++;
				baseline = event; intervalTokens = {}; intervalIncomplete = false;
			}
		}
	}
	const learned = learnTokenCosts(observations);
	const groups = [...new Set(tasks.map((task) => groupKey(task.model, task.effort)))];
	const rates: UsageRate[] = groups.map((key) => {
		const [model, effort] = JSON.parse(key);
		const samples = observations.filter((sample) => (sample.tokens[key]?.totalTokens ?? 0) > 0);
		const total = emptyTokens();
		for (const sample of samples) for (const field of Object.keys(total) as (keyof TokenTotals)[]) total[field] += sample.tokens[key][field];
		const normalized = { ...total };
		for (const field of Object.keys(total) as (keyof TokenTotals)[]) normalized[field] = total.totalTokens ? total[field] / total.totalTokens * 100_000 : 0;
		const estimate = learned.estimate(key, normalized);
		return { model, effort, samples: samples.length, tokens: total.totalTokens, percentPer100kTokens: estimate?.value ?? null, estimate, weights: learned.weights(key) };
	});
	for (const task of tasks) {
		const accountQuotas = quotas.filter((quota) => quota.accountKey === task.accountKey);
		const before = accountQuotas.findLast((quota) => quota.at <= task.startedAt && task.startedAt - quota.at <= 90_000);
		const after = task.endedAt ? accountQuotas.findLast((quota) => quota.at >= task.endedAt! + settleMs && quota.at - task.endedAt! <= Math.max(180_000, settleMs)) : accountQuotas.findLast((quota) => quota.at >= task.startedAt);
		task.settling = task.endedAt !== null && !after && (accountQuotas.at(-1)?.at ?? 0) < task.endedAt + settleMs;
		task.weeklyLeftBefore = before ? 100 - before.usedPercent! : null;
		task.weeklyLeftAfter = after ? 100 - after.usedPercent! : null;
		if (before && after && before.resetsAt === after.resetsAt && before.limitId === after.limitId && before.planType === after.planType && after.usedPercent! >= before.usedPercent!) task.sharedAllowanceDelta = after.usedPercent! - before.usedPercent!;
		if (task.quotaScope === calibrationScope && !task.partialTokens && task.tokens.totalTokens > 0) {
			task.estimate = learned.estimate(groupKey(task.model, task.effort), task.tokens);
			task.estimatedWeeklyPercent = task.estimate?.value ?? null;
		}
	}
	return { tasks: tasks.reverse(), rates, observations: observations.length, excludedIntervals, calibrated: learned.calibrated, hosts: [...new Set(events.map((event) => event.host))] };
}

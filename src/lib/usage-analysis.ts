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
	last?: Partial<TokenTotals>;
	snapshotAt?: number;
	completedAt?: number;
	requestId?: number;
	counterSnapshot?: boolean;
	usedPercent?: number;
	windowDurationMins?: number;
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
	/** Legacy field names: values refer to the selected analysis window. */
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
	singleSettingSamples: number;
	tokens: number;
	percentPer100kTokens: number | null;
	estimate: CostEstimate | null;
	weights: Record<'uncached' | 'cached' | 'output', number | null>;
}

export interface UsagePoolContributor {
	task: UsageTask;
	tokens: TokenTotals;
}

/** One account observation; its quota change must only be counted once. */
export interface UsagePool {
	startedAt: number;
	endedAt: number;
	weeklyLeftBefore: number;
	weeklyLeftAfter: number;
	status: 'settled' | 'accumulating' | 'excluded';
	benchmark: boolean;
	groups: Array<{
		model: string;
		effort: string;
		tokens: TokenTotals;
		contributors: UsagePoolContributor[];
		peakWorkers: number;
		workerMs: number;
	}>;
}

function poolConcurrency(contributors: UsagePoolContributor[], start: number, end: number) {
	const boundaries: Array<[number, number]> = [];
	let workerMs = 0;
	for (const { task } of contributors) {
		const a = Math.max(start, task.startedAt), b = Math.min(end, task.endedAt ?? end);
		if (b <= a) continue;
		workerMs += b - a;
		boundaries.push([a, 1], [b, -1]);
	}
	boundaries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let current = 0, peakWorkers = 0;
	for (const [, delta] of boundaries) { current += delta; peakWorkers = Math.max(peakWorkers, current); }
	return { peakWorkers, workerMs };
}

const emptyTokens = (): TokenTotals => ({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
const groupKey = (model: string, effort: string) => JSON.stringify([model, effort]);
const sameResetWindow = (a: number | undefined, b: number | undefined) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 60;

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

/** Confirm snapshots only inside a successful idle read/resume, with no turn
 * lifecycle or connection gap during that request. Do not infer from silence. */
function idleReadSnapshots(events: UsageEvent[]): Set<UsageEvent> {
	const confirmed = new Set<UsageEvent>();
	const idleReplies = new Map<string, { host: string; at: number }>();
	const reads = new Map<string, { host: string; threadId: string; dirty: boolean; packets: UsageEvent[] }>();
	const byThread = new Map<string, Set<string>>();
	const threadKey = (event: UsageEvent) => JSON.stringify([event.host, event.threadId]);
	const remove = (key: string) => {
		const read = reads.get(key);
		if (read) {
			const group = JSON.stringify([read.host, read.threadId]);
			byThread.get(group)?.delete(key);
			if (!byThread.get(group)?.size) byThread.delete(group);
		}
		reads.delete(key);
	};
	for (const event of events) {
		if (event.event === 'collectorStarted' || event.event === 'connectionLost') {
			for (const [key, read] of reads) if (read.host === event.host) remove(key);
			for (const [key, reply] of idleReplies) if (reply.host === event.host) idleReplies.delete(key);
			continue;
		}
		const key = JSON.stringify([event.host, event.requestId]);
		if (event.event === 'snapshotReadStarted' && event.threadId && Number.isFinite(event.requestId)) {
			idleReplies.delete(threadKey(event));
			remove(key);
			reads.set(key, { host: event.host, threadId: event.threadId, dirty: false, packets: [] });
			const group = byThread.get(threadKey(event)) ?? new Set<string>();
			group.add(key); byThread.set(threadKey(event), group);
		} else if (event.event === 'snapshotReadCompleted') {
			const read = reads.get(key);
			if (read && !read.dirty && event.threadId === read.threadId && (event.status === 'idle' || event.status === 'notLoaded')) {
				for (const packet of read.packets) confirmed.add(packet);
				idleReplies.set(threadKey(event), { host: event.host, at: event.at });
			}
			remove(key);
		} else if (event.threadId) {
			if (event.event === 'turn/started' || event.event === 'turn/completed') idleReplies.delete(threadKey(event));
			// Codex may deliver the stored notification just after the RPC
			// reply. Keep this explicit idle evidence briefly, never across
			// another read, generation, or connection gap.
			const idle = idleReplies.get(threadKey(event));
			if (event.event === 'tokens' && idle && event.at - idle.at <= 5_000 && !byThread.has(threadKey(event))) confirmed.add(event);
			for (const key of byThread.get(threadKey(event)) ?? []) {
				const read = reads.get(key)!;
				if (event.event === 'tokens') read.packets.push(event);
				else if (event.event === 'turn/started' || event.event === 'turn/completed') read.dirty = true;
			}
		}
	}
	return confirmed;
}

/** Spawn receipts can arrive after the first child turn. Replay proven birth
 * and its settings before that turn, without zeroing a resumed/forked thread. */
function resolveSpawnEvidence(events: UsageEvent[]): UsageEvent[] {
	const idleSnapshots = idleReadSnapshots(events);
	const firstTurns = new Map<string, UsageEvent>();
	const firstTokens = new Map<string, UsageEvent>();
	const births = new Map<string, UsageEvent>();
	const seenThreads = new Set<string>();
	const recovered: UsageEvent[] = [];
	const snapshots = new Map<string, UsageEvent>();
	const snapshotKey = (event: UsageEvent, at: number) => JSON.stringify([event.host, event.threadId, event.turnId, at]);
	const gaps = events.filter((event) => event.event === 'collectorStarted' || event.event === 'connectionLost');
	const crossesGap = (host: string, start: number, end: number) => gaps.some((event) => event.host === host
		&& event.at >= Math.min(start, end) && event.at <= Math.max(start, end));
	for (const event of events) {
		if (!event.threadId) continue;
		const key = `${event.host}:${event.threadId}`;
		if (event.event === 'tokens' && !firstTokens.has(key)) firstTokens.set(key, event);
		if (event.event === 'historicalSnapshot' && Number.isFinite(event.snapshotAt) && Number.isFinite(event.completedAt)) {
			snapshots.set(snapshotKey(event, event.snapshotAt!), event);
		}
		if (event.event === 'spawnedThread') {
			const previous = births.get(key);
			births.set(key, previous ? { ...previous, model: previous.model || event.model, effort: previous.effort || event.effort } : event);
		}
		if (!seenThreads.has(key) && event.event === 'turn/started') firstTurns.set(key, event);
		// Metadata does not prove prior usage; a prior token counter does.
		if (event.event === 'tokens' || event.event === 'newThread' || event.event === 'turn/started') seenThreads.add(key);
	}
	for (const [key, birth] of births) {
		const turn = firstTurns.get(key);
		if (!turn) continue;
		// Never bridge a connection/collector gap while inferring creation.
		if (crossesGap(birth.host, turn.at, birth.at)) continue;
		recovered.push({ ...birth, at: turn.at, event: 'newThread' }, { ...birth, at: turn.at, event: 'metadata' });
	}
	for (const [key, packet] of firstTokens) {
		const turn = firstTurns.get(key);
		if (!turn || births.has(key) || packet.turnId !== turn.turnId || !packet.total?.totalTokens
			|| packet.total.totalTokens !== packet.last?.totalTokens) continue;
		if (!crossesGap(packet.host, turn.at, packet.at)) recovered.push({ ...packet, at: turn.at, event: 'newThread' });
	}
	// Synthetic birth events precede the real turn when timestamps tie.
	return [...recovered, ...events.map((event) => {
		if (event.event !== 'tokens') return event;
		const proof = snapshots.get(snapshotKey(event, event.at));
		const historical = proof && proof.total?.totalTokens === event.total?.totalTokens;
		return historical || idleSnapshots.has(event)
			? { ...event, ...(historical ? { completedAt: proof.completedAt } : {}), counterSnapshot: idleSnapshots.has(event) } : event;
	})].sort((a, b) => a.at - b.at);
}

export function analyzeUsage(rawEvents: UsageEvent[], options: { host?: string; settleMs?: number; windowDurationMins?: 300 | 10080 } = {}) {
	const host = options.host ?? 'local';
	const settleMs = options.settleMs ?? 60_000;
	const windowDurationMins = options.windowDurationMins ?? 10080;
	// Legacy quotas and benchmark boundaries describe the weekly allowance.
	// Analyze each window independently; never mix their percentages or resets.
	const windowEvents = rawEvents.filter((event) => !['quota', 'benchmarkBoundary', 'benchmarkBoundaryEnd'].includes(event.event)
		|| (event.windowDurationMins ?? 10080) === windowDurationMins);
	const events = resolveSpawnEvidence(accountEvents(windowEvents, host));
	const tasks: UsageTask[] = [];
	const tasksByTurn = new Map<string, UsageTask>();
	const active = new Map<string, UsageTask>();
	const settings = new Map<string, { model: string; effort: string; parent: string | null }>();
	const totals = new Map<string, TokenTotals>();
	const quotas: UsageEvent[] = [];
	const observations: UsageObservation[] = [];
	const pools: UsagePool[] = [];
	const benchmarks = new Set<string>();
	let calibrationScope: string | null = null;
	let baseline: UsageEvent | null = null;
	let intervalTokens: Record<string, TokenTotals> = {};
	let intervalTasks = new Map<string, UsagePoolContributor>();
	let lastTokenAt = -Infinity;
	let quotaStableSince = 0;
	let previousQuotaUsed: number | null = null;
	let quotaPeak = 0;
	let intervalIncomplete = false;
	let excludedIntervals = 0;
	let benchmarkInterval: string | null = null;
	function recordPool(end: UsageEvent, status: UsagePool['status']) {
		if (!baseline || !intervalTasks.size || !Number.isFinite(end.usedPercent)) return;
		const groups = Object.entries(intervalTokens).map(([key, tokens]) => {
			const [model, effort] = JSON.parse(key);
			const contributors = [...intervalTasks.values()].filter(({ task }) => groupKey(task.model, task.effort) === key);
			return { model, effort, tokens: { ...tokens }, contributors, ...poolConcurrency(contributors, baseline!.at, end.at) };
		});
		pools.push({ startedAt: baseline.at, endedAt: end.at, weeklyLeftBefore: 100 - baseline.usedPercent!,
			weeklyLeftAfter: 100 - end.usedPercent!, status, benchmark: benchmarkInterval !== null, groups });
	}
	// Stored file order disambiguates notifications in the same millisecond.
	for (const event of events) {
		if (!Number.isFinite(event.at)) continue;
		const id = event.threadId ? `${event.host}:${event.threadId}` : undefined;
		if (event.event === 'benchmark' && id) benchmarks.add(id);
		if (event.host === host && event.event === 'benchmarkBoundary' && id) {
			const prior = quotas.at(-1);
			if (prior && prior.accountKey === event.accountKey && sameResetWindow(prior.resetsAt, event.resetsAt) && typeof event.usedPercent === 'number') {
				baseline = { ...prior, at: event.at, usedPercent: event.usedPercent };
				benchmarkInterval = id; intervalTokens = {}; intervalTasks = new Map(); intervalIncomplete = active.size > 0;
			}
			continue;
		}
		if (event.host === host && event.event === 'benchmarkBoundaryEnd' && benchmarkInterval === id && baseline) {
			const delta = (event.usedPercent ?? 0) - (baseline.usedPercent ?? 0);
			if (!intervalIncomplete && event.accountKey === baseline.accountKey && sameResetWindow(event.resetsAt, baseline.resetsAt) && delta >= 1 && Object.values(intervalTokens).some((tokens) => tokens.totalTokens > 0)) {
				observations.push({ percent: delta, tokens: intervalTokens });
				recordPool(event, 'settled');
			} else { excludedIntervals++; recordPool(event, 'excluded'); }
			baseline = { ...baseline, at: event.at, usedPercent: event.usedPercent };
			intervalTokens = {}; intervalTasks = new Map(); intervalIncomplete = false; benchmarkInterval = null;
			quotaStableSince = event.at; quotaPeak = event.usedPercent ?? 0; previousQuotaUsed = event.usedPercent ?? null;
			continue;
		}
		if (event.host === host && event.event === 'benchmarkFinished' && benchmarkInterval) {
			benchmarkInterval = null; baseline = null; intervalTokens = {}; intervalTasks = new Map(); intervalIncomplete = false;
		}
		if (event.event === 'collectorStarted' || event.event === 'connectionLost') {
			for (const [key, task] of active) if (task.host === event.host) { task.endedAt = event.at; task.status = 'tracking gap'; task.partialTokens = true; active.delete(key); }
			for (const key of totals.keys()) if (key.startsWith(`${event.host}:`)) totals.delete(key);
			baseline = null; intervalTokens = {}; intervalTasks = new Map(); intervalIncomplete = false; benchmarkInterval = null;
		} else if ((event.event === 'settings' || event.event === 'metadata' || event.event === 'spawnedThread') && id) {
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
			// Older Claude recordings count cache reads separately from input.
			// Normalize stored snapshots too, so old and new cumulative counters
			// share one convention and their deltas remain consistent.
			if (next.cachedInputTokens > 0 && next.inputTokens + next.cachedInputTokens + next.outputTokens === next.totalTokens) {
				next.inputTokens += next.cachedInputTokens;
			}
			const previous = totals.get(id);
			const task = event.turnId ? tasksByTurn.get(`${id}:${event.turnId}`) : active.get(id);
			const validTurn = task && (!event.turnId || event.turnId === task.turnId);
			const completedAt = event.completedAt ?? (task?.status === 'completed' ? task.endedAt : null);
			const storedSnapshot = !active.has(id) && (event.counterSnapshot
				|| (completedAt !== null && completedAt !== undefined && baseline && completedAt < baseline.at));
			// A stale stored counter cannot rewind a newer known baseline.
			if (storedSnapshot && previous && next.totalTokens <= previous.totalTokens) continue;
			totals.set(id, next);
			if (!previous || next.totalTokens < previous.totalTokens) {
				// A completed turn predating this window can emit its stored
				// cumulative count when read/resumed. It establishes a baseline,
				// not untracked work in the current window.
				if (!previous && storedSnapshot) continue;
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
				if (benchmarkInterval && id !== benchmarkInterval) intervalIncomplete = true;
				if (!validTurn || task.model === 'Unknown' || task.effort === 'Unknown') intervalIncomplete = true;
				else {
					const key = groupKey(task.model, task.effort), bucket = intervalTokens[key] ??= emptyTokens();
					for (const field of Object.keys(bucket) as (keyof TokenTotals)[]) bucket[field] += deltaTokens[field];
					const taskKey = `${id}:${task.turnId}`;
					const contributor = intervalTasks.get(taskKey) ?? { task, tokens: emptyTokens() };
					for (const field of Object.keys(contributor.tokens) as (keyof TokenTotals)[]) contributor.tokens[field] += deltaTokens[field];
					intervalTasks.set(taskKey, contributor);
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
			const sameWindow = baseline && baseline.accountKey === event.accountKey && sameResetWindow(baseline.resetsAt, event.resetsAt) && baseline.limitId === event.limitId && baseline.planType === event.planType;
			// Explicit benchmark boundaries keep short stages separate and prevent double-counting
			// the same token deltas through ordinary pooled quota observations.
			if (benchmarkInterval) {
				if (!sameWindow || event.usedPercent < (baseline?.usedPercent ?? 0)) intervalIncomplete = true;
				continue;
			}
			if (!sameWindow) { quotaStableSince = event.at; quotaPeak = event.usedPercent; }
			else {
				if (previousQuotaUsed !== event.usedPercent) quotaStableSince = event.at;
				quotaPeak = Math.max(quotaPeak, event.usedPercent);
			}
			previousQuotaUsed = event.usedPercent;
			if (!sameWindow || event.usedPercent < (baseline?.usedPercent ?? 0)) {
				baseline = event; intervalTokens = {}; intervalTasks = new Map(); intervalIncomplete = false;
			} else if (baseline && event.usedPercent - (baseline.usedPercent ?? 0) >= 2 && event.at - lastTokenAt >= settleMs && event.at - quotaStableSince >= settleMs && event.usedPercent >= quotaPeak) {
				// Pool across whole-percent rounding steps; unchanged readings don't imply free work.
				if (!intervalIncomplete && Object.values(intervalTokens).some((tokens) => tokens.totalTokens > 0)) {
					observations.push({ percent: event.usedPercent - (baseline.usedPercent ?? 0), tokens: intervalTokens });
					recordPool(event, 'settled');
				} else { excludedIntervals++; recordPool(event, 'excluded'); }
				baseline = event; intervalTokens = {}; intervalTasks = new Map(); intervalIncomplete = false;
			}
		}
	}
	const latestQuota = quotas.at(-1);
	if (baseline && latestQuota && latestQuota.at >= baseline.at && latestQuota.accountKey === baseline.accountKey && sameResetWindow(latestQuota.resetsAt, baseline.resetsAt)) {
		recordPool({ ...latestQuota, at: Math.max(latestQuota.at, lastTokenAt) }, intervalIncomplete ? 'excluded' : 'accumulating');
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
		return { model, effort, samples: samples.length,
			singleSettingSamples: samples.filter((sample) => Object.values(sample.tokens).filter((tokens) => tokens.totalTokens > 0).length === 1).length,
			tokens: total.totalTokens, percentPer100kTokens: estimate?.value ?? null, estimate, weights: learned.weights(key) };
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
	return { windowDurationMins, tasks: tasks.reverse(), pools: pools.reverse(), rates, observations: observations.length, excludedIntervals, calibrated: learned.calibrated, hosts: [...new Set(events.map((event) => event.host))] };
}

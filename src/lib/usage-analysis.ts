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
}

export interface TokenTotals {
	totalTokens: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
}

export interface UsageTask {
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
}

interface Observation { percent: number; tokens: Record<string, number> }
export interface UsageRate {
	model: string;
	effort: string;
	samples: number;
	tokens: number;
	percentPer100kTokens: number | null;
}

const emptyTokens = (): TokenTotals => ({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
const groupKey = (model: string, effort: string) => JSON.stringify([model, effort]);

/** Require independent evidence; a single mixture cannot identify each model's cost. */
function fullRank(matrix: number[][], columns: number): boolean {
	const a = matrix.map((row) => [...row]);
	let rank = 0;
	for (let column = 0; column < columns; column++) {
		let pivot = rank;
		for (let row = rank; row < a.length; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot]?.[column] ?? 0)) pivot = row;
		if (!a[pivot] || Math.abs(a[pivot][column]) < 1e-6) continue;
		[a[rank], a[pivot]] = [a[pivot], a[rank]];
		const scale = a[rank][column];
		for (let c = column; c < columns; c++) a[rank][c] /= scale;
		for (let row = rank + 1; row < a.length; row++) {
			const factor = a[row][column];
			for (let c = column; c < columns; c++) a[row][c] -= factor * a[rank][c];
		}
		rank++;
	}
	return rank === columns;
}

/** Empirical nonnegative costs, fitted jointly when models run concurrently. */
function fitRates(observations: Observation[], keys: string[]): Map<string, number> {
	if (!keys.length || observations.length < Math.max(3, keys.length + 1)) return new Map();
	if (keys.some((key) => observations.filter((sample) => (sample.tokens[key] ?? 0) > 0).length < 3)) return new Map();
	const x = observations.map((sample) => keys.map((key) => (sample.tokens[key] ?? 0) / 100_000));
	if (!fullRank(x, keys.length)) return new Map();
	const beta = keys.map(() => 0);
	const prediction = observations.map(() => 0);
	for (let iteration = 0; iteration < 500; iteration++) {
		let change = 0;
		for (let column = 0; column < keys.length; column++) {
			let numerator = 0, denominator = 1e-8;
			for (let row = 0; row < x.length; row++) {
				const feature = x[row][column];
				numerator += feature * (observations[row].percent - prediction[row] + feature * beta[column]);
				denominator += feature * feature;
			}
			const next = Math.max(0, numerator / denominator);
			const delta = next - beta[column];
			for (let row = 0; row < x.length; row++) prediction[row] += x[row][column] * delta;
			beta[column] = next;
			change = Math.max(change, Math.abs(delta));
		}
		if (change < 1e-8) break;
	}
	return new Map(keys.map((key, index) => [key, beta[index]]));
}

export function analyzeUsage(events: UsageEvent[]) {
	const tasks: UsageTask[] = [];
	const tasksByTurn = new Map<string, UsageTask>();
	const active = new Map<string, UsageTask>();
	const settings = new Map<string, { model: string; effort: string; parent: string | null }>();
	const totals = new Map<string, TokenTotals>();
	const quotas: UsageEvent[] = [];
	const observations: Observation[] = [];
	let calibrationScope: string | null = null;
	let baseline: UsageEvent | null = null;
	let intervalTokens: Record<string, number> = {};
	let intervalIncomplete = false;
	let excludedIntervals = 0;
	// Stored file order disambiguates notifications in the same millisecond.
	for (const event of events) {
		if (!Number.isFinite(event.at)) continue;
		const id = event.threadId;
		if (event.event === 'collectorStarted' || event.event === 'connectionLost') {
			for (const task of active.values()) { task.endedAt = event.at; task.status = 'tracking gap'; task.partialTokens = true; }
			active.clear(); totals.clear(); baseline = null; intervalTokens = {}; intervalIncomplete = false;
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
				threadId: id, turnId: event.turnId, model: config?.model ?? 'Unknown', effort: config?.effort ?? 'Unknown', parentThreadId: config?.parent ?? null,
				startedAt: event.at, endedAt: null, status: 'running', tokens: emptyTokens(), partialTokens: !totals.has(id), overlapping: active.size > 0,
				weeklyLeftBefore: null, weeklyLeftAfter: null, sharedAllowanceDelta: null, estimatedWeeklyPercent: null, quotaScope: calibrationScope
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
			if (validTurn) for (const field of Object.keys(next) as (keyof TokenTotals)[]) task.tokens[field] += Math.max(0, next[field] - previous[field]);
			if (baseline && delta > 0) {
				if (!validTurn || task.model === 'Unknown' || task.effort === 'Unknown') intervalIncomplete = true;
				else { const key = groupKey(task.model, task.effort); intervalTokens[key] = (intervalTokens[key] ?? 0) + delta; }
			}
		} else if (event.event === 'turn/completed' && id) {
			const task = active.get(id);
			if (task && (!event.turnId || task.turnId === event.turnId)) {
				task.endedAt = event.at; task.status = event.status ?? 'completed'; active.delete(id);
			}
		} else if (event.event === 'quota' && typeof event.usedPercent === 'number' && event.usedPercent >= 0 && event.usedPercent <= 100 && typeof event.resetsAt === 'number') {
			quotas.push(event);
			const scope = JSON.stringify([event.limitId ?? 'codex', event.planType ?? null]);
			for (const task of active.values()) if (!task.quotaScope) task.quotaScope = scope;
			if (calibrationScope && scope !== calibrationScope) observations.length = 0;
			calibrationScope = scope;
			const sameWindow = baseline && baseline.resetsAt === event.resetsAt && baseline.limitId === event.limitId && baseline.planType === event.planType;
			if (!sameWindow || event.usedPercent < (baseline?.usedPercent ?? 0)) {
				baseline = event; intervalTokens = {}; intervalIncomplete = false;
			} else if (baseline && event.usedPercent - (baseline.usedPercent ?? 0) >= 2) {
				// Pool across whole-percent rounding steps; unchanged readings don't imply free work.
				if (!intervalIncomplete && Object.values(intervalTokens).some((tokens) => tokens > 0)) observations.push({ percent: event.usedPercent - (baseline.usedPercent ?? 0), tokens: intervalTokens });
				else excludedIntervals++;
				baseline = event; intervalTokens = {}; intervalIncomplete = false;
			}
		}
	}
	const keys = [...new Set(observations.flatMap((sample) => Object.keys(sample.tokens)))];
	const learned = fitRates(observations, keys);
	const groups = [...new Set(tasks.map((task) => groupKey(task.model, task.effort)))];
	const rates: UsageRate[] = groups.map((key) => {
		const [model, effort] = JSON.parse(key);
		const samples = observations.filter((sample) => (sample.tokens[key] ?? 0) > 0);
		return { model, effort, samples: samples.length, tokens: samples.reduce((total, sample) => total + (sample.tokens[key] ?? 0), 0), percentPer100kTokens: learned.get(key) ?? null };
	});
	for (const task of tasks) {
		const before = quotas.findLast((quota) => quota.at <= task.startedAt && task.startedAt - quota.at <= 90_000);
		const after = task.endedAt ? quotas.find((quota) => quota.at >= task.endedAt! && quota.at - task.endedAt! <= 90_000) : quotas.findLast((quota) => quota.at >= task.startedAt);
		task.weeklyLeftBefore = before ? 100 - before.usedPercent! : null;
		task.weeklyLeftAfter = after ? 100 - after.usedPercent! : null;
		if (before && after && before.resetsAt === after.resetsAt && before.limitId === after.limitId && before.planType === after.planType && after.usedPercent! >= before.usedPercent!) task.sharedAllowanceDelta = after.usedPercent! - before.usedPercent!;
		const rate = learned.get(groupKey(task.model, task.effort));
		if (rate !== undefined && task.quotaScope === calibrationScope && !task.partialTokens && task.tokens.totalTokens > 0) task.estimatedWeeklyPercent = rate * task.tokens.totalTokens / 100_000;
	}
	return { tasks: tasks.reverse(), rates, observations: observations.length, excludedIntervals, calibrated: learned.size > 0 };
}

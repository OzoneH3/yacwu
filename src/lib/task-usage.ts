import type { UsageTask } from './usage-analysis';
import type { TaskProgressEstimate } from './task-progress';

export interface TaskUsageSummary {
	fiveHour?: TaskUsageSummary;
	tokens: number;
	partial: boolean;
	percent: number | null;
	low: number | null;
	high: number | null;
	knownPercent: number | null;
	unestimatedTurns: number;
	agentTurns: number;
	runningAgents: boolean;
	startedAt: number;
	provisional: boolean;
}

/** Attach the independently calibrated 5-hour estimate without adding it to weekly usage. */
export function summarizeTaskAllowances(tasks: UsageTask[], task: UsageTask, fiveHourTasks: UsageTask[]): TaskUsageSummary {
	const summary = summarizeTaskUsage(tasks, task);
	const fiveHourTask = fiveHourTasks.find((other) => other.host === task.host && other.threadId === task.threadId && other.turnId === task.turnId);
	if (fiveHourTask) summary.fiveHour = summarizeTaskUsage(fiveHourTasks, fiveHourTask);
	return summary;
}

/** Charge only descendant turns begun under this prompt, never another session. */
export function summarizeTaskUsage(tasks: UsageTask[], task: UsageTask): TaskUsageSummary {
	const parents = new Map(tasks.filter((other) => other.host === task.host && other.parentThreadId)
		.map((other) => [other.threadId, other.parentThreadId!]));
	const isDescendant = (id: string) => {
		const seen = new Set<string>();
		while (parents.has(id) && !seen.has(id)) {
			seen.add(id); id = parents.get(id)!;
			if (id === task.threadId) return true;
		}
		return false;
	};
	const included = tasks.filter((other) => other === task || (other.host === task.host
		&& other.startedAt >= task.startedAt && other.startedAt < (task.endedAt ?? Infinity)
		&& isDescendant(other.threadId)));
	const partial = included.some((other) => other.partialTokens);
	const estimated = !partial && included.every((other) => other.estimate !== null || other.tokens.totalTokens === 0)
		&& included.some((other) => other.estimate !== null);
	const known = included.filter((other) => !other.partialTokens && other.estimate !== null);
	return {
		tokens: included.reduce((sum, other) => sum + other.tokens.totalTokens, 0), partial,
		percent: estimated ? included.reduce((sum, other) => sum + (other.estimate?.value ?? 0), 0) : null,
		low: estimated ? included.reduce((sum, other) => sum + (other.estimate?.low ?? 0), 0) : null,
		high: estimated ? included.reduce((sum, other) => sum + (other.estimate?.high ?? 0), 0) : null,
		knownPercent: known.length ? known.reduce((sum, other) => sum + other.estimate!.value, 0) : null,
		unestimatedTurns: included.filter((other) => other.partialTokens || (other.tokens.totalTokens > 0 && other.estimate === null)).length,
		agentTurns: included.length - 1,
		runningAgents: included.some((other) => other !== task && other.endedAt === null),
		startedAt: task.startedAt,
		provisional: included.some((other) => other.estimate?.provisional)
	};
}

export function projectTaskUsage(summary: TaskUsageSummary | null, progress: TaskProgressEstimate | null, now: number) {
	if (!summary || summary.percent === null || summary.percent <= 0 || !progress) return null;
	let multiplier: number;
	let basis: 'progress' | 'time';
	if (progress.percent >= 5 && progress.percent < 100) {
		multiplier = 100 / progress.percent; basis = 'progress';
	} else if (progress.percent >= 100) {
		multiplier = 1; basis = 'progress';
	} else {
		const elapsed = now - summary.startedAt;
		if (elapsed < 30_000 || progress.remainingMinutes === null || progress.remainingMinutes <= 0) return null;
		multiplier = (elapsed + progress.remainingMinutes * 60_000) / elapsed; basis = 'time';
	}
	return { total: summary.percent * multiplier, remaining: summary.percent * (multiplier - 1), basis };
}

export function formatAllowancePercent(value: number | null): string {
	return value === null ? 'Learning…' : `~${value.toFixed(value > 0 && value < 0.01 ? 3 : 2)}%`;
}

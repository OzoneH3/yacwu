/** Recover usage metadata from exact local rollout evidence. Dry-run by default. */
import { appendFileSync, existsSync, readdirSync, readFileSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { analyzeUsage, type UsageEvent } from '../src/lib/usage-analysis';

const argument = (name: string, fallback: string) => {
	const index = process.argv.indexOf(name);
	return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
};
const usageDir = argument('--usage-dir', process.env.YACWU_USAGE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'yacwu/usage'));
const codexDir = argument('--codex-home', process.env.CODEX_HOME ?? join(homedir(), '.codex'));
const since = Date.parse(argument('--since', new Date(Date.now() - 86_400_000).toISOString()));
if (!Number.isFinite(since)) throw new Error('Invalid --since date');
const files = readdirSync(usageDir).filter((name) => /^usage-\d+\.jsonl(?:\.1)?$/.test(name));
const events: UsageEvent[] = files.flatMap((name) => readFileSync(join(usageDir, name), 'utf8').split('\n').flatMap((line) => {
	try { return [JSON.parse(line)]; } catch { return []; }
})).filter((event) => event.host === 'local').sort((a, b) => a.at - b.at);
const tasks = analyzeUsage(events).tasks;
const candidates = new Set(tasks.filter((task) => task.startedAt >= since && (task.partialTokens || task.model === 'Unknown' || task.effort === 'Unknown')).map((task) => task.threadId));
const missing = new Map<string, UsageEvent[]>();
const counters = new Set<string>();
for (const event of events) {
	if (event.event === 'collectorStarted' || event.event === 'connectionLost') counters.clear();
	if (!event.threadId) continue;
	if (event.event === 'newThread') counters.add(event.threadId);
	if (event.event === 'tokens') {
		if (!counters.has(event.threadId) && event.at >= since) {
			candidates.add(event.threadId);
			const list = missing.get(event.threadId) ?? [];
			list.push(event); missing.set(event.threadId, list);
		}
		counters.add(event.threadId);
	}
}
const sessions = join(codexDir, 'sessions');
if (!existsSync(sessions)) throw new Error('No local rollout directory found');
const paths = readdirSync(sessions, { recursive: true }).filter((name): name is string => typeof name === 'string' && name.endsWith('.jsonl'));
const repairs: UsageEvent[] = [];
for (const id of candidates) {
	const relative = paths.find((path) => path.endsWith(`-${id}.jsonl`));
	if (!relative) continue;
	let ownMeta: any = null;
	let context: any = null;
	let ownFirstContext: any = null;
	let firstOwnTokens: any = null;
	const completed = new Map<string, number>();
	const matched = new Set<UsageEvent>();
	const observedFirst = events.find((event) => event.threadId === id && event.event === 'turn/started');
	const lines = createInterface({ input: createReadStream(join(sessions, relative)), crlfDelay: Infinity });
	for await (const line of lines) {
		// Never retain prompts, tool outputs, or responses.
		if (!line.includes('session_meta') && !line.includes('turn_context') && !line.includes('token_count') && !line.includes('task_complete')) continue;
		let record: any;
		try { record = JSON.parse(line); } catch { continue; }
		const payload = record.payload;
		if (record.type === 'session_meta' && payload?.id === id && !ownMeta) ownMeta = record;
		if (record.type === 'turn_context') {
			context = payload;
			if (payload?.turn_id === observedFirst?.turnId && !ownFirstContext) ownFirstContext = payload;
		}
		if (record.type === 'event_msg' && payload?.type === 'task_complete' && payload.turn_id) completed.set(payload.turn_id, Date.parse(record.timestamp));
		if (record.type !== 'event_msg' || payload?.type !== 'token_count' || !payload.info) continue;
		const total = payload.info.total_token_usage;
		if (context?.turn_id === observedFirst?.turnId && !firstOwnTokens) firstOwnTokens = payload.info;
		for (const event of missing.get(id) ?? []) {
			if (context?.turn_id === event.turnId && total?.total_tokens === event.total?.totalTokens) matched.add(event);
		}
	}
	const spawn = ownMeta?.payload?.source?.subagent?.thread_spawn;
	const createdAt = Date.parse(ownMeta?.timestamp ?? '');
	if (spawn && observedFirst && Math.abs(createdAt - observedFirst.at) <= 10_000 && ownFirstContext?.model && ownFirstContext?.effort
		&& firstOwnTokens?.total_token_usage?.total_tokens > 0
		&& firstOwnTokens.total_token_usage.total_tokens === firstOwnTokens.last_token_usage?.total_tokens
		&& !events.some((event) => event.threadId === id && event.event === 'spawnedThread')) {
		repairs.push({ at: createdAt, host: 'local', event: 'spawnedThread', threadId: id,
			parentThreadId: spawn.parent_thread_id, model: ownFirstContext.model, effort: ownFirstContext.effort });
	}
	for (const event of matched) {
		const completedAt = completed.get(event.turnId!);
		if (completedAt === undefined || completedAt >= event.at || events.some((proof) => proof.event === 'historicalSnapshot' && proof.threadId === id && proof.snapshotAt === event.at)) continue;
		repairs.push({ at: Date.now(), host: 'local', event: 'historicalSnapshot', threadId: id, turnId: event.turnId,
			snapshotAt: event.at, completedAt, total: event.total });
	}
}
const before = analyzeUsage(events), after = analyzeUsage([...events, ...repairs]);
console.log(JSON.stringify({ apply: process.argv.includes('--apply'), scannedThreads: candidates.size, repairs: repairs.map(({ event, threadId }) => ({ event, threadId })),
	before: { observations: before.observations, excluded: before.excludedIntervals, latest: before.pools[0]?.status },
	after: { observations: after.observations, excluded: after.excludedIntervals, latest: after.pools[0]?.status } }, null, 2));
if (process.argv.includes('--apply') && repairs.length) {
	// Append evidence, preserving the original telemetry and making reruns idempotent.
	const current = files.filter((name) => name.endsWith('.jsonl')).find((name) => readFileSync(join(usageDir, name), 'utf8').split('\n').some((line) => {
		try { return JSON.parse(line).host === 'local'; } catch { return false; }
	}));
	if (!current) throw new Error('No local usage log found');
	appendFileSync(join(usageDir, current), repairs.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

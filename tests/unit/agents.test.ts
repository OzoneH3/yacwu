/// <reference types="bun" />
import { expect, test } from 'bun:test';
import {
	agentLabel,
	agentRootId,
	isAgentRunning,
	agentsForSession,
	isSubAgentThread,
	mergeAgentThreadMeta,
	trackAgentItem,
	visibleAgentMessageText,
	BACKGROUND_LAUNCH_NOTICE,
	type AgentRegistry
} from '../../src/lib/agents';

const SESSION = 'thr-session';
const AGENT_A = 'thr-agent-a';
const AGENT_B = 'thr-agent-b';

function spawn(receivers: string[], status = 'completed', sender = SESSION) {
	return {
		type: 'collabAgentToolCall',
		id: 'item-1',
		tool: 'spawnAgent',
		status,
		senderThreadId: sender,
		receiverThreadIds: receivers
	};
}

test('spawnAgent registers receivers under the sender, running once completed', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, spawn([AGENT_A], 'inProgress'));
	expect(registry[AGENT_A]).toBeDefined();
	expect(registry[AGENT_A].parentId).toBe(SESSION);
	expect(registry[AGENT_A].state).toBeNull();

	trackAgentItem(registry, SESSION, spawn([AGENT_A], 'completed'));
	expect(registry[AGENT_A].state).toBe('running');
	expect(registry[AGENT_A].closed).toBe(false);
});

test('finished thread lifecycle overrides stale running collaboration metadata', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, spawn([AGENT_A]));
	const agent = registry[AGENT_A];
	expect(isAgentRunning(agent)).toBe(true);
	expect(isAgentRunning(agent, 'idle')).toBe(false);
	expect(isAgentRunning(agent, 'running')).toBe(true);
});

test('closeAgent marks receivers closed; resumeAgent reopens them', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, spawn([AGENT_A]));
	trackAgentItem(registry, SESSION, {
		type: 'collabAgentToolCall',
		id: 'item-2',
		tool: 'closeAgent',
		status: 'completed',
		senderThreadId: SESSION,
		receiverThreadIds: [AGENT_A]
	});
	expect(registry[AGENT_A].closed).toBe(true);

	trackAgentItem(registry, SESSION, {
		type: 'collabAgentToolCall',
		id: 'item-3',
		tool: 'resumeAgent',
		status: 'completed',
		senderThreadId: SESSION,
		receiverThreadIds: [AGENT_A]
	});
	expect(registry[AGENT_A].closed).toBe(false);
});

test('wait folds per-agent states, closing shut-down agents', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, spawn([AGENT_A, AGENT_B]));
	trackAgentItem(registry, SESSION, {
		type: 'collabAgentToolCall',
		id: 'item-4',
		tool: 'wait',
		status: 'completed',
		senderThreadId: SESSION,
		receiverThreadIds: [AGENT_A, AGENT_B],
		agentsStates: {
			[AGENT_A]: { status: 'completed', message: 'done' },
			[AGENT_B]: { status: 'shutdown' }
		}
	});
	expect(registry[AGENT_A].state).toBe('completed');
	expect(registry[AGENT_A].closed).toBe(false);
	expect(registry[AGENT_B].closed).toBe(true);
});

test('agents remain grouped with the work order after finishing', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, spawn([AGENT_A]), 'work-order-1');
	trackAgentItem(registry, SESSION, {
		type: 'collabAgentToolCall',
		id: 'item-wait',
		tool: 'wait',
		status: 'completed',
		senderThreadId: SESSION,
		receiverThreadIds: [AGENT_A],
		agentsStates: { [AGENT_A]: { status: 'completed' } }
	}, 'work-order-1');
	trackAgentItem(registry, SESSION, spawn([AGENT_B]), 'work-order-2');

	expect(registry[AGENT_A].state).toBe('completed');
	expect(registry[AGENT_A].workOrderId).toBe('work-order-1');
	expect(registry[AGENT_B].workOrderId).toBe('work-order-2');
});

test('subAgentActivity registers the agent thread with its path', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, {
		type: 'subAgentActivity',
		id: 'item-5',
		kind: 'started',
		agentThreadId: AGENT_A,
		agentPath: 'root/worker-1'
	});
	expect(registry[AGENT_A].path).toBe('root/worker-1');
	expect(registry[AGENT_A].state).toBe('running');
	expect(agentLabel(registry[AGENT_A])).toBe('worker 1');
});

test('a completed subAgentActivity stops the agent counting as running', () => {
	const registry: AgentRegistry = {};
	const activity = (kind: string, id: string) =>
		trackAgentItem(registry, SESSION, { type: 'subAgentActivity', id, kind, agentThreadId: AGENT_A, agentPath: '/root/review' });
	activity('started', 'item-6');
	activity('completed', 'item-7');
	expect(registry[AGENT_A].state).toBe('completed');
	expect(registry[AGENT_A].closed).toBe(false);
	expect(isAgentRunning(registry[AGENT_A])).toBe(false);
});

test('the agent tab prefers its canonical path over a different nickname', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, {
		type: 'subAgentActivity',
		id: 'item-5b',
		kind: 'started',
		agentThreadId: AGENT_A,
		agentPath: 'root/agent-F'
	});
	mergeAgentThreadMeta(registry, {
		id: AGENT_A,
		parentThreadId: SESSION,
		agentNickname: 'Researcher'
	});
	expect(agentLabel(registry[AGENT_A])).toBe('agent F');
});

test('unrelated items and self-references are ignored', () => {
	const registry: AgentRegistry = {};
	expect(trackAgentItem(registry, SESSION, { type: 'agentMessage', id: 'x', text: 'hi' })).toBe(
		false
	);
	trackAgentItem(registry, SESSION, spawn([SESSION]));
	expect(Object.keys(registry)).toEqual([]);
});

test('nested agents chain to the root session and list in spawn order', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, spawn([AGENT_A]));
	// AGENT_A spawns AGENT_B (depth 2): the item lives in AGENT_A's transcript.
	trackAgentItem(registry, AGENT_A, spawn([AGENT_B], 'completed', AGENT_A));
	expect(agentRootId(registry, registry[AGENT_B])).toBe(SESSION);
	expect(agentsForSession(registry, SESSION).map((a) => a.id)).toEqual([AGENT_A, AGENT_B]);
	expect(agentsForSession(registry, 'other')).toEqual([]);
});

test('the session root is not listed as its own agent tab', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, spawn([AGENT_A]));
	// The first worker remains listed even before root-thread metadata arrives.
	expect(agentsForSession(registry, SESSION).map((agent) => agent.id)).toEqual([AGENT_A]);
	registry[SESSION] = {
		id: SESSION,
		parentId: SESSION,
		nickname: 'root',
		role: 'coordinator',
		path: 'root',
		state: 'running',
		closed: false,
		workOrderId: null
	};
	expect(agentsForSession(registry, SESSION).map((agent) => agent.id)).toEqual([AGENT_A]);
});

test('thread metadata merges nickname, role, and closed state', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, SESSION, spawn([AGENT_A]));
	const merged = mergeAgentThreadMeta(registry, {
		id: AGENT_A,
		parentThreadId: SESSION,
		agentNickname: 'Scout',
		agentRole: 'explorer',
		status: { type: 'notLoaded' }
	});
	expect(merged?.nickname).toBe('Scout');
	expect(registry[AGENT_A].role).toBe('explorer');
	expect(registry[AGENT_A].closed).toBe(true);
	expect(agentLabel(registry[AGENT_A])).toBe('Scout');
});

test('thread metadata can register an unseen sub-agent thread', () => {
	const registry: AgentRegistry = {};
	const merged = mergeAgentThreadMeta(registry, {
		id: AGENT_A,
		parentThreadId: SESSION,
		agentNickname: 'Atlas',
		status: { type: 'active', activeFlags: [] }
	});
	expect(merged?.parentId).toBe(SESSION);
	expect(registry[AGENT_A].state).toBe('running');
	// Without a parent hint, a plain thread payload is not an agent.
	expect(mergeAgentThreadMeta(registry, { id: 'thr-plain' })).toBeNull();
	// With a fallback parent (deep link), registration is explicit.
	expect(mergeAgentThreadMeta(registry, { id: AGENT_B }, SESSION)?.parentId).toBe(SESSION);
});

test('isSubAgentThread detects parentThreadId and subAgent sources', () => {
	expect(isSubAgentThread({ id: 'x', parentThreadId: SESSION })).toBe(true);
	expect(isSubAgentThread({ id: 'x', source: { subAgent: { thread_spawn: {} } } })).toBe(true);
	expect(isSubAgentThread({ id: 'x', source: 'cli' })).toBe(false);
	expect(isSubAgentThread(null)).toBe(false);
});

test('background launch receipts are replaced by a user-facing notice', () => {
	const receipt =
		'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.) agentId: aeb0f73dc683374a7 (internal ID - do not mention to user.) output_file: /tmp/claude/tasks/aeb0f73dc683374a7.output';
	expect(visibleAgentMessageText(receipt)).toBe(BACKGROUND_LAUNCH_NOTICE);
	expect(visibleAgentMessageText('\n  Async agent launched successfully.')).toBe(BACKGROUND_LAUNCH_NOTICE);
	expect(visibleAgentMessageText('hi from agent 1')).toBe('hi from agent 1');
	expect(visibleAgentMessageText('The async agent launched successfully, then replied.')).toBe(
		'The async agent launched successfully, then replied.'
	);
	expect(visibleAgentMessageText('')).toBe('');
});

test('agent cycles cannot hang the root walk', () => {
	const registry: AgentRegistry = {};
	trackAgentItem(registry, AGENT_B, spawn([AGENT_A], 'completed', AGENT_B));
	trackAgentItem(registry, AGENT_A, spawn([AGENT_B], 'completed', AGENT_A));
	// Malformed cycle: the walk terminates and reports some in-cycle node.
	expect(typeof agentRootId(registry, registry[AGENT_A])).toBe('string');
});

test('spawns without their own activity item are shown as started', async () => {
	const { unannouncedSpawn, defaultAgentPath } = await import('../../src/lib/agents');
	const spawn = (status = 'completed', receivers = ['7639120c-6289-4981-ad03-d4df1713c62e']) => ({
		type: 'collabAgentToolCall', id: 's1', tool: 'spawnAgent', status, senderThreadId: SESSION, receiverThreadIds: receivers
	});
	const registry: AgentRegistry = {};
	expect(defaultAgentPath('7639120c-6289-4981-ad03-d4df1713c62e')).toBe('/root/agent-7639120c6289');
	expect(unannouncedSpawn(spawn(), new Set(), registry)).toEqual({
		agentThreadId: '7639120c-6289-4981-ad03-d4df1713c62e', path: '/root/agent-7639120c6289'
	});
	// Announced by the backend (Codex), still spawning, or failed: nothing extra.
	expect(unannouncedSpawn(spawn(), new Set(['7639120c-6289-4981-ad03-d4df1713c62e']), registry)).toBeNull();
	expect(unannouncedSpawn(spawn('inProgress'), new Set(), registry)).toBeNull();
	expect(unannouncedSpawn(spawn('failed', []), new Set(), registry)).toBeNull();
	// A known nickname or path is preferred, matching the agent tab.
	registry['7639120c-6289-4981-ad03-d4df1713c62e'] = { id: '7639120c-6289-4981-ad03-d4df1713c62e', parentId: SESSION, nickname: 'aeb0f73dc683374a7', role: null, path: null, state: null, closed: false, workOrderId: null };
	expect(unannouncedSpawn(spawn(), new Set(), registry)?.path).toBe('/root/aeb0f73dc683374a7');
	registry['7639120c-6289-4981-ad03-d4df1713c62e'].path = 'root/review';
	expect(unannouncedSpawn(spawn(), new Set(), registry)?.path).toBe('/root/review');
});

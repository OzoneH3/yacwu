// Claude turns end on Claude Code's own turn-over signal when the adapter's
// input accounting cannot (an input folded in without being echoed, or a last
// result that answers Claude's own task notification).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { installClaudeBackgroundSupport } from '../../scripts/claude-background-runtime.mjs';

const available = existsSync(new URL('../../claude-codex/dist/src/native-runtime.mjs', import.meta.url));
const { NativeClaudeRuntime } = available ? await import('../../claude-codex/dist/src/native-runtime.mjs') : {};
const { TurnInput } = available ? await import('../../claude-codex/dist/src/native-turn-input.mjs') : {};
if (available) installClaudeBackgroundSupport(NativeClaudeRuntime, { idleGraceMs: 30 });
const options = { skip: available ? false : 'Claude adapter checkout is not built' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const events = [];
  const runtime = new NativeClaudeRuntime();
  const input = new TurnInput();
  const pending = {
    context: { threadId: 'thread', turnId: 'turn' },
    handlers: { onEvent: async (e) => events.push(e) },
    input, resolved: false, resolve() {}, reject(e) { throw e; },
    deferredResult: null, workflowFailure: null, structuredBuffer: '',
    workflowToolUseIds: new Set(), workflowLaunches: new Map(), workflowTasks: new Map(),
    completedWorkflowTasks: new Set(), skippedWorkflowTaskIds: new Set(),
    activeSubagents: new Set(), streamedBlocks: new Map(), toolStartSeen: new Set()
  };
  runtime.turns.set('turn', pending);
  const prompt = (text) => {
    input.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
    return input.queue.at(-1).uuid;
  };
  const completed = () => events.filter((e) => e.type === 'completed');
  return { runtime, pending, input, prompt, completed };
}

const idle = (runtime, pending) => runtime.handleSystem(pending, { subtype: 'session_state_changed', state: 'idle' });
const running = (runtime, pending) => runtime.handleSystem(pending, { subtype: 'session_state_changed', state: 'running' });

test('a turn whose last result answers Claude\'s own task notification ends when Claude goes idle', options, async () => {
  const { runtime, pending, prompt, completed } = fixture();
  const task = prompt('Run the gate and review it');
  await runtime.steer('thread', 'Silent progress reminder');
  // The reminder was folded in without being echoed: the turn's answer is "pending".
  await runtime.handleResult(pending, { subtype: 'success', result: 'Waiting on the monitor.', user_message_uuids: [task] });
  // Claude answers its own background-task notification: "foreign" to the adapter.
  await runtime.handleResult(pending, { subtype: 'success', result: 'Final summary.', origin: { kind: 'task-notification' } });
  assert.equal(pending.resolved, false);
  await running(runtime, pending);
  await idle(runtime, pending);
  await pause(60);
  assert.equal(pending.resolved, true);
  assert.equal(completed().length, 1);
  assert.equal(completed()[0].success, true);
  assert.equal(completed()[0].result, 'Final summary.');
});

test('renewed activity or new input during the grace period keeps the turn open', options, async () => {
  const { runtime, pending, prompt, completed } = fixture();
  prompt('Work');
  await runtime.handleResult(pending, { subtype: 'success', result: 'First answer.', origin: { kind: 'task-notification' } });
  await idle(runtime, pending);
  await running(runtime, pending);
  await pause(60);
  assert.equal(pending.resolved, false);
  await idle(runtime, pending);
  await runtime.steer('thread', 'One more thing');
  await pause(60);
  assert.equal(pending.resolved, false);
  await idle(runtime, pending);
  await pause(60);
  assert.equal(pending.resolved, true);
  assert.equal(completed().length, 1);
});

test('idle does not end a turn with tracked background work or without any result', options, async () => {
  const { runtime, pending, prompt } = fixture();
  prompt('Work');
  await idle(runtime, pending);
  await pause(60);
  assert.equal(pending.resolved, false, 'no result yet');
  await runtime.handleSystem(pending, { subtype: 'task_started', task_id: 'tests', is_backgrounded: true, description: 'Tests' });
  await runtime.handleResult(pending, { subtype: 'success', result: 'Waiting.', origin: { kind: 'task-notification' } });
  await idle(runtime, pending);
  await pause(60);
  assert.equal(pending.resolved, false, 'background worker still tracked');
});

test('a normally completed turn is not completed again by a later idle', options, async () => {
  const { runtime, pending, prompt, completed } = fixture();
  const task = prompt('Work');
  await runtime.handleResult(pending, { subtype: 'success', result: 'Done.', user_message_uuids: [task] });
  assert.equal(pending.resolved, true);
  await idle(runtime, pending);
  await pause(60);
  assert.equal(completed().length, 1);
});

test('a failed last result completes as a failure', options, async () => {
  const { runtime, pending, prompt, completed } = fixture();
  prompt('Work');
  await runtime.handleResult(pending, { subtype: 'error_during_execution', is_error: true, result: 'Tool crashed', origin: { kind: 'task-notification' } });
  pending.reject = () => {};
  await idle(runtime, pending);
  await pause(60);
  assert.equal(pending.resolved, true);
  assert.equal(completed()[0].success, false);
});

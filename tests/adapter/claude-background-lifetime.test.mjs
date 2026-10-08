import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { installClaudeBackgroundSupport } from '../../scripts/claude-background-runtime.mjs';

const available = existsSync(new URL('../../claude-codex/dist/src/native-runtime.mjs', import.meta.url));
const { NativeClaudeRuntime } = available ? await import('../../claude-codex/dist/src/native-runtime.mjs') : {};
const { TurnInput } = available ? await import('../../claude-codex/dist/src/native-turn-input.mjs') : {};
if (available) installClaudeBackgroundSupport(NativeClaudeRuntime);
const options = { skip: available ? false : 'Claude adapter checkout is not built' };

function fixture() {
  const events = [];
  const runtime = new NativeClaudeRuntime();
  const input = new TurnInput();
  const pending = {
    context: { threadId: 'thread', turnId: 'turn' },
    handlers: { onEvent: async e => events.push(e) },
    input, resolved: false, resolve() {}, reject(e) { throw e; },
    deferredResult: null, workflowFailure: null, structuredBuffer: '',
    workflowToolUseIds: new Set(), workflowLaunches: new Map(), workflowTasks: new Map(),
    completedWorkflowTasks: new Set(), skippedWorkflowTaskIds: new Set(),
    activeSubagents: new Set(), streamedBlocks: new Map(), toolStartSeen: new Set()
  };
  runtime.turns.set('turn', pending);
  return { runtime, pending, input, events };
}

test('real adapter waits for background workers, then silently requests status before completing', options, async () => {
  const { runtime, pending, input, events } = fixture();
  for (const id of ['agent', 'tests']) await runtime.handleSystem(pending, { subtype: 'task_started', task_id: id, task_type: 'local_agent', description: 'Background worker running', is_backgrounded: true });
  await runtime.handleResult(pending, { subtype: 'success', result: 'Waiting for workers.' });
  assert.equal(pending.resolved, false);
  assert.equal(events.filter(e => e.type === 'completed').length, 0);
  await runtime.handleSystem(pending, { subtype: 'task_notification', task_id: 'agent', status: 'completed', summary: 'Review passed' });
  assert.equal(input.queue.length, 0);
  await runtime.handleSystem(pending, { subtype: 'task_notification', task_id: 'tests', status: 'completed', summary: 'Tests passed' });
  assert.equal(input.queue.length, 1);
  assert.match(input.queue[0].message.content[0].text, /report the current task status/);
  assert.equal(pending.resolved, false);
  assert.equal(pending.deferredResult, null);
  assert.equal(events.filter(e => e.type === 'tool_result').length, 2);
  const uuid = input.queue[0].uuid;
  await runtime.handleResult(pending, { subtype: 'success', result: 'All checks passed.', user_message_uuids: [uuid] });
  assert.equal(pending.resolved, true);
  assert.equal(events.filter(e => e.type === 'completed').length, 1);
});

test('ambient watchers do not keep a turn open, and stopped tracked workers close cleanly', options, async () => {
  const { runtime, pending, events } = fixture();
  await runtime.handleSystem(pending, { subtype: 'task_started', task_id: 'ambient', ambient: true });
  assert.equal(runtime.hasPendingWorkflowTasks(pending), false);
  await runtime.handleSystem(pending, { subtype: 'task_started', task_id: 'agent', is_backgrounded: true });
  assert.equal(runtime.hasPendingWorkflowTasks(pending), true);
  await runtime.stopWorkflowTasks(pending);
  assert.equal(runtime.hasPendingWorkflowTasks(pending), false);
  assert.equal(events.at(-1).isError, true);
});

test('an explicitly finite Monitor remains tracked even when SDK marks it ambient', options, async () => {
  const { runtime, pending } = fixture();
  await runtime.handleAssistant(pending, { message: { content: [{ type: 'tool_use', id: 'monitor-tool', name: 'Monitor', input: { persistent: 'false' } }] } });
  await runtime.handleSystem(pending, { subtype: 'task_started', task_id: 'monitor', tool_use_id: 'monitor-tool', ambient: true, skip_transcript: true });
  assert.equal(runtime.hasPendingWorkflowTasks(pending), true);
  await runtime.handleSystem(pending, { subtype: 'task_notification', task_id: 'monitor', status: 'completed', summary: 'Runner finished' });
  assert.equal(runtime.hasPendingWorkflowTasks(pending), false);
});

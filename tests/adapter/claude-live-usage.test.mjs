// Claude token usage is reported while a turn runs, once per model response,
// and the result adds only what those responses did not already report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { installClaudeBackgroundSupport, usageBeyond } from '../../scripts/claude-background-runtime.mjs';

const available = existsSync(new URL('../../claude-codex/dist/src/native-runtime.mjs', import.meta.url));
const { NativeClaudeRuntime } = available ? await import('../../claude-codex/dist/src/native-runtime.mjs') : {};
const { TurnInput } = available ? await import('../../claude-codex/dist/src/native-turn-input.mjs') : {};
if (available) installClaudeBackgroundSupport(NativeClaudeRuntime, { idleGraceMs: 30 });
const options = { skip: available ? false : 'Claude adapter checkout is not built' };

function fixture() {
  const events = [];
  const runtime = new NativeClaudeRuntime();
  const pending = {
    context: { threadId: 'thread', turnId: 'turn' },
    handlers: { onEvent: async (e) => events.push(e) },
    input: new TurnInput(), resolved: false, resolve() {}, reject(e) { throw e; },
    deferredResult: null, workflowFailure: null, structuredBuffer: '',
    workflowToolUseIds: new Set(), workflowLaunches: new Map(), workflowTasks: new Map(),
    completedWorkflowTasks: new Set(), skippedWorkflowTaskIds: new Set(),
    activeSubagents: new Set(), streamedBlocks: new Map(), toolStartSeen: new Set()
  };
  runtime.turns.set('turn', pending);
  const usage = () => events.filter((e) => e.type === 'usage').map((e) => e.usage);
  return { runtime, pending, usage };
}

const response = (id, usage, text = 'x', parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, role: 'assistant', content: [{ type: 'text', text }], usage } });
const sum = (records) => records.reduce((total, u) => { for (const [k, v] of Object.entries(u)) total[k] = (total[k] ?? 0) + v; return total; }, {});

test('usage arrives per response while the turn runs and the result adds only the rest', options, async () => {
  const { runtime, pending, usage } = fixture();
  await runtime.handleAssistant(pending, response('msg_1', { input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 3 }));
  // The same response again (its next content block), with more output.
  await runtime.handleAssistant(pending, response('msg_1', { input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 40 }));
  await runtime.handleAssistant(pending, response('msg_2', { input_tokens: 20, cache_read_input_tokens: 6000, cache_creation_input_tokens: 100, output_tokens: 60 }));
  // A subagent's response is left to the result.
  await runtime.handleAssistant(pending, response('msg_sub', { input_tokens: 999, output_tokens: 999 }, 'x', 'toolu_1'));
  const live = sum(usage());
  assert.deepEqual(live, { input_tokens: 30, output_tokens: 100, cache_read_input_tokens: 11000, cache_creation_input_tokens: 100 }, 'reported before the turn ends');

  // The result's total also covers the subagent's tokens.
  await runtime.handleResult(pending, { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 130, output_tokens: 200, cache_read_input_tokens: 11000, cache_creation_input_tokens: 100 } });
  assert.deepEqual(sum(usage()), { input_tokens: 130, output_tokens: 200, cache_read_input_tokens: 11000, cache_creation_input_tokens: 100 }, 'the turn total matches the result, nothing counted twice');
});

test('a result with nothing streamed before it reports its usage unchanged', options, async () => {
  const { runtime, pending, usage } = fixture();
  await runtime.handleResult(pending, { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 7, output_tokens: 2 } });
  assert.deepEqual(usage(), [{ input_tokens: 7, output_tokens: 2 }]);
});

test('usageBeyond never goes below zero', () => {
  assert.deepEqual(usageBeyond({ input_tokens: 5, output_tokens: 1 }, { input_tokens: 9 }), { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

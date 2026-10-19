import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const available = existsSync(new URL('../../claude-codex/dist/src/native-runtime.mjs', import.meta.url));
const { NativeClaudeRuntime } = available ? await import('../../claude-codex/dist/src/native-runtime.mjs') : {};
const adapterOptions = { skip: available ? false : 'Claude adapter checkout is not built' };

import { installClaudeReadOnlySupport, CLAUDE_READ_ONLY_TOOLS, CLAUDE_READ_ONLY_CAPABILITY } from '../../scripts/claude-readonly.mjs';
class Server { async dispatch(_peer, method) { return method === 'initialize' ? { userAgent: 'test' } : { untouched: true }; } }
if (available) installClaudeReadOnlySupport(NativeClaudeRuntime, Server);

const context = { threadId: 'read-only-thread', turnId: 'read-only-turn', prompt: 'Read the project', cwd: process.cwd(), runtimeType: null, model: null, effort: null, claudeSessionId: null, forkSession: false, mcpServers: { writable: { command: 'example' } }, allowedTools: ['Write', 'Bash'], addDirs: [], enableFileCheckpointing: false, outputFormat: null, approvalPolicy: 'never', sandboxMode: 'read-only', systemPromptAddendum: null, planMode: false, imageInputs: [] };
function fixture(overrides = {}) {
 const runtime = new NativeClaudeRuntime();
 runtime.turns.set(context.turnId, { handlers: { onUserInputRequest: async () => ({ answers: {} }) } });
 return { runtime, options: runtime.buildOptions({}, { ...context, ...overrides }, new AbortController()) };
}

test('read-only Claude cannot approve file edits even with approvalPolicy never', adapterOptions, async () => {
 const { options } = fixture();
 const result = await options.canUseTool('Write', { file_path: 'forbidden.txt', content: 'forbidden' }, { signal: new AbortController().signal });
 assert.equal(result.behavior, 'deny');
});


test('read-only blocks shell, edits, agents, MCP and unknown tools at both guards', adapterOptions, async () => {
 const { options } = fixture({ allowedTools: ['Bash', 'Write'], planMode: true });
 assert.deepEqual(options.tools, [...CLAUDE_READ_ONLY_TOOLS]);
 assert.deepEqual(options.allowedTools, ['Read', 'Glob', 'Grep']);
 assert.deepEqual(options.mcpServers, {}); assert.equal(options.strictMcpConfig, true);
 assert.deepEqual(options.settingSources, []); assert.deepEqual(options.agents, {}); assert.deepEqual(options.skills, []); assert.deepEqual(options.plugins, []);
 for (const name of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task', 'Skill', 'mcp__files__write', 'NewSdkTool']) {
  const decision = await options.canUseTool(name, {}, { signal: new AbortController().signal });
  assert.equal(decision.behavior, 'deny', name);
  const hook = options.hooks.PreToolUse[0].hooks[0];
  assert.equal((await hook({ tool_name: name })).hookSpecificOutput.permissionDecision, 'deny', name);
 }
 for (const name of ['Read', 'Glob', 'Grep']) {
  assert.equal((await options.canUseTool(name, {}, {})).behavior, 'allow');
  assert.deepEqual(await options.hooks.PreToolUse[0].hooks[0]({ tool_name: name }), {});
 }
});

test('read-only overrides environment bypass and preserves interactive questions', adapterOptions, async () => {
 const previous = process.env.CLAUDE_CODEX_PERMISSION_MODE;
 process.env.CLAUDE_CODEX_PERMISSION_MODE = 'bypassPermissions';
 try {
  const { options } = fixture();
  assert.equal(options.permissionMode, 'default'); assert.equal(options.allowDangerouslySkipPermissions, false);
  const answer = await options.canUseTool('AskUserQuestion', { questions: [{ header: 'Scope', question: 'What should I inspect?', options: [{ label: 'Source', description: 'Read source' }, { label: 'Docs', description: 'Read docs' }], multiSelect: false }] }, { signal: new AbortController().signal, toolUseID: 'question' });
  assert.equal(answer.behavior, 'deny'); // SDK bridge carries the answer without executing the CLI tool.
  assert.doesNotMatch(answer.message, /This Claude session is read-only/);
 } finally { if (previous == null) delete process.env.CLAUDE_CODEX_PERMISSION_MODE; else process.env.CLAUDE_CODEX_PERMISSION_MODE = previous; }
});

test('read/write retains normal tools and initialization advertises the installed guard', adapterOptions, async () => {
 const { options } = fixture({ sandboxMode: 'danger-full-access' });
 assert.equal(options.tools, undefined);
 assert.deepEqual(options.allowedTools, ['Write', 'Bash']);
 assert.equal((await options.canUseTool('Write', {}, { signal: new AbortController().signal })).behavior, 'allow');
 const server = new Server();
 assert.equal((await server.dispatch({}, 'initialize')).yacwuCapabilities.readOnlyFileAccess, CLAUDE_READ_ONLY_CAPABILITY);
 assert.deepEqual(await server.dispatch({}, 'anything-else'), { untouched: true });
});

test('incompatible adapter versions cannot advertise read-only support', adapterOptions, () => {
 class Missing {};
 assert.throws(() => installClaudeReadOnlySupport(Missing, Server), /lacks read-only/);
});


test('legacy proxy runtimes and shell shortcuts cannot bypass the read-only guard', adapterOptions, async () => {
 const server = new Server();
 server.store = { getThread: () => ({ runtimeBackend: 'codex', sandboxMode: 'danger-full-access' }) };
 await assert.rejects(server.dispatch({}, 'turn/start', { threadId: 'legacy', sandboxPolicy: { type: 'readOnly' } }), /Claude-backed session/);
 server.store = { getThread: () => ({ runtimeBackend: 'claude', sandboxMode: 'read-only' }) };
 await assert.rejects(server.dispatch({}, 'thread/shellCommand', { threadId: 'thread', command: 'touch forbidden' }), /Shell shortcuts are disabled/);
 assert.deepEqual(await server.dispatch({}, 'turn/start', { threadId: 'thread', sandboxPolicy: { type: 'dangerFullAccess' } }), { untouched: true });
});

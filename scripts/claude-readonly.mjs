/** Restrict Claude sessions to file observation and interactive questions.
 * Installed in Yacwu's launch shim; no external adapter checkout changes.
 * Unknown tools are denied too, so new SDK tools do not gain write access.
 */
export const CLAUDE_READ_ONLY_CAPABILITY = 'read-tools-v1';
export const CLAUDE_READ_ONLY_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'AskUserQuestion']);
const readTools = new Set(CLAUDE_READ_ONLY_TOOLS);
const denied = 'This Claude session is read-only. Only file reads, file searches and questions are allowed. Commands, edits, subagents and external tools are disabled.';

/** @param {any} Runtime @param {any} Server */
export function installClaudeReadOnlySupport(Runtime, Server) {
 const proto = Runtime.prototype;
 if (proto.yacwuReadOnlySupport) return;
 for (const method of ['buildOptions', 'makeCanUseTool']) {
  if (typeof proto[method] !== 'function') throw new Error(`Claude adapter lacks read-only compatibility method: ${method}`);
 }
 if (typeof Server.prototype.dispatch !== 'function') throw new Error('Claude adapter lacks read-only capability dispatch');
 const build = proto.buildOptions;
 proto.buildOptions = function(sdk, context, abort) {
  const opts = build.call(this, sdk, context, abort);
  if (context?.sandboxMode !== 'read-only') return opts;
  const permission = this.makeCanUseTool(context, false);
  // Do not reuse user/project permissions, hooks, aliases, agents or MCP
  // configuration when resuming a previously writable Claude conversation.
  opts.tools = [...CLAUDE_READ_ONLY_TOOLS];
  opts.allowedTools = ['Read', 'Glob', 'Grep'];
  opts.disallowedTools = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task', 'Skill', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'TodoWrite'];
  opts.permissionMode = 'default';
  opts.allowDangerouslySkipPermissions = false;
  opts.settingSources = [];
  opts.mcpServers = {};
  opts.strictMcpConfig = true;
  opts.agents = {};
  opts.plugins = [];
  opts.skills = [];
  opts.toolAliases = {};
  opts.enableFileCheckpointing = false;
  opts.settings = { hooks: {}, disableAllHooks: false, enableWorkflows: false, workflowKeywordTriggerEnabled: false };
  opts.canUseTool = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ options) => {
   if (!readTools.has(tool)) return { behavior: 'deny', message: denied };
   // Preserve Yacwu's question dock. Read tools need no approval round-trip.
   if (tool === 'AskUserQuestion') return permission(tool, input, options);
   return { behavior: 'allow', updatedInput: input };
  };
  opts.hooks = { PreToolUse: [{ hooks: [async (/** @type {any} */ input) => readTools.has(input.tool_name) ? {} : {
   hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denied }
  }] }] };
  return opts;
 };
 proto.yacwuReadOnlySupport = true;
 // Advertise only from the process that installed the enforcement. An old
 // persistent daemon must remain ineligible until the user restarts it.
 const dispatch = Server.prototype.dispatch;
 Server.prototype.dispatch = async function(peer, method, params) {
  if (method === 'turn/start' || method === 'thread/shellCommand') {
   const thread = this.store?.getThread(params?.threadId);
   const policy = params?.sandboxPolicy?.type;
   const readOnly = policy === 'readOnly' || params?.sandbox === 'read-only' || (policy == null && params?.sandbox == null && thread?.sandboxMode === 'read-only');
   if (readOnly && method === 'thread/shellCommand') throw new Error('Shell shortcuts are disabled for read-only Claude sessions.');
   // Older adapter stores can contain GPT sessions routed through a second
   // runtime. They must never bypass the native Claude tool restrictions.
   if (readOnly && thread?.runtimeBackend === 'codex') throw new Error('Create a Claude-backed session to use Claude read-only mode.');
  }
  const result = await dispatch.call(this, peer, method, params);
  return method === 'initialize' ? { ...result, yacwuCapabilities: { ...result?.yacwuCapabilities, readOnlyFileAccess: CLAUDE_READ_ONLY_CAPABILITY } } : result;
 };
}

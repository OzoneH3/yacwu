// A claude-codex runtime backed by GitHub Copilot CLI's Agent Client
// Protocol server (`copilot --acp`, newline-delimited JSON-RPC on stdio).
// The adapter keeps threads, turns and items; this runtime turns each of its
// turns into ACP prompts and Copilot's session updates back into the
// adapter's runtime events. One Copilot process serves every session and is
// restarted on demand if it exits.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Copilot model ids carry this prefix in Yacwu, so `gpt-…` names are not
 * mistaken for the adapter's own Codex models. */
export const MODEL_PREFIX = 'copilot/';
/** Leading text of the block that carries Yacwu's instructions. */
export const INSTRUCTIONS_MARKER = '<yacwu-instructions>';
const PLAN_MODE = 'https://agentclientprotocol.com/protocol/session-modes#plan';
const AGENT_MODE = 'https://agentclientprotocol.com/protocol/session-modes#agent';

export class AcpError extends Error {
  /** @param {string} message @param {number | undefined} code @param {unknown} data */
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * One running ACP agent process.
 * @param {{command: string[], env?: NodeJS.ProcessEnv, cwd?: string,
 *   onRequest: (method: string, params: any) => Promise<unknown>,
 *   onUpdate: (sessionId: string, update: any) => void,
 *   onExit?: (connection: AcpConnection) => void}} options
 */
export class AcpConnection {
  constructor({ command, env, cwd, onRequest, onUpdate, onExit }) {
    this.child = spawn(command[0], command.slice(1), { env: env ?? process.env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>} */
    this.pending = new Map();
    this.closed = false;
    this.stderr = '';
    this.onRequest = onRequest;
    this.onUpdate = onUpdate;
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    const close = (/** @type {string} */ why) => {
      if (this.closed) return;
      this.closed = true;
      const detail = this.stderr.trim().split('\n').slice(-3).join(' ');
      for (const { reject } of this.pending.values()) reject(new AcpError(`Copilot stopped (${why})${detail ? `: ${detail}` : ''}`, undefined, null));
      this.pending.clear();
      onExit?.(this);
    };
    this.child.on('error', (error) => close(error.message));
    this.child.on('exit', (code, signal) => close(signal ? `signal ${signal}` : `exit code ${code}`));
  }

  /** @param {string} line */
  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id != null) {
      Promise.resolve()
        .then(() => this.onRequest(message.method, message.params))
        .then((result) => this.write({ jsonrpc: '2.0', id: message.id, result }),
          (error) => this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
    } else if (message.method === 'session/update') {
      this.onUpdate(message.params?.sessionId, message.params?.update ?? {});
    } else if (message.id != null && this.pending.has(message.id)) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiting?.reject(new AcpError(message.error.message ?? 'Copilot request failed', message.error.code, message.error.data));
      else waiting?.resolve(message.result);
    }
  }

  /** @param {unknown} message */
  write(message) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** @param {string} method @param {unknown} params @returns {Promise<any>} */
  request(method, params) {
    if (this.closed) return Promise.reject(new AcpError('Copilot is not running', undefined, null));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** @param {string} method @param {unknown} params */
  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  kill() {
    if (!this.closed) this.child.kill();
  }
}

/** The text of ACP content: a block, a list of blocks, or tool call content. @returns {string} */
export function contentText(/** @type {any} */ content) {
  if (!content) return '';
  if (Array.isArray(content)) return content.map(contentText).join('');
  if (content.type === 'content') return contentText(content.content);
  if (content.type === 'text') return String(content.text ?? '');
  if (content.type === 'resource_link') return String(content.uri ?? '');
  if (content.type === 'resource') return String(content.resource?.text ?? content.resource?.uri ?? '');
  return '';
}

/** What a finished tool returned, as text. */
function toolOutput(/** @type {any} */ update, /** @type {string} */ streamed) {
  const raw = update.rawOutput;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.content === 'string') return raw.content;
  return contentText((update.content ?? []).filter((/** @type {any} */ c) => c.type !== 'diff')) || streamed;
}

/**
 * The adapter tool calls an ACP tool call stands for: a shell command maps
 * to Bash, each file a diff touches to Write or Edit, a read to Read, a
 * search to Grep; anything else keeps Copilot's title. Edits are only
 * known once Copilot sends their diff; until then this returns none.
 * @param {any} call merged tool_call state
 * @returns {Array<{toolUseId: string, toolName: string, input: Record<string, unknown>}>}
 */
export function toolUses(call) {
  const id = String(call.toolCallId);
  const raw = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const title = String(call.title ?? '') || 'Tool';
  const location = call.locations?.[0]?.path;
  const diffs = (call.content ?? []).filter((/** @type {any} */ c) => c.type === 'diff' && c.path);
  if (call.kind === 'edit' || call.kind === 'delete' || diffs.length) {
    return diffs.map((/** @type {any} */ diff, /** @type {number} */ index) => ({
      toolUseId: index ? `${id}#${index}` : id,
      ...(diff.oldText == null || (diff.oldText === '' && raw.file_text != null)
        ? { toolName: 'Write', input: { file_path: diff.path, content: String(diff.newText ?? '') } }
        : { toolName: 'Edit', input: { file_path: diff.path, old_string: String(diff.oldText), new_string: String(diff.newText ?? '') } })
    }));
  }
  if (call.kind === 'execute') return [{ toolUseId: id, toolName: 'Bash', input: { command: String(raw.command ?? title), ...(raw.description ? { description: raw.description } : {}) } }];
  if (call.kind === 'read' && (raw.path || location)) return [{ toolUseId: id, toolName: 'Read', input: { file_path: String(raw.path ?? location) } }];
  if (call.kind === 'search' && raw.pattern) return [{ toolUseId: id, toolName: 'Grep', input: { pattern: String(raw.pattern), ...(raw.paths?.[0] ?? raw.path ? { path: String(raw.paths?.[0] ?? raw.path) } : {}) } }];
  return [{ toolUseId: id, toolName: title, input: raw }];
}

/**
 * Model choices from a session/new or session/load result, once each (Copilot
 * lists "auto" twice), with Copilot's cost multiplier ("15x" premium
 * requests per prompt), price category and whether the account may use it.
 */
export function sessionModels(/** @type {any} */ result) {
  const option = (result?.configOptions ?? []).find((/** @type {any} */ o) => o.category === 'model' || o.id === 'model');
  const entries = option
    ? (option.options ?? []).flatMap((/** @type {any} */ o) => Array.isArray(o.options) ? o.options : [o]).map((/** @type {any} */ o) => ({ id: o.value, name: o.name, description: o.description, meta: o._meta }))
    : (result?.models?.availableModels ?? []).map((/** @type {any} */ m) => ({ id: m.modelId, name: m.name, description: m.description, meta: m._meta }));
  /** @type {Map<string, {id: string, name: string, description: string, usage: string | null, price: string | null, enabled: boolean}>} */
  const models = new Map();
  for (const entry of entries) {
    const id = String(entry.id ?? '');
    if (!id) continue;
    const previous = models.get(id);
    const meta = entry.meta ?? {};
    models.set(id, {
      id,
      name: String(previous?.name ?? entry.name ?? id),
      description: String(previous?.description || entry.description || ''),
      usage: typeof meta.copilotUsage === 'string' ? meta.copilotUsage : previous?.usage ?? null,
      price: typeof meta.copilotPriceCategory === 'string' ? meta.copilotPriceCategory : previous?.price ?? null,
      enabled: meta.copilotEnablement == null ? previous?.enabled ?? true : meta.copilotEnablement === 'enabled'
    });
  }
  return { current: option?.currentValue ?? result?.models?.currentModelId ?? null, models: [...models.values()] };
}

/** The thinking levels a session offers for its current model, and the preset one. */
export function sessionEfforts(/** @type {any} */ configOptions) {
  const option = (configOptions ?? []).find((/** @type {any} */ o) => o.category === 'thought_level');
  if (!option) return { efforts: [], defaultEffort: null };
  return { efforts: (option.options ?? []).map((/** @type {any} */ o) => String(o.value)), defaultEffort: option.currentValue ?? null };
}

/** The command that starts Copilot's ACP server. */
export function copilotCommand(env = process.env) {
  const cli = env.YACWU_COPILOT_CLI?.trim();
  return [...(cli ? cli.split(/\s+/) : ['copilot']), '--acp', ...(env.YACWU_COPILOT_ARGS?.trim() ? env.YACWU_COPILOT_ARGS.trim().split(/\s+/) : [])];
}

/** A clearer message for Copilot's sign-in and start-up failures. */
export function explain(/** @type {unknown} */ error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|login|sign.?in|unauthori[sz]ed|not logged/i.test(message) || (error instanceof AcpError && error.code === -32000)) {
    return `Copilot isn't signed in on this machine. Run \`copilot login\` in a terminal, then send the message again. (${message})`;
  }
  if (/ENOENT|spawn/.test(message)) return `Copilot CLI not found. Install it (npm install -g @github/copilot) or set YACWU_COPILOT_CLI. (${message})`;
  return message;
}

export class CopilotAcpRuntime {
  /** @param {{command?: string[], env?: NodeJS.ProcessEnv}} [options] */
  constructor(options = {}) {
    this.command = options.command ?? copilotCommand(options.env);
    this.env = options.env ?? process.env;
    /** @type {AcpConnection | null} */
    this.connection = null;
    /** @type {Promise<AcpConnection> | null} */
    this.starting = null;
    /** Sessions open in the current Copilot process: id → state. @type {Map<string, {options: any[], models: any, instructions: string | null, cwd: string}>} */
    this.open = new Map();
    /** Sessions whose history Copilot is replaying (updates are ignored). */
    this.loading = new Set();
    /** Instructions found in a replayed history, by session. @type {Map<string, {instructions: string | null}>} */
    this.replays = new Map();
    /** Thinking level each thread's latest turn asked for, as Yacwu named it. @type {Map<string, string>} */
    this.requestedEffort = new Map();
    /** @type {Map<string, any>} running turns by thread */
    this.turns = new Map();
    /** @type {Map<string, any>} the same turns by Copilot session */
    this.bySession = new Map();
  }

  /** @returns {Promise<AcpConnection>} */
  async ready() {
    if (this.connection && !this.connection.closed) return this.connection;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.open.clear();
      const connection = new AcpConnection({
        command: this.command,
        env: this.env,
        onRequest: (method, params) => this.agentRequest(method, params),
        onUpdate: (sessionId, update) => this.update(sessionId, update),
        onExit: (closed) => { if (this.connection === closed) this.connection = null; }
      });
      try {
        await connection.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'yacwu', version: '1' }
        });
      } catch (error) {
        connection.kill();
        throw error;
      }
      this.connection = connection;
      return connection;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  /**
   * Open the thread's Copilot session in the running process: reload a
   * known one (its replayed history is skipped), or start a new one.
   * @param {AcpConnection} connection @param {any} context @param {any} handlers
   */
  async session(connection, context, handlers) {
    const internal = context.purpose === 'summary' || context.purpose === 'compact';
    let sessionId = internal ? null : context.claudeSessionId;
    if (sessionId && context.forkSession) {
      await handlers.onEvent({ type: 'notice', level: 'warning', message: 'Copilot cannot fork a conversation; this copy starts a fresh Copilot conversation without the earlier context.' });
      sessionId = null;
    }
    const previous = sessionId ? this.open.get(sessionId) : null;
    if (sessionId && (!previous || previous.cwd !== context.cwd)) {
      if (this.bySession.has(sessionId)) throw new Error('Cannot change the folder of a running Copilot session. Stop its task first.');
      const loading = sessionId;
      const replay = { instructions: /** @type {string | null} */ (null) };
      this.loading.add(loading);
      this.replays.set(loading, replay);
      try {
        const result = await connection.request('session/load', { sessionId, cwd: context.cwd, mcpServers: [] });
        this.open.set(sessionId, { options: result?.configOptions ?? [], models: result?.models ?? null, instructions: replay.instructions ?? previous?.instructions ?? null, cwd: context.cwd });
      } catch (error) {
        throw new Error(`Copilot could not reopen conversation ${loading}: ${error instanceof Error ? error.message : String(error)}. Its history is retained; retry reopening it. No replacement conversation was started.`);
      } finally {
        this.loading.delete(loading);
        this.replays.delete(loading);
      }
    }
    if (!sessionId) {
      const result = await connection.request('session/new', { cwd: context.cwd, mcpServers: [] });
      sessionId = String(result.sessionId);
      this.open.set(sessionId, { options: result?.configOptions ?? [], models: result?.models ?? null, instructions: null, cwd: context.cwd });
      if (!internal) await handlers.onEvent({ type: 'session', claudeSessionId: sessionId });
    }
    return sessionId;
  }

  /** Apply the turn's model, effort, plan mode and permission level. @param {AcpConnection} connection @param {string} sessionId @param {any} context */
  async configure(connection, sessionId, context) {
    const state = this.open.get(sessionId);
    if (!state) return;
    /** @param {(option: any) => boolean} match @param {string | null | undefined} wanted */
    const set = async (match, wanted) => {
      const option = state.options.find(match);
      if (!option || wanted == null) return false;
      const values = (option.options ?? []).flatMap((/** @type {any} */ o) => Array.isArray(o.options) ? o.options : [o]).map((/** @type {any} */ o) => String(o.value));
      const value = values.find((v) => v.toLowerCase() === wanted.toLowerCase());
      if (!value || value === option.currentValue) return true;
      const result = await connection.request('session/set_config_option', { sessionId, configId: option.id, value });
      state.options = result?.configOptions ?? state.options.map((/** @type {any} */ o) => o === option ? { ...o, currentValue: value } : o);
      return true;
    };
    const requestedModel = typeof context.model === 'string' && context.model.startsWith(MODEL_PREFIX) ? context.model.slice(MODEL_PREFIX.length) : null;
    const model = !requestedModel || /^(?:auto|default)$/i.test(requestedModel) ? 'gpt-6-luna' : requestedModel;
    if (!await set((o) => o.category === 'model' || o.id === 'model', model)) {
      if (!state.models?.availableModels?.some((/** @type {any} */ m) => m.modelId === model)) throw new Error(`Copilot model is unavailable: ${model}`);
      if (state.models.currentModelId !== model) {
        await connection.request('session/set_model', { sessionId, modelId: model });
        state.models.currentModelId = model;
      }
    }
    const effort = this.requestedEffort.get(context.threadId) ?? context.effort;
    if (effort) await set((o) => o.category === 'thought_level', effort);
    await set((o) => o.category === 'mode' || o.id === 'mode', context.planMode ? PLAN_MODE : AGENT_MODE);
    const fullAccess = context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access';
    await set((o) => o.id === 'allow_all', fullAccess ? 'on' : 'off');
  }

  /** @param {any} context @param {any} handlers */
  async runTurn(context, handlers) {
    let connection;
    try {
      connection = await this.ready();
    } catch (error) {
      throw new Error(explain(error));
    }
    let sessionId;
    try {
      sessionId = await this.session(connection, context, handlers);
      await this.configure(connection, sessionId, context);
    } catch (error) {
      throw new Error(explain(error));
    }
    const state = this.open.get(sessionId);
    const turn = {
      threadId: context.threadId, sessionId, connection, handlers,
      fullAccess: context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access',
      /** @type {Map<string, any>} */ tools: new Map(),
      /** @type {string[]} */ queue: [],
      cancelled: false, afterTool: false, text: '', plans: 0,
      /** @type {Promise<void>} */ events: Promise.resolve(),
      /** @type {Set<(value: any) => void>} */ permissions: new Set()
    };
    this.turns.set(context.threadId, turn);
    this.bySession.set(sessionId, turn);
    try {
      /** @type {any[]} */
      let prompt = [];
      const instructions = context.systemPromptAddendum?.trim();
      if (instructions && state && state.instructions !== instructions) {
        prompt.push({ type: 'text', text: `${INSTRUCTIONS_MARKER}\n${instructions}\n</yacwu-instructions>` });
        state.instructions = instructions;
      }
      prompt.push({ type: 'text', text: context.prompt });
      for (const image of context.imageInputs ?? []) {
        prompt.push(image.kind === 'base64'
          ? { type: 'image', mimeType: image.mediaType, data: image.data }
          : { type: 'resource_link', uri: image.data, name: image.displayPath || image.data });
      }
      let stopReason = 'end_turn';
      for (;;) {
        const result = await connection.request('session/prompt', { sessionId, prompt });
        await turn.events;
        stopReason = result?.stopReason ?? 'end_turn';
        const usage = result?.usage;
        if (usage) {
          await handlers.onEvent({ type: 'usage', usage: {
            input_tokens: Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedReadTokens ?? 0)),
            output_tokens: usage.outputTokens ?? 0,
            cache_read_input_tokens: usage.cachedReadTokens ?? 0,
            cache_creation_input_tokens: usage.cachedWriteTokens ?? 0
          } });
        }
        if (turn.cancelled || stopReason === 'cancelled' || !turn.queue.length) break;
        // Messages sent while Copilot was working go in as the next prompt
        // of the same turn: ACP cannot add input to a running prompt.
        prompt = [{ type: 'text', text: turn.queue.splice(0).join('\n\n') }];
        turn.afterTool = false;
        await handlers.onEvent({ type: 'message_boundary' });
      }
      if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
        await handlers.onEvent({ type: 'notice', level: 'warning', message: stopReason === 'max_tokens' ? 'Copilot stopped: it reached its output limit.' : 'Copilot stopped: it reached its limit of requests for one prompt.' });
      }
      const success = !turn.cancelled && stopReason !== 'cancelled' && stopReason !== 'refusal';
      await handlers.onEvent({ type: 'completed', success, claudeSessionId: sessionId, result: stopReason === 'refusal' ? 'Copilot refused to continue.' : turn.text || null });
    } catch (error) {
      await turn.events.catch(() => {});
      if (turn.cancelled) {
        await handlers.onEvent({ type: 'completed', success: false, claudeSessionId: sessionId, result: null });
      } else {
        throw new Error(explain(error));
      }
    } finally {
      if (this.turns.get(context.threadId) === turn) this.turns.delete(context.threadId);
      if (this.bySession.get(sessionId) === turn) this.bySession.delete(sessionId);
    }
  }

  /** @param {string} sessionId @param {any} update */
  update(sessionId, update) {
    if (this.loading.has(sessionId)) {
      const replay = this.replays.get(sessionId);
      const text = update.sessionUpdate === 'user_message_chunk' ? contentText(update.content) : '';
      if (replay && text.startsWith(INSTRUCTIONS_MARKER)) replay.instructions = text.slice(INSTRUCTIONS_MARKER.length).replace(/<\/yacwu-instructions>\s*$/, '').trim();
      return;
    }
    const turn = this.bySession.get(sessionId);
    if (!turn) return;
    // Handle updates strictly in order, even though the adapter's handlers are async.
    turn.events = turn.events.then(() => this.apply(turn, update)).catch(() => {});
  }

  /** @param {any} turn @param {any} update */
  async apply(turn, update) {
    const emit = (/** @type {any} */ event) => turn.handlers.onEvent(event);
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(update.content);
        if (!text) return;
        if (turn.afterTool) { turn.afterTool = false; await emit({ type: 'message_boundary' }); turn.text = ''; }
        turn.text += text;
        await emit({ type: 'text_delta', delta: text });
        return;
      }
      case 'agent_thought_chunk': {
        const text = contentText(update.content);
        if (text) await emit({ type: 'reasoning_delta', delta: text });
        return;
      }
      case 'tool_call':
      case 'tool_call_update':
        await this.tool(turn, update);
        return;
      case 'plan': {
        const todos = (update.entries ?? []).map((/** @type {any} */ entry) => ({ content: String(entry.content ?? ''), status: String(entry.status ?? 'pending'), activeForm: String(entry.content ?? '') }));
        const toolUseId = `copilot-plan:${turn.plans++}`;
        await emit({ type: 'tool_use', toolUseId, toolName: 'TodoWrite', input: { todos } });
        return;
      }
      default:
    }
  }

  /** Start tool items as soon as their kind is known; finish them on a final status. @param {any} turn @param {any} update */
  async tool(turn, update) {
    const id = String(update.toolCallId ?? '');
    if (!id) return;
    const call = turn.tools.get(id) ?? { toolCallId: id, started: [], output: '' };
    for (const key of ['title', 'kind', 'status', 'rawInput', 'locations', 'rawOutput']) if (update[key] !== undefined) call[key] = update[key];
    if (update.content) call.content = update.content;
    turn.tools.set(id, call);
    turn.afterTool = true;
    const done = call.status === 'completed' || call.status === 'failed';
    let uses = toolUses(call);
    // An edit with no diff yet is announced once its diff arrives (or it ends).
    if (!uses.length && done) uses = [{ toolUseId: id, toolName: String(call.title ?? 'Edit file'), input: call.rawInput ?? {} }];
    for (const use of uses) {
      if (call.started.includes(use.toolUseId)) continue;
      call.started.push(use.toolUseId);
      await turn.handlers.onEvent({ type: 'tool_use', ...use });
    }
    const text = contentText((call.content ?? []).filter((/** @type {any} */ c) => c.type !== 'diff'));
    if (!done && text.length > call.output.length && text.startsWith(call.output) && call.started.length) {
      await turn.handlers.onEvent({ type: 'tool_output_delta', toolUseId: call.started[0], delta: text.slice(call.output.length) });
      call.output = text;
    }
    if (done && !call.finished) {
      call.finished = true;
      const output = toolOutput(call, call.output);
      for (const toolUseId of call.started) await turn.handlers.onEvent({ type: 'tool_result', toolUseId, content: output, isError: call.status === 'failed' });
    }
  }

  /** Requests from Copilot: permission to run a tool. @param {string} method @param {any} params */
  async agentRequest(method, params) {
    if (method !== 'session/request_permission') throw new Error(`Yacwu does not support ${method}`);
    const turn = this.bySession.get(params?.sessionId);
    const options = params?.options ?? [];
    const pick = (/** @type {string[]} */ kinds) => options.find((/** @type {any} */ o) => kinds.includes(o.kind))?.optionId;
    if (!turn || turn.cancelled) return { outcome: { outcome: 'cancelled' } };
    if (turn.fullAccess) return { outcome: { outcome: 'selected', optionId: pick(['allow_once', 'allow_always']) ?? options[0]?.optionId } };
    await turn.events;
    const call = params.toolCall ?? {};
    const known = turn.tools.get(String(call.toolCallId));
    const use = toolUses({ ...known, ...call, content: call.content ?? known?.content, rawInput: known?.rawInput ?? call.rawInput })[0]
      ?? { toolUseId: String(call.toolCallId), toolName: String(call.title ?? 'Tool'), input: call.rawInput ?? {} };
    const decision = await new Promise((resolve, reject) => {
      turn.permissions.add(resolve);
      Promise.resolve(turn.handlers.onPermissionRequest({ type: 'permission_request', requestId: String(call.toolCallId), ...use }))
        .then(resolve, reject)
        .finally(() => turn.permissions.delete(resolve));
    });
    if (turn.cancelled || decision?.decision === 'cancel') return { outcome: { outcome: 'cancelled' } };
    const optionId = decision?.decision === 'accept' ? pick(['allow_once'])
      : decision?.decision === 'acceptForSession' ? pick(['allow_always', 'allow_once'])
        : pick(['reject_once', 'reject_always']);
    return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
  }

  /** @param {string} threadId @param {string} prompt */
  async steer(threadId, prompt) {
    const turn = this.turns.get(threadId);
    if (!turn) throw new Error('no running Copilot turn to add to');
    turn.queue.push(prompt);
  }

  /** @param {string} threadId */
  async interrupt(threadId) {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.cancelled = true;
    turn.queue.length = 0;
    for (const resolve of turn.permissions) resolve({ decision: 'cancel' });
    turn.connection.notify('session/cancel', { sessionId: turn.sessionId });
  }

  async stop() {
    this.connection?.kill();
    this.connection = null;
  }
}

/**
 * Copilot's models for the model picker, read from a throwaway session (no
 * prompt is sent): each usable model with its cost and, by selecting it in
 * that session, the thinking levels it offers.
 * @param {{command?: string[], env?: NodeJS.ProcessEnv, cwd: string, timeoutMs?: number}} options
 */
export async function discoverCopilotModels({ command, env, cwd, timeoutMs = 60_000 }) {
  const connection = new AcpConnection({ command: command ?? copilotCommand(env), env, onRequest: async () => ({ outcome: { outcome: 'cancelled' } }), onUpdate: () => {} });
  const timer = setTimeout(() => connection.kill(), timeoutMs);
  try {
    const init = await connection.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'yacwu', version: '1' } });
    const created = await connection.request('session/new', { cwd, mcpServers: [] });
    const { current, models } = sessionModels(created);
    const modelOption = (created.configOptions ?? []).find((/** @type {any} */ o) => o.category === 'model' || o.id === 'model');
    const usable = models.filter((model) => model.enabled);
    const described = [];
    for (const model of usable) {
      let efforts = { efforts: /** @type {string[]} */ ([]), defaultEffort: /** @type {string | null} */ (null) };
      if (modelOption) {
        const selected = await connection.request('session/set_config_option', { sessionId: created.sessionId, configId: modelOption.id, value: model.id }).catch(() => null);
        if (selected) efforts = sessionEfforts(selected.configOptions);
      }
      described.push({ ...model, ...efforts });
    }
    if (init?.agentCapabilities?.sessionCapabilities?.close) await connection.request('session/close', { sessionId: created.sessionId }).catch(() => {});
    return { current, models: described };
  } finally {
    clearTimeout(timer);
    connection.kill();
  }
}

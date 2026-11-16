// OpenCode ACP → Yacwu app-server. Magic Context runs inside OpenCode.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { AcpRuntime, sessionModels, sessionEfforts } from './copilot-acp-runtime.mjs';
import { modelListResult } from './copilot-backend.mjs';
import { fetchStatusDetail } from './magic-context-status.mjs';
import { openCodeRateLimits } from './opencode-usage.mjs';

export const OPENCODE_VERSION = '2.3.0';
export const MAGIC_CONTEXT_VERSION = '0.49.56';
export const MODEL_PREFIX = 'opencode/';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeRoot = resolve(process.env.YACWU_OPENCODE_HOME || join(projectRoot, '.workspace/opencode'));

/** A separate managed environment: never rewrites the user's OpenCode configuration. */
export function openCodeEnvironment(root, pluginPath, source = process.env) {
  const model = source.YACWU_OPENCODE_MODEL || 'openai/gpt-6-luna';
  return {
    ...source,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    TMPDIR: join(root, 'tmp'),
    MAGIC_CONTEXT_STORAGE_DIR: join(root, 'memory'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model, update: 'disable', share: 'disabled',
      plugins: [{ package: pathToFileURL(pluginPath).href }],
      compaction: { auto: false, prune: false }
    })
  };
}

/** Model IDs include the OpenCode provider; never apply Copilot prices or defaults. */
export function pickerModels(catalog) {
  return catalog.models.map(model => ({
    id: MODEL_PREFIX + model.id, sdkModel: MODEL_PREFIX + model.id,
    displayName: model.name, description: model.description || '',
    isDefault: model.id === catalog.current,
    efforts: model.efforts || [], defaultEffort: model.defaultEffort || null
  }));
}

export class OpenCodeRuntime extends AcpRuntime {
  constructor(options = {}) {
    super(options);
    this.clientCapabilities = {...this.clientCapabilities, elicitation:{form:true}, session:{compaction:true}};
  }
  async agentRequest(method, params) {
    if (method !== 'elicitation/create') return super.agentRequest(method, params);
    const turn = this.bySession.get(params?.sessionId);
    if (!turn || turn.cancelled || !turn.handlers.onUserInputRequest) return {action:'cancel'};
    const schema = params.requestedSchema?.properties || {};
    const questions = Object.entries(schema).filter(([key]) => !key.endsWith('_custom')).map(([id, field]) => {
      const choices = field.oneOf || field.items?.oneOf || [];
      return {id,header:field.title || id,question:field.description || params.message || id,isOther:true,isSecret:false,
        options:choices.length ? choices.map(choice=>({label:choice.title || String(choice.const),description:choice.description || ''})) : null};
    });
    const answer = await new Promise((resolve,reject) => {
      turn.permissions.add(resolve);
      Promise.resolve(turn.handlers.onUserInputRequest({type:'user_input_request',requestId:params.toolCallId || 'opencode-question',toolUseId:params.toolCallId || 'opencode-question',questions}))
        .then(resolve,reject).finally(()=>turn.permissions.delete(resolve));
    });
    if (turn.cancelled || answer?.decision === 'cancel') return {action:'cancel'};
    const content = {};
    for (const question of questions) {
      const selected=answer?.answers?.[question.id];
      const values=selected?.answers || [];
      const field=schema[question.id];
      const choices=field.oneOf || field.items?.oneOf || [];
      const decoded=values.map(value=>choices.find(choice=>(choice.title || String(choice.const)) === value)?.const ?? value);
      content[question.id]=field.type === 'array' ? decoded : decoded[0] ?? selected?.notes ?? '';
      if (selected?.notes && schema[question.id+'_custom']) content[question.id+'_custom']=selected.notes;
    }
    return {action:'accept',content};
  }
  explain(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|spawn/.test(message)) return 'OpenCode is not installed. Run node scripts/install-opencode.mjs.';
    return message.replaceAll('Copilot', 'OpenCode');
  }
  async runTurn(context, handlers) {
    if (context.sandboxMode === 'read-only' || context.sandboxMode === 'readOnly') {
      throw new Error('Enforced read-only access is not available for OpenCode.');
    }
    return super.runTurn(context, handlers);
  }
  async session(connection, context, handlers) {
    if (context.forkSession && context.claudeSessionId && !['summary', 'compact'].includes(context.purpose)) {
      const result = await connection.request('session/fork', {sessionId: context.claudeSessionId, cwd: context.cwd, mcpServers: []});
      if (!result?.sessionId) throw new Error('OpenCode fork returned no session ID');
      const id = String(result.sessionId);
      this.open.set(id, {options: result.configOptions || [], models: result.models || null, cwd: context.cwd, instructions: null});
      this.contextThreads.set(id, context.threadId);
      await handlers.onEvent({type:'session', claudeSessionId:id});
      return id;
    }
    return super.session(connection, context, handlers);
  }
  async configure(connection, sessionId, context) {
    const state = this.open.get(sessionId);
    if (!state) throw new Error('OpenCode session is not open');
    const set = async (category, wanted) => {
      const option = state.options.find(o => o.category === category || o.id === category);
      const values = (option?.options || []).flatMap(o => o.options || [o]);
      if (!option || !values.some(o => o.value === wanted)) throw new Error(`OpenCode ${category} is unavailable: ${wanted}`);
      if (option.currentValue === wanted) return;
      const result = await connection.request('session/set_config_option', {sessionId, configId:option.id, value:wanted});
      state.options = result?.configOptions || state.options.map(o => o.id === option.id ? {...o, currentValue:wanted} : o);
    };
    if (context.model) {
      if (!context.model.startsWith(MODEL_PREFIX)) throw new Error(`Not an OpenCode model: ${context.model}`);
      await set('model', context.model.slice(MODEL_PREFIX.length));
    }
    const effort = this.requestedEffort.get(context.threadId) || context.effort;
    if (effort && state.options.some(o=>o.category === 'thought_level')) await set('thought_level', effort);
    // Plan is an agent selection, not an enforced filesystem sandbox.
    if (context.planMode) await set('mode', 'plan');
    else {
      const mode = state.options.find(o => o.category === 'mode' || o.id === 'mode');
      if (mode?.currentValue === 'plan') await set('mode', 'build');
    }
  }
  update(sessionId, update) {
    if (update.sessionUpdate === 'config_option_update') {
      const state = this.open.get(sessionId);
      if (state) state.options = update.configOptions || state.options;
    }
    return super.update(sessionId, update);
  }
  async discover(cwd) {
    const connection = await this.ready();
    const result = await connection.request('session/new', {cwd, mcpServers:[]});
    try {
      const catalog = sessionModels(result);
      const models = [];
      // Efforts depend on the selected model; do not pretend they are universal.
      for (const model of catalog.models) {
        const selected = model.id === catalog.current ? result : await connection.request('session/set_config_option', {sessionId:result.sessionId, configId:'model', value:model.id});
        models.push({...model, ...sessionEfforts(selected?.configOptions)});
      }
      return pickerModels({...catalog, models});
    } finally {
      await connection.request('session/delete', {sessionId:result.sessionId}).catch(() => {});
    }
  }
}

/**
 * OpenCode's Go allowance (5-hour rolling, 7-day weekly) is served by the Go
 * gateway, authenticated with the `opencode-go` key OpenCode stores in its
 * database; map it to the app-server rate-limits shape so Yacwu's usage
 * analysis covers OpenCode like the other backends.
 */
export async function openCodeUsageLimits(dataHome) {
  return openCodeRateLimits(dataHome);
}

/**
 * Magic Context reports `/ctx-status` as a TUI action Yacwu cannot render, so
 * read the same status through the plugin's loopback RPC for this session.
 */
export async function openCodeThreadStatus(store, threadId, options = {}) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error('Unknown thread');
  if (!thread.claudeSessionId) throw new Error('Send a message before asking for Magic Context status');
  const { storageDir = join(runtimeRoot, 'memory'), ...rest } = options;
  return fetchStatusDetail({
    storageDir,
    directory: thread.cwd,
    sessionId: thread.claudeSessionId,
    ...rest
  });
}

export function prepareEnvironment(root = runtimeRoot) {
  const tools = join(root, 'tools/node_modules');
  const plugin = join(tools, '@cortexkit/opencode-magic-context');
  if (!existsSync(join(plugin, 'package.json'))) throw new Error('OpenCode/Magic Context are not installed. Run node scripts/install-opencode.mjs.');
  const installedVersion = JSON.parse(readFileSync(join(plugin,'package.json'),'utf8')).version;
  if (installedVersion !== MAGIC_CONTEXT_VERSION) throw new Error(`Expected Magic Context ${MAGIC_CONTEXT_VERSION}; run node scripts/install-opencode.mjs.`);
  const env = openCodeEnvironment(root, plugin);
  for (const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','TMPDIR','MAGIC_CONTEXT_STORAGE_DIR']) mkdirSync(env[key], {recursive:true});
  const config = join(env.XDG_CONFIG_HOME, 'cortexkit');
  mkdirSync(config, {recursive:true});
  writeFileSync(join(config,'magic-context.jsonc'), JSON.stringify({
    auto_update:false, historian:{opencode:{model:process.env.YACWU_OPENCODE_HISTORIAN_MODEL || process.env.YACWU_OPENCODE_MODEL || 'openai/gpt-6-luna'}},
    dreamer:{disable:true}, embedding:{provider:'off'}
  }, null, 2));
  return {env, command:[process.env.YACWU_OPENCODE_CLI || join(tools,'@opencode/cli/bin/opencode.exe'), 'acp']};
}

/** Login must share the managed credentials directory, not the machine-wide service port. */
export function openCodeAuthCommand(binary) {
  return [binary, 'auth', 'login', '--standalone'];
}

async function main() {
  const {env, command} = prepareEnvironment();
  if (process.argv[2] === 'auth') {
    const [binary, ...args] = openCodeAuthCommand(command[0]);
    const child=spawn(binary, args, {env, stdio:'inherit'});
    child.once('exit',code=>process.exit(code ?? 1));
    child.once('error',error=>{console.error(error.message);process.exit(1);});
    return;
  }
  const adapterPath = resolve(process.argv[2] || join(projectRoot, 'claude-codex/dist/src/adapter.mjs'));
  process.env.CLAUDE_CODEX_HOME = join(runtimeRoot, 'adapter');
  process.env.CLAUDE_CODEX_DISABLE_CODEX_PROXY = '1';
  const runtime = new OpenCodeRuntime({command, env});
  const discoveryCwd = join(runtimeRoot, 'discovery');
  mkdirSync(discoveryCwd, {recursive:true});
  // Lazy discovery avoids a startup model call and lets authentication be completed later.
  let entries = [];
  let catalogAt = 0;
  let discovering;
  const discover = () => discovering ||= runtime.discover(discoveryCwd).then(models => {
    entries=models;
    catalogAt=Date.now();
    process.env.CLAUDE_CODEX_MODELS=JSON.stringify(entries);
    const model=entries.find(e=>e.isDefault) || entries[0];
    if (model) process.env.CLAUDE_CODEX_DEFAULT_MODEL=process.env.CLAUDE_CODEX_SUMMARY_MODEL=model.id;
    return modelListResult(entries);
  }).finally(()=>{discovering=null;});
  const load = name => import(pathToFileURL(join(dirname(adapterPath),name)).href);
  const [{SessionStore},{CodexClaudeAppServer},{startStdioTransport}] = await Promise.all([load('store.mjs'),load('server.mjs'),load('transports.mjs')]);
  const store=new SessionStore(); store.recoverStaleInProgressTurns();
  const server=new CodexClaudeAppServer(store,runtime);
  runtime.onContextUsage=(threadId,usage)=>server.notifyThread(threadId,{method:'yacwu/contextUsage/updated',params:{threadId,...usage}});
  const dispatch=server.dispatch;
  server.dispatch=async function(peer,method,params) {
    if (method === 'model/list') return entries.length && Date.now()-catalogAt < 60_000 ? modelListResult(entries) : discover();
    if (method === 'thread/start' && !entries.length) await discover();
    if (method === 'account/read') return {account:null, requiresOpenaiAuth:false};
    if (method === 'yacwu/opencode/ctx-status') {
      return openCodeThreadStatus(store, params?.threadId, {storageDir: env.MAGIC_CONTEXT_STORAGE_DIR});
    }
    if (method === 'account/rateLimits/read') return openCodeUsageLimits(env.XDG_DATA_HOME);
    if (method === 'thread/compact/start') {
      if (!entries.length) await discover();
      return dispatch.call(this,peer,'turn/start',{threadId:params.threadId,input:[{type:'text',text:'/ctx-wrapup'}]});
    }
    if (method === 'turn/start') {
      if (!entries.length) await discover();
      if (params?.effort) runtime.requestedEffort.set(params.threadId,params.effort);
    }
    if (method === 'thread/delete') {
      const thread=store.getThread(params.threadId);
      if (!thread?.archived) throw new Error('Archive the OpenCode session before deleting it');
      if (thread.claudeSessionId) {
        const shared=store.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE claude_session_id = ? AND id <> ?').get(thread.claudeSessionId,thread.id).n > 0;
        if (!shared) await (await runtime.ready()).request('session/delete',{sessionId:thread.claudeSessionId});
      }
      store.db.exec('BEGIN');
      try {
        store.db.prepare('DELETE FROM turns WHERE thread_id = ?').run(thread.id);
        store.db.prepare('DELETE FROM threads WHERE id = ?').run(thread.id);
        store.db.exec('COMMIT');
      } catch(error) {store.db.exec('ROLLBACK');throw error;}
      server.clearThreadState?.(thread.id);
      return {turns:0,files:[],kept:[],codexSessionId:null};
    }
    return dispatch.call(this,peer,method,params);
  };
  let stopping=false;
  const shutdown=async()=>{if(stopping)return;stopping=true;await server.stop();process.exit(0);};
  for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.once(signal,()=>void shutdown());
  startStdioTransport(server.handle.bind(server),peer=>{server.closePeer(peer);void shutdown();});
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

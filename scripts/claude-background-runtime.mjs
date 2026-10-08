/** Keep the installed adapter's SDK stream open for ordinary background tasks.
 * Applied at launch; the external adapter checkout remains independently updatable.
 * @param {{prototype: Record<string, any>}} Runtime
 */
export function installClaudeBackgroundSupport(Runtime) {
  const proto = Runtime.prototype;
  if (proto.yacwuBackgroundSupport) return;
  for (const method of ['handleSystem', 'handleResult', 'handleAssistant', 'hasPendingWorkflowTasks', 'stopWorkflowTasks']) {
    if (typeof proto[method] !== 'function') throw new Error(`Claude adapter lacks background compatibility method: ${method}`);
  }
  proto.yacwuBackgroundSupport = true;
  const system = proto.handleSystem;
  const assistant = proto.handleAssistant;
  const hasPending = proto.hasPendingWorkflowTasks;
  const stop = proto.stopWorkflowTasks;
  /** @param {any} pending */
  function tasks(pending) { return pending.yacwuBackgroundTasks ??= new Map(); }
  /** @param {any} pending @param {any} task @param {string} status @param {string} summary */
  async function finish(pending, task, status, summary) {
    await pending.handlers.onEvent({ type: 'tool_result', toolUseId: task.itemId, content: summary || `Background worker ${status}.`, isError: status !== 'completed' });
  }
  proto.handleAssistant = async function(pending, message) {
    for (const block of message.message?.content ?? []) {
      if (block.type === 'tool_use' && block.name === 'Monitor' && (block.input?.persistent === false || block.input?.persistent === 'false')) {
        (pending.yacwuFiniteMonitors ??= new Set()).add(block.id);
      }
    }
    return assistant.call(this, pending, message);
  };
  proto.hasPendingWorkflowTasks = function(pending) {
    return tasks(pending).size > 0 || hasPending.call(this, pending);
  };
  proto.handleSystem = async function(pending, message) {
    const id = message.task_id;
    const background = tasks(pending);
    if (message.subtype === 'task_started' && id && message.task_type !== 'local_workflow'
      && ((!message.skip_transcript && !message.ambient) || pending.yacwuFiniteMonitors?.has(message.tool_use_id))
      && message.is_backgrounded !== false && !(message.depth > 1)) {
      if (!background.has(id)) {
        const task = { itemId: `yacwu-background:${id}`, description: message.description || 'Background worker running' };
        background.set(id, task);
        await pending.handlers.onEvent({ type: 'tool_use', toolUseId: task.itemId, toolName: 'YacwuBackgroundWorker', input: { description: task.description } });
      }
    }
    if (message.subtype === 'task_notification' && background.has(id) && ['completed', 'failed', 'stopped'].includes(message.status)) {
      const task = background.get(id);
      background.delete(id);
      await finish(pending, task, message.status, message.summary);
      if (!background.size && pending.deferredResult?.success && !hasPending.call(this, pending)) {
        // The parent already gave its waiting response. Keep this same turn open
        // until it has inspected the completed workers and answered the status request.
        pending.deferredResult = null;
        pending.input.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'The background workers have finished. Check their actual results and report the current task status, including any failures or remaining work. Continue only the work already requested.' }] }, parent_tool_use_id: null, origin: { kind: 'human' } });
      }
    }
    return system.call(this, pending, message);
  };
  proto.stopWorkflowTasks = async function(pending) {
    for (const task of tasks(pending).values()) await finish(pending, task, 'stopped', 'Background worker stopped before its result was received.');
    tasks(pending).clear();
    return stop.call(this, pending);
  };
}

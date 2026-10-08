/** Keep the installed adapter's SDK stream open for ordinary background tasks.
 * Applied at launch; the external adapter checkout remains independently updatable.
 *
 * Also end turns on Claude Code's authoritative turn-over signal: the adapter
 * only completes a turn on a result that echoes every input it fed in, so an
 * input Claude folds in without echoing (a steer, a status request), or a
 * last result answering Claude's own task notification, leaves a finished
 * turn open forever. When Claude reports `session_state_changed: idle` (sent
 * with CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS) and no tracked work remains,
 * the turn completes with its last result after a short grace period that
 * any new input or renewed activity cancels.
 * @param {{prototype: Record<string, any>}} Runtime
 * @param {{idleGraceMs?: number}} [options]
 */
export function installClaudeBackgroundSupport(Runtime, options = {}) {
  const proto = Runtime.prototype;
  if (proto.yacwuBackgroundSupport) return;
  for (const method of ['handleSystem', 'handleResult', 'handleAssistant', 'hasPendingWorkflowTasks', 'stopWorkflowTasks', 'finishDeferredResult', 'steer']) {
    if (typeof proto[method] !== 'function') throw new Error(`Claude adapter lacks background compatibility method: ${method}`);
  }
  proto.yacwuBackgroundSupport = true;
  const system = proto.handleSystem;
  const assistant = proto.handleAssistant;
  const hasPending = proto.hasPendingWorkflowTasks;
  const stop = proto.stopWorkflowTasks;
  const result = proto.handleResult;
  const steer = proto.steer;
  const idleGraceMs = options.idleGraceMs ?? 1500;
  /** Cancel a scheduled idle completion: new input or renewed activity. @param {any} pending */
  function touch(pending) { pending.yacwuIdleSeq = (pending.yacwuIdleSeq ?? 0) + 1; }
  /** @param {any} runtime @param {any} pending */
  async function settleIdle(runtime, pending) {
    if (pending.resolved || tasks(pending).size > 0 || hasPending.call(runtime, pending)) return;
    const last = pending.yacwuLastResult;
    if (!last) return;
    if (!pending.deferredResult) {
      pending.deferredResult = {
        success: last.subtype === 'success' && !last.is_error && pending.workflowFailure == null,
        resultText: pending.workflowFailure ?? (last.result == null ? null : String(last.result)),
        claudeSessionId: last.session_id == null ? null : String(last.session_id)
      };
    }
    await runtime.finishDeferredResult(pending, true);
  }
  proto.handleResult = async function(pending, message) {
    pending.yacwuLastResult = message;
    return result.call(this, pending, message);
  };
  proto.steer = async function(threadId, prompt) {
    for (const pending of this.turns.values()) if (pending.context.threadId === threadId) touch(pending);
    return steer.call(this, threadId, prompt);
  };
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
    if (message.subtype === 'session_state_changed') {
      touch(pending);
      if (message.state === 'idle') {
        const seq = pending.yacwuIdleSeq;
        setTimeout(() => {
          if (pending.yacwuIdleSeq === seq) settleIdle(this, pending).catch(() => {});
        }, idleGraceMs);
      }
    }
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
        touch(pending);
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

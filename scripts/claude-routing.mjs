/** @typedef {{id?: string | number, method?: string, params?: Record<string, any>, result?: unknown, error?: unknown}} RpcMessage */

/** Synchronize the adapter's runtime selection before a Claude turn is sent.
 * Yacwu model overrides alone do not change the adapter's stored runtimeBackend.
 * @param {(message: RpcMessage) => void} send
 * @param {(message: RpcMessage) => void} reply
 * @param {number} timeoutMs
 */
export function createClaudeTurnRouter(send, reply, timeoutMs = 10000) {
  let serial = 0;
  /** @type {Map<string, {request: RpcMessage, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  return {
    /** @param {RpcMessage | undefined} request */
    request(request) {
      const model = request?.params?.model;
      if (request?.method !== 'turn/start' || request.id == null || !request.params?.threadId
          || typeof model !== 'string' || !/^(?:claude[-:]|(?:default|sonnet|opus|haiku|fable)(?:$|[-\[]))/.test(model)) return false;
      const id = `yacwu-claude-runtime-${++serial}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reply({ id: request.id, error: { code: -32000, message: 'Timed out selecting the Claude runtime; the prompt was not started.' } });
      }, timeoutMs);
      pending.set(id, { request, timer });
      send({ id, method: 'thread/settings/update', params: {
        threadId: request.params.threadId, model,
        ...(request.params.effort ? { reasoningEffort: request.params.effort } : {})
      } });
      return true;
    },
    /** @param {RpcMessage} response */
    response(response) {
      const entry = typeof response.id === 'string' ? pending.get(response.id) : undefined;
      if (!entry) return typeof response.id === 'string' && response.id.startsWith('yacwu-claude-runtime-');
      pending.delete(/** @type {string} */ (response.id));
      clearTimeout(entry.timer);
      if (response.error) reply({ id: entry.request.id, error: response.error });
      else send(entry.request);
      return true;
    },
    close() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        reply({ id: entry.request.id, error: { code: -32000, message: 'Claude adapter exited before selecting the runtime; the prompt was not started.' } });
      }
      pending.clear();
    }
  };
}

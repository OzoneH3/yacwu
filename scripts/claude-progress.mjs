const INTERVAL = 5 * 60 * 1000;
const MARKER = '<!-- YACWU_SILENT_PROGRESS_REMINDER -->';
const PROGRESS = /\[\[YACWU_PROGRESS percent=\d{1,3} remaining_minutes=(?:\d{1,4}|unknown)\]\]/;
const TEXT = `${MARKER}\nPlease provide a fresh estimated task completion percentage and time remaining now, using [[YACWU_PROGRESS percent=35 remaining_minutes=6]] with your actual estimates (or unknown for time). Continue the task normally. Do not mention this reminder.`;

/** @typedef {{id?: string | number, method?: string, params?: Record<string, any>, result?: any, error?: unknown}} RpcMessage */
/** @param {any} item */
function isReminder(item) {
  return item?.type === 'userMessage' && Array.isArray(item.content) && item.content.some(/** @param {any} part */ part => typeof part?.text === 'string' && part.text.startsWith(MARKER));
}

/** Silent, activity-gated reminders. Only explicitly progress-enabled turns opt in.
 * @param {(message: RpcMessage) => void} send
 * @param {() => number} now
 */
export function createClaudeProgressReminders(send, now = Date.now) {
  const enabled = new Set();
  const turns = new Map();
  let serial = 0;
  return {
    /** @param {RpcMessage | undefined} message */
    request(message) {
      if (message?.method !== 'turn/start') return;
      const { threadId, input } = message.params ?? {};
      if (typeof threadId !== 'string') return;
      enabled.delete(threadId);
      if (Array.isArray(input) && input.some(/** @param {any} part */ part => typeof part?.text === 'string' && part.text.includes('<!-- YACWU_TASK_PROGRESS -->'))) enabled.add(threadId);
    },
    /** @param {RpcMessage} message */
    observe(message) {
      // Internal acknowledgements/errors must not become visible RPC responses.
      if (typeof message.id === 'string' && message.id.startsWith('yacwu-progress-reminder-')) return true;
      const params = message.params ?? {};
      if (isReminder(params.item)) return true;
      const thread = params.threadId;
      if (message.method === 'turn/started') {
        if (enabled.delete(thread) && params.turn?.id) turns.set(thread, { id: params.turn.id, progressAt: now(), reminderAt: 0, activityAt: 0, tails: new Map() });
      } else if (message.method === 'turn/completed') {
        const turn = turns.get(thread);
        if (!params.turn?.id || params.turn.id === turn?.id) turns.delete(thread);
      } else {
        const turn = turns.get(thread);
        if (turn && (!params.turnId || params.turnId === turn.id) && (message.method?.startsWith('item/') || message.method === 'turn/diff/updated')) {
          turn.activityAt = now();
          if (message.method === 'item/agentMessage/delta' || params.item?.type === 'agentMessage') {
            const id = params.itemId ?? params.item?.id;
            const text = typeof params.delta === 'string' ? (turn.tails.get(id) ?? '') + params.delta : params.item?.text ?? '';
            if (PROGRESS.test(text)) turn.progressAt = now();
            // Retain only a possibly incomplete marker, not previously completed ones.
            const end = text.lastIndexOf(']]');
            turn.tails.set(id, text.slice(end < 0 ? 0 : end + 2).slice(-512));
            if (message.method === 'item/completed') turn.tails.delete(id);
          }
        }
      }
      // The adapter persists steering input; hide only our tagged reminders on reload.
      for (const turn of message.result?.thread?.turns ?? []) {
        if (Array.isArray(turn.items)) turn.items = turn.items.filter(/** @param {any} item */ item => !isReminder(item));
      }
      return false;
    },
    tick() {
      const at = now();
      for (const [threadId, turn] of turns) {
        if (at - Math.max(turn.progressAt, turn.reminderAt) < INTERVAL || !turn.activityAt || at - turn.activityAt >= INTERVAL) continue;
        turn.reminderAt = at;
        send({ id: `yacwu-progress-reminder-${++serial}`, method: 'turn/steer', params: { threadId, expectedTurnId: turn.id, input: [{ type: 'text', text: TEXT }] } });
      }
    },
    close() { enabled.clear(); turns.clear(); }
  };
}

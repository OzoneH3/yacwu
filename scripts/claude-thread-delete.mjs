import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

// claude-codex can archive a thread but not delete it. Yacwu adds
// `thread/delete` at runtime, inside the adapter process so the adapter's own
// database connection does the writing. Only archived threads can be
// deleted. A thread's history lives in three places:
// - the adapter database (thread row and every turn's items),
// - Claude Code's files under ~/.claude, keyed by the Claude conversation id,
// - for threads the adapter ran on its Codex runtime, a Codex session, which
//   the caller deletes through Codex itself (its id is returned).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Conversation ids become path segments; anything else is refused. */
export function isConversationId(value) {
  return typeof value === 'string' && UUID.test(value);
}

/** The path, if it lies strictly inside `root`. */
function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? resolve(path) : null;
}

const exists = (path) => stat(path).then(() => true, () => false);

/**
 * Every Claude Code file of one conversation: its transcript and subagent
 * folder in any project directory (folder moves leave copies), its file
 * history and session environment.
 * @param {string} configRoot e.g. ~/.claude
 * @param {string} conversationId
 */
export async function claudeConversationPaths(configRoot, conversationId) {
  if (!isConversationId(conversationId)) throw new Error(`refusing to delete files for conversation id ${JSON.stringify(conversationId)}`);
  const candidates = [];
  const projects = join(configRoot, 'projects');
  const projectDirs = await readdir(projects, { withFileTypes: true }).catch(() => []);
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    candidates.push(join(projects, entry.name, `${conversationId}.jsonl`), join(projects, entry.name, conversationId));
  }
  candidates.push(join(configRoot, 'file-history', conversationId), join(configRoot, 'session-env', conversationId));
  const found = [];
  for (const candidate of candidates) {
    const safe = inside(configRoot, candidate);
    if (safe && await exists(safe)) found.push(safe);
  }
  return found;
}

/**
 * Delete an archived thread: Claude files first (when no other thread shares
 * the conversation), then the database rows in one transaction.
 * @param {{ store: any, configRoot: string, threadId: string }} options
 */
export async function deleteArchivedThread({ store, configRoot, threadId }) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error(`unknown thread: ${threadId}`);
  if (!thread.archived) throw new Error('thread is not archived; archive it before deleting');
  const codexSessionId = thread.runtimeBackend === 'codex' ? (thread.codexSessionId ?? thread.claudeSessionId ?? null) : null;
  const conversationId = thread.runtimeBackend === 'codex' ? null : thread.claudeSessionId;
  const removed = [];
  const kept = [];
  if (conversationId) {
    // A side conversation can share its parent's Claude conversation.
    const shared = store.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE claude_session_id = ? AND id <> ?').get(conversationId, threadId).n > 0;
    if (shared) kept.push(`Claude conversation ${conversationId} (still used by another session)`);
    else {
      for (const path of await claudeConversationPaths(configRoot, conversationId)) {
        await rm(path, { recursive: true, force: true });
        removed.push(path);
      }
    }
  }
  store.db.exec('BEGIN');
  try {
    const turns = store.db.prepare('DELETE FROM turns WHERE thread_id = ?').run(threadId).changes;
    store.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
    store.db.exec('COMMIT');
    return { turns: Number(turns), files: removed, kept, codexSessionId };
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

/** Add `thread/delete` to the adapter's app server. */
export function installThreadDelete(ServerClass, configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  const dispatch = ServerClass.prototype.dispatch;
  ServerClass.prototype.dispatch = async function (peer, method, params) {
    if (method !== 'thread/delete') return dispatch.call(this, peer, method, params);
    const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
    const result = await deleteArchivedThread({ store: this.store, configRoot, threadId });
    this.clearThreadState?.(threadId);
    return result;
  };
}

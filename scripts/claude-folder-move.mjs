import { constants } from 'node:fs';
import { copyFile, cp, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code's project directory name for a folder (as claude-codex resolves it).
 * @param {string} dir
 */
export function claudeProjectSlug(dir) {
  return dir.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * The adapter's own record of a thread: its current folder and Claude
 * conversation. Read-only; the adapter owns this database.
 * @param {string} databasePath
 * @returns {(threadId: string) => {cwd: string, claudeSessionId: string | null} | null}
 */
export function adapterThreadLookup(databasePath) {
  return (threadId) => {
    let db;
    try {
      // Loaded lazily: older Node versions without node:sqlite only lose folder moves.
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      db = new DatabaseSync(databasePath, { readOnly: true });
      const row = db.prepare('SELECT cwd, claude_session_id FROM threads WHERE id = ?').get(threadId);
      return row ? { cwd: String(row.cwd), claudeSessionId: row.claude_session_id ? String(row.claude_session_id) : null } : null;
    } finally {
      db?.close();
    }
  };
}

/** @param {string} path */
const exists = (path) => stat(path).then(() => true, () => false);

/**
 * claude-codex resumes a Claude conversation only from the project directory
 * of the thread's current folder. Before a turn/start moves a thread to
 * another folder, copy the conversation (and its subagent transcripts) there
 * so the resumed session keeps its history. The original stays in place;
 * nothing at the destination is overwritten.
 * @param {{params?: Record<string, any>}} request
 * @param {{lookup: ReturnType<typeof adapterThreadLookup>, configRoot?: string}} options
 * @returns {Promise<'unchanged' | 'no-conversation' | 'copied' | 'present'>}
 */
export async function carryClaudeConversation(request, { lookup, configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') }) {
  const { threadId, cwd } = request.params ?? {};
  if (typeof threadId !== 'string' || typeof cwd !== 'string' || !cwd) return 'unchanged';
  const thread = lookup(threadId);
  if (!thread || thread.cwd === cwd) return 'unchanged';
  if (!thread.claudeSessionId) return 'no-conversation';
  const projects = join(configRoot, 'projects');
  const source = join(projects, claudeProjectSlug(thread.cwd));
  const target = join(projects, claudeProjectSlug(cwd));
  const file = `${thread.claudeSessionId}.jsonl`;
  if (!await exists(join(source, file))) return 'no-conversation';
  if (await exists(join(target, file))) return 'present';
  await mkdir(target, { recursive: true });
  // Subagent transcripts first, so a resumable conversation never lacks them.
  if (await exists(join(source, thread.claudeSessionId))) {
    await cp(join(source, thread.claudeSessionId), join(target, thread.claudeSessionId), { recursive: true, force: false, errorOnExist: false });
  }
  await copyFile(join(source, file), join(target, file), constants.COPYFILE_EXCL);
  return 'copied';
}

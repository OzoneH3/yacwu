import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterThreadLookup, carryClaudeConversation, claudeProjectSlug } from '../../scripts/claude-folder-move.mjs';

const adapterBuilt = existsSync(new URL('../../claude-codex/dist/src/native-runtime.mjs', import.meta.url));

const SESSION = '4f6c2a10-0000-4000-8000-000000000001';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'yacwu-folder-move-'));
  const configRoot = join(root, 'claude');
  const oldCwd = join(root, 'old project');
  const newCwd = join(root, 'new-project');
  mkdirSync(oldCwd); mkdirSync(newCwd);
  const source = join(configRoot, 'projects', claudeProjectSlug(oldCwd));
  mkdirSync(join(source, SESSION, 'subagents'), { recursive: true });
  writeFileSync(join(source, `${SESSION}.jsonl`), '{"history":true}\n');
  writeFileSync(join(source, SESSION, 'subagents', 'agent-1.jsonl'), '{"agent":true}\n');
  const threads = { thread: { cwd: oldCwd, claudeSessionId: SESSION } };
  return { root, configRoot, oldCwd, newCwd, source, lookup: (id) => threads[id] ?? null, threads };
}

const target = (f) => join(f.configRoot, 'projects', claudeProjectSlug(f.newCwd));

test('a folder move copies the conversation and its subagents, keeping the original', async () => {
  const f = fixture();
  const moved = await carryClaudeConversation({ params: { threadId: 'thread', cwd: f.newCwd } }, { lookup: f.lookup, configRoot: f.configRoot });
  assert.equal(moved, 'copied');
  assert.equal(readFileSync(join(target(f), `${SESSION}.jsonl`), 'utf8'), '{"history":true}\n');
  assert.equal(readFileSync(join(target(f), SESSION, 'subagents', 'agent-1.jsonl'), 'utf8'), '{"agent":true}\n');
  assert.ok(existsSync(join(f.source, `${SESSION}.jsonl`)));
});

test('nothing is copied without a move, a conversation, or when the destination has one', async () => {
  const f = fixture();
  const carry = (params) => carryClaudeConversation({ params }, { lookup: f.lookup, configRoot: f.configRoot });
  assert.equal(await carry({ threadId: 'thread', cwd: f.oldCwd }), 'unchanged');
  assert.equal(await carry({ threadId: 'thread' }), 'unchanged');
  assert.equal(await carry({ threadId: 'unknown', cwd: f.newCwd }), 'unchanged');
  f.threads.fresh = { cwd: f.oldCwd, claudeSessionId: null };
  assert.equal(await carry({ threadId: 'fresh', cwd: f.newCwd }), 'no-conversation');
  mkdirSync(target(f), { recursive: true });
  writeFileSync(join(target(f), `${SESSION}.jsonl`), '{"newer":true}\n');
  assert.equal(await carry({ threadId: 'thread', cwd: f.newCwd }), 'present');
  assert.equal(readFileSync(join(target(f), `${SESSION}.jsonl`), 'utf8'), '{"newer":true}\n');
});

test('the adapter database supplies the folder and conversation, read-only', () => {
  const f = fixture();
  const path = join(f.root, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, claude_session_id TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread', f.oldCwd, SESSION);
  db.close();
  const lookup = adapterThreadLookup(path);
  assert.deepEqual(lookup('thread'), { cwd: f.oldCwd, claudeSessionId: SESSION });
  assert.equal(lookup('missing'), null);
});

test('the adapter resumes the carried conversation from the new folder', { skip: adapterBuilt ? false : 'Claude adapter checkout is not built' }, async () => {
  const f = fixture();
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = f.configRoot;
  try {
    const { sdkResumeSessionId } = await import('../../claude-codex/dist/src/native-runtime.mjs');
    assert.equal(sdkResumeSessionId(SESSION, f.newCwd), null, 'before the move the new folder has no conversation');
    await carryClaudeConversation({ params: { threadId: 'thread', cwd: f.newCwd } }, { lookup: f.lookup, configRoot: f.configRoot });
    assert.equal(sdkResumeSessionId(SESSION, f.newCwd), SESSION);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

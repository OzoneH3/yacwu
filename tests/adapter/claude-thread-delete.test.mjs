import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConversationPaths, deleteArchivedThread, isConversationId } from '../../scripts/claude-thread-delete.mjs';
import { claudeProjectSlug } from '../../scripts/claude-folder-move.mjs';

const adapterBuilt = existsSync(new URL('../../claude-codex/dist/src/store.mjs', import.meta.url));
const { SessionStore } = adapterBuilt ? await import('../../claude-codex/dist/src/store.mjs') : {};
const options = { skip: adapterBuilt ? false : 'Claude adapter checkout is not built' };

const CONVERSATION = '0b1c2d3e-0000-4000-8000-00000000000a';
const OTHER = '0b1c2d3e-0000-4000-8000-00000000000b';

function thread(id, fields = {}) {
  return {
    id, sessionId: id, forkedFromId: null, preview: 'p', name: id, archived: false, cwd: '/home/u/project', model: 'opus',
    reasoningEffort: 'high', modelProvider: 'anthropic', claudeSessionId: null, source: 'appServer', createdAt: 1, updatedAt: 1,
    status: { type: 'idle' }, approvalPolicy: 'never', sandboxMode: 'danger-full-access', ephemeral: false, threadSource: null,
    agentRole: null, agentNickname: null, baseInstructions: null, developerInstructions: null, personality: null,
    runtimeBackend: 'claude', codexSessionId: null, ...fields
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'yacwu-thread-delete-'));
  const configRoot = join(root, 'claude');
  const store = new SessionStore(join(root, 'state.sqlite'));
  const touch = (path) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'x'); };
  const project = join(configRoot, 'projects', claudeProjectSlug('/home/u/project'));
  const moved = join(configRoot, 'projects', claudeProjectSlug('/home/u/moved'));
  for (const id of [CONVERSATION, OTHER]) {
    touch(join(project, `${id}.jsonl`));
    touch(join(project, id, 'subagents', 'agent-1.jsonl'));
  }
  touch(join(moved, `${CONVERSATION}.jsonl`));
  touch(join(configRoot, 'file-history', CONVERSATION, 'v1'));
  touch(join(configRoot, 'session-env', CONVERSATION, 'env'));
  touch(join(configRoot, 'file-history', OTHER, 'v1'));
  return { root, configRoot, store, project };
}

const listing = (dir) => readdirSync(dir).sort();

test('only well-formed conversation ids become paths', async () => {
  for (const bad of ['', null, '..', '../projects', `${CONVERSATION}/..`, '*']) assert.equal(isConversationId(bad), false);
  await assert.rejects(claudeConversationPaths('/tmp/none', ''), /refusing/);
  assert.equal(isConversationId(CONVERSATION), true);
});

test('deleting an archived thread removes its rows and every file of its conversation', options, async () => {
  const f = fixture();
  f.store.upsertThread(thread('t1', { claudeSessionId: CONVERSATION, archived: true }));
  f.store.upsertThread(thread('t2', { claudeSessionId: OTHER, archived: true }));
  f.store.upsertTurn({ id: 'turn-1', threadId: 't1', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1, items: [{ type: 'agentMessage', text: 'secret' }], diff: '', error: null });
  const result = await deleteArchivedThread({ store: f.store, configRoot: f.configRoot, threadId: 't1' });
  assert.equal(result.turns, 1);
  assert.equal(result.files.length, 5);
  assert.equal(result.codexSessionId, null);
  assert.equal(f.store.getThread('t1'), null);
  assert.equal(f.store.listTurns('t1').length, 0);
  // Everything else is untouched.
  assert.ok(f.store.getThread('t2'));
  assert.deepEqual(listing(f.project), [OTHER, `${OTHER}.jsonl`]);
  assert.deepEqual(listing(join(f.configRoot, 'file-history')), [OTHER]);
  assert.deepEqual(listing(join(f.configRoot, 'session-env')), []);
});

test('a live thread is refused, and a shared conversation keeps its files', options, async () => {
  const f = fixture();
  f.store.upsertThread(thread('live', { claudeSessionId: CONVERSATION }));
  await assert.rejects(deleteArchivedThread({ store: f.store, configRoot: f.configRoot, threadId: 'live' }), /not archived/);
  await assert.rejects(deleteArchivedThread({ store: f.store, configRoot: f.configRoot, threadId: 'missing' }), /unknown thread/);
  f.store.upsertThread(thread('side', { claudeSessionId: CONVERSATION, archived: true, forkedFromId: 'live' }));
  const result = await deleteArchivedThread({ store: f.store, configRoot: f.configRoot, threadId: 'side' });
  assert.deepEqual(result.files, []);
  assert.match(result.kept[0], /still used by another session/);
  assert.ok(existsSync(join(f.project, `${CONVERSATION}.jsonl`)));
  assert.equal(f.store.getThread('side'), null);
});

test('Codex-runtime and conversation-less threads touch no Claude files', options, async () => {
  const f = fixture();
  f.store.upsertThread(thread('codex', { runtimeBackend: 'codex', claudeSessionId: CONVERSATION, codexSessionId: CONVERSATION, archived: true }));
  f.store.upsertThread(thread('empty', { archived: true }));
  const codex = await deleteArchivedThread({ store: f.store, configRoot: f.configRoot, threadId: 'codex' });
  assert.equal(codex.codexSessionId, CONVERSATION);
  assert.deepEqual(codex.files, []);
  const empty = await deleteArchivedThread({ store: f.store, configRoot: f.configRoot, threadId: 'empty' });
  assert.deepEqual(empty.files, []);
  // The whole file-history folder survives a thread without a conversation id.
  assert.deepEqual(listing(join(f.configRoot, 'file-history')), [CONVERSATION, OTHER]);
});

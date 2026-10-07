import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('rollout recovery is evidence-based, metadata-only, dry-run by default and idempotent', () => {
	const dir = mkdtempSync(join(tmpdir(), 'yacwu-usage-recovery-'));
	try {
		const usage = join(dir, 'usage'), codex = join(dir, 'codex'), sessions = join(codex, 'sessions');
		mkdirSync(usage); mkdirSync(sessions, { recursive: true });
		const at = Date.now(), log = join(usage, 'usage-1.jsonl');
		const events = [
			{ at, host: 'local', event: 'quota', usedPercent: 10, resetsAt: 1000 },
			{ at: at + 1, host: 'local', event: 'turn/started', threadId: 'child', turnId: 'turn' },
			{ at: at + 2, host: 'local', event: 'tokens', threadId: 'child', turnId: 'turn', total: { totalTokens: 100 } }
		];
		writeFileSync(log, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
		const rollout = [
			{ timestamp: new Date(at + 1).toISOString(), type: 'session_meta', payload: { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } },
			{ type: 'turn_context', payload: { turn_id: 'turn', model: 'model', effort: 'medium', developer_instructions: 'private instructions' } },
			{ type: 'response_item', payload: { text: 'private response' } },
			{ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { total_tokens: 100 } } } }
		];
		writeFileSync(join(sessions, 'rollout-child.jsonl'), rollout.map((event) => JSON.stringify(event)).join('\n'));
		const args = ['bun', 'scripts/recover-usage.ts', '--usage-dir', usage, '--codex-home', codex];
		const run = (apply: boolean) => {
			const process = Bun.spawnSync([...args, ...(apply ? ['--apply'] : [])]);
			expect(process.exitCode).toBe(0);
			return JSON.parse(process.stdout.toString());
		};
		expect(run(false).repairs).toHaveLength(1);
		expect(readFileSync(log, 'utf8')).not.toContain('spawnedThread');
		expect(run(true).repairs).toHaveLength(1);
		const recovered = readFileSync(log, 'utf8');
		expect(recovered).toContain('spawnedThread');
		expect(recovered).not.toContain('private');
		expect(run(true).repairs).toHaveLength(0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

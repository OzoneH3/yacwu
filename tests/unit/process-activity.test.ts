import { expect, test } from 'bun:test';
import { workerSummary } from '../../src/lib/process-activity';

const proc = (pid: number, command: string, cpuCentiseconds: number, elapsedSeconds = 60) => ({ pid, ppid: 1, command, elapsedSeconds, cpuCentiseconds });
const claude = proc(1, '/x/claude-agent-sdk-linux-x64/claude --output-format stream-json', 500);
const shell = proc(2, '/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot.sh && make', 0);

test('names the busiest worker processes with their CPU use', () => {
	const before = { at: 0, processes: [claude, shell, proc(3, 'make -j1 release-check', 10), proc(4, '/tmp/go-build/b334/api.test', 1000)] };
	const after = { at: 10_000, processes: [claude, shell, proc(3, 'make -j1 release-check', 10), proc(4, '/tmp/go-build/b334/api.test', 1200)] };
	expect(workerSummary(before, after)).toBe('api.test 20% CPU, make 0% CPU');
	expect(workerSummary(null, after)).toBe('make, api.test');
});

test('says when nothing but the session itself is running, and claims nothing untagged', () => {
	expect(workerSummary(null, { at: 0, processes: [claude, shell] })).toBe('no worker process running');
	expect(workerSummary(null, { at: 0, processes: [] })).toBeNull();
});

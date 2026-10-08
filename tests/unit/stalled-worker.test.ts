import { expect, test } from 'bun:test';
import { clearsStalledWorkerPrompt } from '../../src/lib/stalled-worker';

test('new worker activity or termination clears waiting actions', () => {
	for (const method of ['item/started', 'item/completed', 'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'turn/diff/updated', 'turn/started', 'turn/completed', 'turn/error']) expect(clearsStalledWorkerPrompt(method)).toBe(true);
});

test('polls, diagnostics and metadata are not new worker activity', () => {
	for (const method of ['yacwu/diagnostic/stalled', 'yacwu/host/status', 'thread/tokenUsage/updated', 'thread/status/changed', 'account/rateLimits/updated']) expect(clearsStalledWorkerPrompt(method)).toBe(false);
});

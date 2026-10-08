import { expect, test } from 'bun:test';
import { createClaudeTurnRouter } from '../../scripts/claude-routing.mjs';

test('Claude suggestions synchronize the adapter runtime before sending the original prompt', () => {
	const sent: any[] = [], replies: any[] = [];
	const router = createClaudeTurnRouter((message) => sent.push(message), (message) => replies.push(message));
	const request = { id: 12, method: 'turn/start', params: { threadId: 'old-codex-backed-adapter-thread', model: 'claude-sonnet-5-5', effort: 'medium', input: [{ type: 'text', text: 'Do work' }] } };
	expect(router.request(request)).toBe(true);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({ method: 'thread/settings/update', params: { threadId: request.params.threadId, model: 'claude-sonnet-5-5', reasoningEffort: 'medium' } });
	expect(router.response({ id: sent[0].id, result: {} })).toBe(true);
	expect(sent[1]).toEqual(request);
	expect(replies).toEqual([]);
	router.close();
});

test('failed runtime selection blocks the prompt and unrelated RPCs are not intercepted', () => {
	const sent: any[] = [], replies: any[] = [];
	const router = createClaudeTurnRouter((message) => sent.push(message), (message) => replies.push(message));
	expect(router.request({ id: 1, method: 'turn/steer', params: { model: 'sonnet' } })).toBe(false);
	expect(router.request({ id: 2, method: 'turn/start', params: { threadId: 't', model: 'gpt-6.1-sol' } })).toBe(false);
	router.request({ id: 3, method: 'turn/start', params: { threadId: 't', model: 'sonnet' } });
	const error = { code: -1, message: 'cannot update' };
	router.response({ id: sent[0].id, error });
	expect(sent).toHaveLength(1);
	expect(replies).toEqual([{ id: 3, error }]);
	router.close();
});

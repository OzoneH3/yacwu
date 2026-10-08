import { expect, test } from 'bun:test';
import { createClaudeProgressReminders } from '../../scripts/claude-progress.mjs';

function setup(enabled = true) {
	let time = 1000;
	const sent: any[] = [];
	const reminders = createClaudeProgressReminders((m: any) => sent.push(m), () => time);
	reminders.request({ method: 'turn/start', params: { threadId: 't', input: [{ type: 'text', text: enabled ? '<!-- YACWU_TASK_PROGRESS -->' : 'ordinary prompt' }] } });
	reminders.observe({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn' } } });
	const activity = () => reminders.observe({ method: 'item/started', params: { threadId: 't', turnId: 'turn', item: { id: 'tool', type: 'mcpToolCall' } } });
	return { reminders, sent, activity, at: (value: number) => { time = value; } };
}

test('reminders require five minutes without progress plus recent activity and are rate limited', () => {
	const s = setup();
	s.at(300000); s.activity(); s.reminders.tick(); expect(s.sent).toHaveLength(0);
	s.at(301000); s.reminders.tick(); expect(s.sent).toHaveLength(1);
	expect(s.sent[0]).toMatchObject({ method: 'turn/steer', params: { threadId: 't', expectedTurnId: 'turn' } });
	s.at(400000); s.activity(); s.reminders.tick(); expect(s.sent).toHaveLength(1);
	s.at(601000); s.activity(); s.reminders.tick(); expect(s.sent).toHaveLength(2);
});

test('idle workers, completed turns and progress-disabled prompts receive no reminders', () => {
	for (const enabled of [true, false]) {
		const s = setup(enabled);
		s.activity(); s.at(301000); s.reminders.tick(); expect(s.sent).toHaveLength(0);
		s.activity();
		if (enabled) s.reminders.observe({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn' } } });
		s.reminders.tick(); expect(s.sent).toHaveLength(0);
	}
});

test('split progress markers postpone reminders but ordinary commentary does not', () => {
	const s = setup();
	const delta = (text: string) => s.reminders.observe({ method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'message', delta: text } });
	s.at(200000); delta('[[YACWU_PROGRESS percent=40 '); delta('remaining_minutes=unknown]]');
	s.at(301000); delta('Continuing to work'); s.reminders.tick(); expect(s.sent).toHaveLength(0);
	s.at(500000); delta('Still working'); s.reminders.tick(); expect(s.sent).toHaveLength(1);
});

test('internal replies and persisted reminder text are hidden without hiding real messages', () => {
	const s = setup(); s.at(301000); s.activity(); s.reminders.tick();
	expect(s.reminders.observe({ id: s.sent[0].id, error: { message: 'rejected' } })).toBe(true);
	const hidden = { type: 'userMessage', content: s.sent[0].params.input };
	const visible = { type: 'userMessage', content: [{ type: 'text', text: 'Actual user input' }] };
	const reply = { result: { thread: { turns: [{ items: [hidden, visible] }] } } };
	s.reminders.observe(reply);
	expect(reply.result.thread.turns[0].items).toEqual([visible]);
	expect(s.reminders.observe({ method: 'item/started', params: { item: hidden } })).toBe(true);
	s.reminders.close(); s.at(901000); s.reminders.tick(); expect(s.sent).toHaveLength(1);
});

import { expect, test } from 'bun:test';
import { unconfirmedEchoes } from '../../src/lib/user-echoes';

const user = (text: string) => ({ type: 'userMessage', content: [{ type: 'text', text }] });

test('reloaded history confirms sent messages, including ones carrying hidden instructions', () => {
	const echoes = [{ id: 'local-user-1', text: 'do one trial run' }, { id: 'local-user-2', text: 'still on its way' }];
	const history = [user('older'), user('do one trial run\n\n<!-- YACWU_TASK_PROGRESS -->\nProgress reporting is required.\n[/YACWU_TASK_PROGRESS]'), { type: 'agentMessage', text: 'done' }];
	expect(unconfirmedEchoes(echoes, history)).toEqual([{ id: 'local-user-2', text: 'still on its way' }]);
	expect(unconfirmedEchoes(echoes, [])).toEqual(echoes);
});

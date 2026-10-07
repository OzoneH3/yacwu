import { expect, test } from 'bun:test';
import { replaceSessionWithEmptyThread } from '../../src/lib/session-clear';

test('clearing prepares an empty replacement before archiving the original', async () => {
	const calls: string[] = [];
	const result = await replaceSessionWithEmptyThread({
		assertIdle: async () => { calls.push('idle'); },
		create: async () => { calls.push('create'); return { thread: { id: 'new' } }; },
		configure: async (id) => { calls.push(`configure:${id}`); },
		archive: async () => { calls.push('archive'); }
	});
	expect(result.thread.id).toBe('new');
	expect(calls).toEqual(['idle', 'create', 'configure:new', 'idle', 'archive']);
});

test('configuration failure or a newly started worker leaves original history unarchived', async () => {
	for (const failAt of ['configure', 'second-idle']) {
		let checks = 0, archived = false;
		await expect(replaceSessionWithEmptyThread({
			assertIdle: async () => { if (++checks === 2 && failAt === 'second-idle') throw new Error('worker started'); },
			create: async () => ({ thread: { id: 'new' } }),
			configure: async () => { if (failAt === 'configure') throw new Error('configuration failed'); },
			archive: async () => { archived = true; }
		})).rejects.toThrow();
		expect(archived).toBe(false);
	}
});

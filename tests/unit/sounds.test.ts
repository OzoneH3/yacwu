import { expect, test } from 'bun:test';
import { createSoundPlayer, SESSION_COOLDOWN_MS, signalSounds } from '../../src/lib/sounds';

test('only a newly appeared question or error in a live session makes a sound', () => {
	const live = (id: string) => id !== 'loaded';
	expect(signalSounds({}, { a: 'question', b: null, loaded: 'question' }, live)).toEqual([['a', 'question']]);
	expect(signalSounds({ a: 'question' }, { a: 'question' }, live)).toEqual([]);
	expect(signalSounds({ a: 'question' }, { a: 'error' }, live)).toEqual([['a', 'error']]);
	expect(signalSounds({ a: 'error' }, { a: null }, live)).toEqual([]);
});

test('one sound per session at a time, so a question covers its "finished"', () => {
	const player = createSoundPlayer(() => null);
	expect(player.play('question', 's1', 1_000)).toBe(true);
	expect(player.play('finish', 's1', 1_300)).toBe(false);
	expect(player.play('finish', 's2', 1_300)).toBe(true);
	expect(player.play('finish', 's1', 1_000 + SESSION_COOLDOWN_MS)).toBe(true);
});

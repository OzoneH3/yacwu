import { expect, test } from 'bun:test';
import { createSoundPlayer, SESSION_COOLDOWN_MS, signalSounds, volumeGain } from '../../src/lib/sounds';

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

function fakeContext() {
	const peaks: number[] = [];
	const context = {
		state: 'running', currentTime: 0, destination: {},
		createOscillator: () => ({ type: '', frequency: { value: 0 }, connect: (node: unknown) => node, start() {}, stop() {} }),
		createGain: () => {
			const ramps: number[] = [];
			return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime: (value: number) => { ramps.push(value); if (ramps.length === 1) peaks.push(value); } }, connect: (node: unknown) => node };
		},
		resume: () => Promise.resolve()
	};
	return { peaks, context: context as unknown as AudioContext };
}

test('volume scales every note; 25 is the original level, 50 the louder default', () => {
	const { peaks, context } = fakeContext();
	const player = createSoundPlayer(() => context);
	player.play('finish', 'a', 1_000, 25);
	player.play('finish', 'b', 1_000, 50);
	player.play('finish', 'c', 1_000, 0);
	expect(peaks.map((peak) => Number(peak.toFixed(3)))).toEqual([0.12, 0.12, 0.24, 0.24]);
	// A preview plays even right after the session cooldown started.
	player.preview(100);
	expect(peaks.slice(-2).map((peak) => Number(peak.toFixed(3)))).toEqual([0.48, 0.48]);
	expect(volumeGain(150)).toBe(4);
});

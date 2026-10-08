import { expect, test } from 'bun:test';
import { settleTranscriptBottom } from '../../src/lib/transcript-scroll';

test('bottom jump follows multiple virtual row measurements rather than stopping after two frames', async () => {
	let height = 1000, top = 0, frames = 0;
	const viewport = { get scrollHeight() { return height; }, get scrollTop() { return top; }, set scrollTop(value) { top = Math.min(value, height - 200); }, clientHeight: 200 };
	await settleTranscriptBottom(viewport, { flush: async () => {}, update: () => {}, cancelled: () => false,
		atEnd: () => frames > 4, frame: async () => { if (++frames <= 4) height += 500; } });
	expect(top).toBe(height - 200);
	expect(frames).toBeGreaterThan(4);
});

test('manual interaction cancels settling without pulling the reader back down', async () => {
	let cancelled = false;
	const viewport = { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 };
	await settleTranscriptBottom(viewport, { flush: async () => {}, update: () => {}, atEnd: () => true,
		cancelled: () => cancelled, frame: async () => { viewport.scrollTop = 100; cancelled = true; } });
	expect(viewport.scrollTop).toBe(100);
});

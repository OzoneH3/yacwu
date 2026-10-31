import { expect, test } from 'bun:test';
import { anchorCorrection, pickTranscriptAnchor, settleTranscriptBottom } from '../../src/lib/transcript-scroll';

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

test('a scroll away without an input event also stops the jump', async () => {
	let frames = 0;
	const viewport = { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 };
	await settleTranscriptBottom(viewport, { flush: async () => {}, update: () => {}, atEnd: () => true, cancelled: () => false,
		frame: async () => { frames += 1; if (frames === 2) viewport.scrollTop = 0; } });
	expect(viewport.scrollTop).toBe(0);
	expect(frames).toBe(2);
});

test('row height shrinkage and browser anchoring do not cancel an explicit bottom jump', async () => {
 let height = 1000, top = 0, frames = 0;
 const viewport = { get scrollHeight() { return height; }, get scrollTop() { return top; }, set scrollTop(value) { top = Math.min(value, height - 200); }, clientHeight: 200 };
 await settleTranscriptBottom(viewport, { flush: async () => {}, update: () => {}, cancelled: () => false, atEnd: () => true,
  frame: async () => { if (++frames === 1) { height = 600; top = 337; } } });
 expect(top).toBe(400);
});


test('the first layout adjustment after clicking bottom does not cancel the jump', async () => {
 let height = 1000, top = 0, frames = 0;
 const viewport = { get scrollHeight() { return height; }, get scrollTop() { return top; }, set scrollTop(value) { top = Math.min(value, height - 200); }, clientHeight: 200 };
 await settleTranscriptBottom(viewport, { flush: async () => {}, update: () => {}, cancelled: () => false, atEnd: () => true,
  frame: async () => { if (++frames === 1) top -= 63; } });
 expect(top).toBe(800);
});

test('the anchor is the rows on screen, topmost first, with their offsets', () => {
	const rows = [
		{ key: 'below', top: 900, bottom: 1200 },
		{ key: 'reading', top: 120, bottom: 700 },
		{ key: 'above', top: -400, bottom: -10 },
		{ key: 'partial', top: -50, bottom: 120 }
	];
	expect(pickTranscriptAnchor(rows, 800)).toEqual([{ key: 'partial', offset: -50 }, { key: 'reading', offset: 120 }]);
	expect(pickTranscriptAnchor([{ key: 'gone', top: -300, bottom: -1 }], 800)).toBeNull();
});

test('a row folding away above the reader is compensated through the next anchor row', () => {
	const anchor = [{ key: 'folded', offset: -50 }, { key: 'reading', offset: 120 }];
	// The partial top row was folded into a group and the text moved up 300px.
	expect(anchorCorrection(anchor, (key) => (key === 'reading' ? -180 : null))).toBe(-300);
	// Unmoved, sub-pixel, or nothing left to hold on to: no correction.
	expect(anchorCorrection(anchor, (key) => (key === 'folded' ? -50.3 : 400))).toBe(0);
	expect(anchorCorrection(anchor, () => null)).toBe(0);
});

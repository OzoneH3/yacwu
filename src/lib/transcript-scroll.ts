interface ScrollViewport {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}

/** A rendered transcript row's vertical extent, relative to the viewport's top edge. */
export interface AnchorRow {
	key: string;
	top: number;
	bottom: number;
}

/**
 * Where the reader is: the rows on screen (topmost first) and how far each
 * starts below the viewport's top. Several are kept so the place survives
 * the topmost row disappearing (folded into a group, replaced).
 */
export type TranscriptAnchor = { key: string; offset: number }[];

/** The transcript does its own scroll anchoring (`overflow-anchor: none`, for the virtual spacers). */
export function pickTranscriptAnchor(rows: AnchorRow[], viewportHeight: number, limit = 8): TranscriptAnchor | null {
	const visible = rows
		.filter((row) => row.bottom > 0 && row.top < viewportHeight)
		.sort((a, b) => a.top - b.top)
		.slice(0, limit)
		.map((row) => ({ key: row.key, offset: row.top }));
	return visible.length ? visible : null;
}

/**
 * How far to scroll so the reader's row is back where it was: the first
 * anchor row still rendered decides; 0 when none is (nothing to hold on to)
 * or it has not moved.
 */
export function anchorCorrection(anchor: TranscriptAnchor, currentTop: (key: string) => number | null): number {
	for (const { key, offset } of anchor) {
		const top = currentTop(key);
		if (top === null) continue;
		const delta = top - offset;
		return Math.abs(delta) > 0.5 ? delta : 0;
	}
	return 0;
}

/** Virtual rows must be rendered/measured before the final bottom is known. */
export async function settleTranscriptBottom(viewport: ScrollViewport, options: {
	flush: () => Promise<unknown>;
	frame: () => Promise<unknown>;
	update: () => void;
	cancelled: () => boolean;
	atEnd: () => boolean;
}): Promise<void> {
	let previousHeight = -1;
	let stableFrames = 0;
	for (let frame = 0; frame < 30; frame++) {
		await options.flush();
		if (options.cancelled()) return;
		const placedHeight = viewport.scrollHeight;
		viewport.scrollTop = placedHeight;
		const placed = viewport.scrollTop;
		options.update();
		await options.frame();
		if (options.cancelled()) return;
		// Allow the first focus/layout adjustment after clicking the jump button.
		// Later upward moves without shrinking content signal other navigation
		// (a jump link, find in page, a script) without an input event.
		if (frame > 0 && viewport.scrollHeight >= placedHeight && viewport.scrollTop < placed - 2 && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 2) return;
		const height = viewport.scrollHeight;
		const atBottom = height - viewport.scrollTop - viewport.clientHeight <= 2;
		stableFrames = height === previousHeight && atBottom && options.atEnd() ? stableFrames + 1 : 0;
		previousHeight = height;
		if (stableFrames >= 3) return;
	}
}

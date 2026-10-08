interface ScrollViewport {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
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
		viewport.scrollTop = viewport.scrollHeight;
		options.update();
		await options.frame();
		if (options.cancelled()) return;
		const height = viewport.scrollHeight;
		const atBottom = height - viewport.scrollTop - viewport.clientHeight <= 2;
		stableFrames = height === previousHeight && atBottom && options.atEnd() ? stableFrames + 1 : 0;
		previousHeight = height;
		if (stableFrames >= 3) return;
	}
}

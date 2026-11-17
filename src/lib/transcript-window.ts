export function transcriptWindow<T>(items: T[], height: (item: T) => number, scrollTop: number, viewportHeight: number, overscan: number, followBottom: boolean): {
	items: T[];
	before: number;
	after: number;
	total: number;
} {
	if (items.length === 0)
		return { items: [], before: 0, after: 0, total: 0 };
	// Completion and activity folding can remove most of the measured height
	// before the browser delivers its clamped scroll event. Always keep the
	// render window within the current content, even with stale pixel offsets.
	const totalHeight = items.reduce((sum, item) => sum + height(item), 0);
	const maxScroll = Math.max(0, totalHeight - viewportHeight);
	scrollTop = followBottom ? maxScroll : Math.max(0, Math.min(scrollTop, maxScroll));
	const startOffset = Math.max(0, scrollTop - overscan);
	const endOffset = scrollTop + viewportHeight + overscan;
	let before = 0;
	let start = 0;
	while (start < items.length) {
		const h = height(items[start]);
		if (before + h >= startOffset)
			break;
		before += h;
		start += 1;
	}
	let renderedHeight = 0;
	let end = start;
	while (end < items.length) {
		const h = height(items[end]);
		renderedHeight += h;
		end += 1;
		if (before + renderedHeight > endOffset)
			break;
	}
	let after = 0;
	for (let i = end; i < items.length; i += 1)
		after += height(items[i]);
	return { items: items.slice(start, end), before, after, total: before + renderedHeight + after };
}

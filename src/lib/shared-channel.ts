const SHARED_CHANNEL_MARKER = '\n\n<!-- YACWU_SHARED_BACKGROUND_CHANNEL -->\n';

function normalizePath(path: string): string {
	const normalized = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
	return normalized || '/';
}

function hash(value: string, seed: number): string {
	let result = seed >>> 0;
	for (let index = 0; index < value.length; index += 1) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 0x01000193) >>> 0;
	}
	return result.toString(16).padStart(8, '0');
}

/** A stable, opaque temporary-directory path for sessions on the same host and workspace. */
export function sharedChannelPath(host: string, cwd: string): string | null {
	if (!cwd.trim()) return null;
	const identity = `${host.trim() || 'local'}\0${normalizePath(cwd)}`;
	return `/tmp/yacwu-background-${hash(identity, 0x811c9dc5)}${hash(identity, 0x9e3779b9)}`;
}

export function hasSharedChannelContext(text: string): boolean {
	return text.includes(SHARED_CHANNEL_MARKER);
}

/** Remove Yacwu's transport-only channel guidance from transcript presentation. */
export function visibleUserText(text: string): string {
	// App-server backends may trim leading blank lines before echoing user input,
	// so match the sentinel itself rather than depending on its surrounding LFs.
	const markerAt = text.indexOf('<!-- YACWU_SHARED_BACKGROUND_CHANNEL -->');
	return markerAt < 0 ? text : text.slice(0, markerAt).trimEnd();
}

/** Add one-time, session-specific instructions for coordinating through the shared scratch folder. */
export function withSharedChannelContext(
	text: string,
	path: string,
	sessionId: string
): string {
	const visibleText = visibleUserText(text);
	return `${visibleText}${SHARED_CHANNEL_MARKER}Yacwu shared background-work channel
Shared folder: ${path}
Your session ID: ${sessionId}

Other Yacwu sessions using this same project folder on this machine use this folder too. Create it if needed. Use it only for coordination notes, not project source files. Before substantial work, check for shared notes; publish a concise status and important decisions, and check again at meaningful checkpoints. Use uniquely named files so concurrent sessions do not overwrite each other. Address a note to a session ID when known, or mark it “all” for everyone. Do not wait or poll continuously; continue your assigned work and check opportunistically.
[/Yacwu shared background-work channel]`;
}

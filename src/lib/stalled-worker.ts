/** Only worker lifecycle/activity notifications resolve a quiet-worker warning. */
export function clearsStalledWorkerPrompt(method: string): boolean {
	return method.startsWith('item/') || ['turn/started', 'turn/completed', 'turn/error', 'turn/diff/updated'].includes(method);
}

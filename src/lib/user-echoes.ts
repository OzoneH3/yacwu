import { visibleUserText } from './shared-channel';

export interface UserEcho { id: string; text: string }

/** The visible text of a userMessage item, without Yacwu's hidden instructions. */
export function userMessageText(item: { content?: unknown }): string {
	const content = Array.isArray(item.content) ? item.content : [];
	return content.map((part: any) => (typeof part?.text === 'string' ? visibleUserText(part.text) : '')).join('');
}

/**
 * After history is reloaded, keep only the optimistic copies of sent messages
 * that the history does not contain yet. Backends that never echo a message
 * live (claude-codex) would otherwise show it twice: once from history, once
 * as the local copy merged back.
 */
export function unconfirmedEchoes(echoes: UserEcho[], history: Array<{ type: string; content?: unknown }>): UserEcho[] {
	const restored = history.filter((item) => item.type === 'userMessage').map(userMessageText);
	return echoes.filter((echo) => !restored.some((text) => text === echo.text || text.startsWith(echo.text)));
}

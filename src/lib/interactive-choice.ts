export interface InteractiveChoice {
	question: string;
	options: string[];
}

export type PromptKind = 'choice' | 'unknown' | null;

/** Recognize an explicit assistant question followed by a Markdown option list. */
export function parseInteractiveChoice(text: string): InteractiveChoice | null {
	const lines = text.trim().split(/\r?\n/);
	let end = lines.length - 1;
	while (end >= 0 && !lines[end].trim()) end--;
	const optionPattern = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/;
	let start = end;
	while (start >= 0 && optionPattern.test(lines[start])) start--;
	const options = lines.slice(start + 1, end + 1).map((line) => {
		const match = line.match(optionPattern);
		return match?.[1].replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim() ?? '';
	});
	if (options.length < 2 || options.length > 6 || options.some((option) => !option)) return null;

	const context = lines.slice(0, start + 1).join('\n').trim();
	const questionEnd = context.lastIndexOf('?');
	if (questionEnd < 0) return null;
	const paragraphBreak = context.lastIndexOf('\n\n', questionEnd);
	const lineBreak = context.lastIndexOf('\n', questionEnd - 1);
	const questionStart = paragraphBreak >= 0 ? paragraphBreak + 2 : lineBreak + 1;
	const question = context.slice(questionStart, questionEnd + 1).trim();
	if (!question) return null;
	return { question, options };
}

export function detectPromptKind(text: string): PromptKind {
	if (parseInteractiveChoice(text)) return 'choice';
	const finalText = text.trim().replace(/[\*_`~]+\s*$/, '').trim();
	return finalText.endsWith('?') ? 'unknown' : null;
}

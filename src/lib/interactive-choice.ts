export interface InteractiveChoice {
	question: string;
	options: string[];
}

export type PromptKind = 'choice' | 'unknown' | null;

function withoutFencedCode(text: string): string {
	let fence: string | null = null;
	return text.split(/\r?\n/).filter((line) => {
		const marker = line.match(/^\s*(`{3,}|~{3,})/);
		if (marker) {
			if (!fence) fence = marker[1][0];
			else if (fence === marker[1][0]) fence = null;
			return false;
		}
		return !fence;
	}).join('\n');
}

export interface PendingInteractiveQuestion extends InteractiveChoice { id: string; threadId: string }

/** The dialog and session badge must use the same unresolved questions. */
export function pendingQuestionsForThread(
	items: ReadonlyArray<{ type: string; id: string; text?: unknown; _completed?: boolean }>,
	threadId: string,
	resolved: Record<string, boolean>
): PendingInteractiveQuestion[] {
	const lastUser = items.findLastIndex((item) => item.type === 'userMessage');
	return items.slice(lastUser + 1).flatMap((item) => {
		if (item.type !== 'agentMessage' || !item._completed) return [];
		return parseInteractiveQuestions(String(item.text ?? '')).flatMap((choice, index) => {
			const id = `${item.id}:${index}`;
			return resolved[`${threadId}:${id}`] ? [] : [{ id, threadId, ...choice }];
		});
	});
}

/** Recognize an explicit assistant question followed by a Markdown option list. */
export function parseInteractiveChoice(text: string): InteractiveChoice | null {
	const lines = withoutFencedCode(text).trim().split(/\r?\n/);
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

	// Only the adjacent paragraph can introduce these options. A question or
	// request elsewhere in a long report does not turn its lists into prompts.
	const context = lines.slice(0, start + 1).join('\n').trim().split(/\n\s*\n/).at(-1)?.trim() ?? '';
	if (!context || /^\s*(?:#{1,6}\s|[>|]|```|~~~)/m.test(context)) return null;
	const questionEnd = context.lastIndexOf('?');
	if (questionEnd < 0) {
		// Agents also pause for an action or observation, then offer response
		// choices without phrasing the request as a literal question.
		if (!/\b(?:tell me|let me know|report back|respond with|reply with|answer with)\b/i.test(context)
			&& !/(?:^|[.!]\s+)(?:\*\*)?(?:please|confirm|choose|select)\b/i.test(context)) return null;
		return context ? { question: context, options } : null;
	}
	const paragraphBreak = context.lastIndexOf('\n\n', questionEnd);
	const lineBreak = context.lastIndexOf('\n', questionEnd - 1);
	const questionStart = paragraphBreak >= 0 ? paragraphBreak + 2 : lineBreak + 1;
	const question = context.slice(questionStart, questionEnd + 1).trim();
	if (!question) return null;
	return { question, options };
}

/** Recognize a direct question even when the assistant adds a proposed default after it. */
export function parseInteractiveQuestion(text: string): InteractiveChoice | null {
	const choice = parseInteractiveChoice(text);
	if (choice) return choice;
	// Questions quoted in report tables, headings, or lists are evidence or
	// documentation, rather than a direct request for the user's answer.
	const normalized = withoutFencedCode(text).split(/\r?\n/)
		.filter((line) => !/^\s*(?:[|>]|#{1,6}\s|[-*+]\s+|\d+[.)]\s+)/.test(line)).join('\n').trim();
	const questionEnd = normalized.indexOf('?');
	if (questionEnd < 0) return null;
	const before = normalized.slice(0, questionEnd);
	const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('\n'));
	const question = normalized.slice(boundary + 1, questionEnd + 1).trim();
	if (!question || !/^(?:what|which|where|when|who|whom|whose|why|how|can|could|would|should|will|do|does|did|is|are|am|was|were|have|has|had|may|might|shall)\b/i.test(question)) return null;
	return { question, options: [] };
}

/** Return each distinct question or action request with its adjacent choices. */
export function parseInteractiveQuestions(text: string): InteractiveChoice[] {
	const lines = withoutFencedCode(text).trim().split(/\r?\n/);
	const optionPattern = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/;
	const choices: InteractiveChoice[] = [];
	let previousOptionEnd = -1;
	for (let index = 0; index < lines.length;) {
		if (!optionPattern.test(lines[index])) {
			index++;
			continue;
		}
		const start = index;
		while (index < lines.length && optionPattern.test(lines[index])) index++;
		const end = index;
		const count = end - start;
		if (count >= 2 && count <= 6) {
			const context = lines.slice(previousOptionEnd + 1, start).join('\n').trim();
			const block = [...(context ? [context] : []), ...lines.slice(start, end)].join('\n');
			const choice = parseInteractiveChoice(block);
			if (choice) choices.push(choice);
		}
		previousOptionEnd = end - 1;
	}
	if (choices.length) return choices;
	const question = parseInteractiveQuestion(text);
	return question ? [question] : [];
}

export function detectPromptKind(text: string): PromptKind {
	if (parseInteractiveQuestions(text).length) return 'choice';
	const finalText = text.trim().replace(/[\*_`~]+\s*$/, '').trim();
	return finalText.endsWith('?') ? 'unknown' : null;
}

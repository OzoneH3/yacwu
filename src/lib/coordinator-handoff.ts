// "Copy for coordinator": one session result as Markdown, ready to paste into
// a separate coordinating chat. It carries the context that chat cannot see:
// which project and session, what was asked, what came back, which files
// changed, and the contents of the files the response links to.

export interface HandoffFile { name: string; content: string }

export interface HandoffInput {
	session: string;
	folder: string;
	agent: string;
	branch?: string | null;
	durationMs?: number | null;
	request?: string | null;
	result: string;
	changedFiles?: string[];
	files?: HandoffFile[];
	/** Linked paths that could not be included, with the reason. */
	skipped?: string[];
}

/** Keep a paste within what chat inputs comfortably take. */
export const HANDOFF_FILE_BUDGET = 150_000;

function fenced(name: string, content: string): string {
	const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = '`'.repeat(longest + 1);
	const language = name.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? '';
	return `${fence}${language}\n${content.replace(/\n$/, '')}\n${fence}`;
}

function duration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function coordinatorHandoff(input: HandoffInput): string {
	const facts = [
		`- Project folder: ${input.folder || 'unknown'}`,
		`- Agent: ${input.agent}`,
		...(input.branch ? [`- Git branch: ${input.branch}`] : []),
		...(typeof input.durationMs === 'number' ? [`- Took: ${duration(input.durationMs)}`] : [])
	];
	const sections = [`# Session result: ${input.session}`, facts.join('\n')];
	if (input.request?.trim()) sections.push(`## Request\n\n${input.request.trim()}`);
	sections.push(`## Result\n\n${input.result.trim() || '(no text)'}`);
	if (input.changedFiles?.length) sections.push(`## Files changed in this task\n\n${input.changedFiles.map((file) => `- ${file}`).join('\n')}`);
	const skipped = [...(input.skipped ?? [])];
	if (input.files?.length) {
		let budget = HANDOFF_FILE_BUDGET;
		const blocks: string[] = [];
		for (const file of input.files) {
			if (file.content.length > budget) {
				skipped.push(`${file.name} (left out: the handoff would get too long)`);
				continue;
			}
			budget -= file.content.length;
			blocks.push(`### ${file.name}\n\n${fenced(file.name, file.content)}`);
		}
		if (blocks.length) sections.push(`## Linked files\n\n${blocks.join('\n\n')}`);
	}
	if (skipped.length) sections.push(`## Not included\n\n${skipped.map((entry) => `- ${entry}`).join('\n')}`);
	return `${sections.join('\n\n')}\n`;
}

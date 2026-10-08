import type { ThreadItem } from './protocol';

export function mcpActivityLabel(item: ThreadItem): string {
	const call = item as ThreadItem & { server?: string; tool?: string; arguments?: unknown };
	const label = [call.server, call.tool].filter((value) => typeof value === 'string' && value.trim()).join(' · ') || 'Connected tool';
	let args = call.arguments;
	if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
	const fields = args && typeof args === 'object' ? args as Record<string, unknown> : {};
	const detail = ['description', 'file_path', 'path', 'pattern', 'query', 'url', 'command'].map((key) => fields[key]).find((value) => typeof value === 'string' && value.trim());
	const text = typeof detail === 'string' && !label.includes(detail) ? `${label} — ${detail}` : label;
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

export function mcpActivityDetails(item: ThreadItem): string {
	const call = item as ThreadItem & { arguments?: unknown; result?: unknown; error?: unknown };
	return [['Arguments', call.arguments], ['Result', call.result], ['Error', call.error]].filter(([, value]) => value != null)
		.map(([label, value]) => `${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`).join('\n\n');
}

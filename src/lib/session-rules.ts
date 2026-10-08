export interface SessionRules {
	progress: boolean;
	sharedChannel: boolean;
	custom: string;
}

export const SESSION_RULES_KEY = 'yacwu-session-rules';
export const defaultSessionRules: SessionRules = { progress: true, sharedChannel: true, custom: '' };

export function readSessionRules(raw: string | null): Record<string, SessionRules> {
	try {
		const parsed = JSON.parse(raw ?? '{}');
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value)).map(([id, value]) => {
			const rule = value as Partial<SessionRules>;
			return [id, { progress: rule.progress !== false, sharedChannel: rule.sharedChannel !== false, custom: typeof rule.custom === 'string' ? rule.custom : '' }];
		}));
	} catch { return {}; }
}

export function withSessionRules(text: string, rules: SessionRules): string {
	const instructions = [
		!rules.progress ? 'For this task, do not emit Yacwu progress markers; progress reporting is disabled for this session.' : '',
		!rules.sharedChannel ? 'For this task, do not use the Yacwu shared background-work channel; shared coordination is disabled for this session.' : '',
		rules.custom.trim()
	].filter(Boolean);
	return instructions.length ? `${text}\n\n<!-- YACWU_SESSION_RULES -->\nSession-specific instructions for this task:\n${instructions.join('\n\n')}\n[/YACWU_SESSION_RULES]` : text;
}

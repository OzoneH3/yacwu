import { filterAndSortModelChoices, isClaudeModelCatalog, modelDisplayProfile, type ModelChoiceSummary } from './model-display';

export interface SuggestionModel extends ModelChoiceSummary {
	efforts: string[];
	defaultEffort: string;
}

/** Local starting-point rules, not an evaluation of the project or attachment contents. */
export function suggestPromptSettings(prompt: string, models: SuggestionModel[], attachments = 0) {
	const text = prompt.trim();
	if (!text && !attachments) return null;
	const demanding = /\b(formal verification|mathematical proof|prove correctness|cryptograph\w*|safety.critical|distributed consensus)\b/i.test(text);
	const complex = demanding || text.length > 3000 || /\b(architect\w*|refactor\w*|migration|concurrency|race condition|deadlock|root cause|multi.agent|security audit|implement|debug\w*|investigate|benchmark)\b/i.test(text);
	const simple = !complex && !attachments && text.length < 600 && /\b(rename|typo|spelling|wording|center|colour|color|padding|margin|readme|summari[sz]e|translate|hide|label|button)\b/i.test(text);
	// Each provider's scores are rough task-fit estimates, not a calibrated
	// cross-provider benchmark. Claude's routine tier is Sonnet, with Opus for
	// complex work and Fable for the most demanding reasoning.
	const claude = isClaudeModelCatalog(models);
	const target = claude
		? demanding ? 100 : simple ? 60 : complex ? 93 : 84
		: demanding ? 100 : simple ? 70 : 93;
	const preferredEffort = demanding ? 'high' : complex ? 'high' : simple ? 'low' : 'medium';
	const candidates = filterAndSortModelChoices(models);
	const known = candidates.filter((choice) => modelDisplayProfile(choice));
	const family = demanding ? 'fable' : complex ? 'opus' : simple ? 'haiku' : 'sonnet';
	const familyModel = claude ? known.find((choice) =>
		new RegExp(`\\b${family}\\b`, 'i').test(`${choice.id} ${choice.displayName}`)) : undefined;
	const model = familyModel ?? known.find((choice) => modelDisplayProfile(choice)!.capability >= target)
		?? [...known].sort((a, b) => modelDisplayProfile(b)!.capability - modelDisplayProfile(a)!.capability)[0]
		?? candidates[0];
	if (!model) return null;
	const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
	const supported = model.efforts.filter((effort) => order.includes(effort));
	const effort = model.efforts.includes(preferredEffort) ? preferredEffort
		: supported.sort((a, b) => Math.abs(order.indexOf(a) - order.indexOf(preferredEffort)) - Math.abs(order.indexOf(b) - order.indexOf(preferredEffort)))[0]
		?? model.efforts[0] ?? model.defaultEffort ?? '';
	const taskReason = demanding ? 'Exacting correctness requirements suggest the strongest available model.'
		: complex ? 'Technical complexity or a long brief suggests a capable model.'
		: simple ? 'A short, well-scoped edit suggests an efficient model.'
		: 'For an ambiguous or general task, a capable model is a balanced starting point.';
	const reason = `${taskReason} ${effort
		? `Uses the model's supported ${effort} effort setting.`
		: 'This model does not advertise an adjustable thinking level.'}`;
	return { guidanceUrl: claude ? 'https://platform.claude.com/docs/en/about-claude/models/overview'
		: 'https://developers.openai.com/api/docs/guides/model-selection', model: model.id, name: model.displayName || model.id, effort, reason,
		caveat: 'Local heuristic based only on draft text and attachment count; no project, conversation, or attachment contents are analyzed. No allowance used.' };
}

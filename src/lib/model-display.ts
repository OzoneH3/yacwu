export interface ModelDisplayProfile {
	capability: number;
	efficiency: string;
	valueRating: number;
	/** Cost evidence for estimates whose allowance consumption is not calibrated. */
	estimateBasis?: string;
}

export interface ModelChoiceSummary {
	id: string;
	displayName: string;
}

export function isClaudeModelCatalog(choices: ModelChoiceSummary[]): boolean {
	return choices.some((choice) => /claude|^(?:sonnet|opus|haiku|fable|mythos)(?:[-\s]|$)/i.test(`${choice.id} ${choice.displayName}`));
}

// Reviewed 2026-10-08. These are Yacwu estimates, not benchmark percentages or
// measured subscription costs. Evidence and the scoring rationale live in
// docs/model-ratings.md. Only researched versions get ratings; aliases use the
// versioned display name returned by Claude's model catalog.
const claudeEstimateBasis = 'Yacwu estimates within the Claude catalog. Efficiency and value use published API pricing and task-cost evidence as proxies, not measured subscription allowance. Capability is a rough task-fit score, not a benchmark percentage.';
const claudeProfiles: Record<string, ModelDisplayProfile> = {
	'haiku 5.5': { capability: 78, efficiency: 'Exceptional', valueRating: 5 },
	'haiku 4.5': { capability: 65, efficiency: 'Excellent', valueRating: 4 },
	'sonnet 5.5': { capability: 93, efficiency: 'Excellent', valueRating: 4.5 },
	'sonnet 5': { capability: 84, efficiency: 'Very good', valueRating: 3.5 },
	'sonnet 4.6': { capability: 78, efficiency: 'Good', valueRating: 3 },
	'sonnet 4.5': { capability: 75, efficiency: 'Good', valueRating: 2.5 },
	'opus 5.5': { capability: 98, efficiency: 'Good', valueRating: 3.5 },
	'opus 5': { capability: 92, efficiency: 'Moderate/low', valueRating: 2 },
	'opus 4.8': { capability: 87, efficiency: 'Moderate/low', valueRating: 2 },
	'opus 4.7': { capability: 84, efficiency: 'Moderate/low', valueRating: 1.5 },
	'opus 4.6': { capability: 81, efficiency: 'Moderate/low', valueRating: 1.5 },
	'opus 4.5': { capability: 79, efficiency: 'Moderate/low', valueRating: 1.5 },
	'fable 5.1': { capability: 100, efficiency: 'Moderate/low', valueRating: 1.5 },
	'fable 5': { capability: 96, efficiency: 'Moderate/low', valueRating: 1 }
};

const profiles: Array<[RegExp, ModelDisplayProfile]> = [
	[/gpt 6(?:\.0)? luna/, { capability: 70, efficiency: 'Exceptional', valueRating: 5 }],
	[/gpt 5\.6 luna/, { capability: 60, efficiency: 'Exceptional', valueRating: 4.5 }],
	[/gpt 6\.1 sol/, { capability: 93, efficiency: 'Excellent', valueRating: 3 }],
	[/gpt 5\.6 terra/, { capability: 72, efficiency: 'Very good', valueRating: 3 }],
	[/gpt 6(?:\.0)? sol/, { capability: 84, efficiency: 'Very good', valueRating: 2.5 }],
	[/gpt 5\.6 sol/, { capability: 79, efficiency: 'Good', valueRating: 2 }],
	[/gpt 6(?:\.0)? astra/, { capability: 100, efficiency: 'Moderate/low', valueRating: 1 }]
];

const efficiencyRank: Record<string, number> = {
	Exceptional: 5,
	Excellent: 4,
	'Very good': 3,
	Good: 2,
	'Moderate/low': 1
};

const claudeVersion = /\b(?:claude[-\s]+)?(haiku|sonnet|opus|fable)[-\s]+(\d+)(?:[.-](\d{1,2})(?=[-\s\[\]]|$))?(?=[-\s\[\]]|$)/i;

export function claudeModelIdentity(choice: ModelChoiceSummary): string {
	const match = claudeVersion.exec(choice.id) ?? claudeVersion.exec(choice.displayName);
	if (!match) return choice.id;
	return `${match[1].toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ''}${/\[1m\]|·\s*1m/i.test(`${choice.id} ${choice.displayName}`) ? ' [1m]' : ''}`;
}

export function modelDisplayProfile(choice: ModelChoiceSummary | null): ModelDisplayProfile | null {
	if (!choice) return null;
	// A concrete ID is authoritative; floating aliases need a resolved name.
	const match = claudeVersion.exec(choice.id) ?? claudeVersion.exec(choice.displayName);
	if (match) {
		const key = `${match[1].toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
		const profile = claudeProfiles[key];
		return profile ? { ...profile, estimateBasis: claudeEstimateBasis } : null;
	}
	const name = `${choice.displayName} ${choice.id}`.toLowerCase().replace(/[\s_-]+/g, ' ');
	return profiles.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** Hide known dominated choices and rank the remaining tradeoffs, best first. */
export function filterAndSortModelChoices<T extends ModelChoiceSummary>(choices: T[]): T[] {
	// Claude adapters can advertise a Codex proxy too. Keep their picker
	// provider-specific rather than offering unsafe cross-provider switches.
	const hasClaudeModels = isClaudeModelCatalog(choices);
	const providerChoices = hasClaudeModels
		? choices.filter((choice) => !/^(?:gpt|o[1-9])(?:[-\s.]|$)/i.test(choice.id)
			&& !/^gpt(?:[-\s.]|$)/i.test(choice.displayName))
		: choices;
	const uniqueChoices = new Map<string, T>();
	for (const choice of providerChoices) {
		if (hasClaudeModels && choice.id === 'default') continue;
		const key = hasClaudeModels ? claudeModelIdentity(choice) : choice.id;
		const previous = uniqueChoices.get(key);
		// Prefer a concrete ID over a floating alias that resolves to the same version.
		if (!previous || (choice.id.startsWith('claude-') && !previous.id.startsWith('claude-'))) {
			uniqueChoices.set(key, choice);
		}
	}
	const scored = [...uniqueChoices.values()].map((choice, index) => ({
		choice,
		index,
		profile: modelDisplayProfile(choice)
	}));
	const visible = scored.filter(({ choice, profile }) => {
		if (!profile) return true;
		return !scored.some((other) => {
			if (other.choice.id === choice.id || !other.profile) return false;
			const otherEfficiency = efficiencyRank[other.profile.efficiency] ?? 0;
			const efficiency = efficiencyRank[profile.efficiency] ?? 0;
			return otherEfficiency >= efficiency
				&& other.profile.capability >= profile.capability
				&& (otherEfficiency > efficiency || other.profile.capability > profile.capability);
		});
	});
	visible.sort((a, b) => {
		const efficiencyDifference = (efficiencyRank[b.profile?.efficiency ?? ''] ?? 0)
			- (efficiencyRank[a.profile?.efficiency ?? ''] ?? 0);
		const capabilityDifference = (b.profile?.capability ?? -1) - (a.profile?.capability ?? -1);
		return efficiencyDifference || capabilityDifference || a.index - b.index;
	});
	return visible.map(({ choice }) => choice);
}

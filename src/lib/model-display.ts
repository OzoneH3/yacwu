export interface ModelDisplayProfile {
	capability: number;
	efficiency: string;
	valueRating: number;
}

export interface ModelChoiceSummary {
	id: string;
	displayName: string;
}

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

export function modelDisplayProfile(choice: ModelChoiceSummary | null): ModelDisplayProfile | null {
	if (!choice) return null;
	const name = `${choice.displayName} ${choice.id}`.toLowerCase().replace(/[\s_-]+/g, ' ');
	return profiles.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** Hide known dominated choices and rank the remaining tradeoffs, best first. */
export function filterAndSortModelChoices<T extends ModelChoiceSummary>(choices: T[]): T[] {
	const scored = choices.map((choice, index) => ({
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

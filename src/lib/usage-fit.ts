import type { TokenTotals } from './usage-analysis';

export interface UsageObservation { percent: number; tokens: Record<string, TokenTotals> }
export interface CostEstimate { value: number; low: number; high: number; samples: number; weighted: boolean; provisional?: boolean }
type Category = 'total' | 'uncached' | 'cached' | 'output';
interface Feature { group: string; category: Category }

function amount(tokens: TokenTotals | undefined, category: Category): number {
	if (!tokens) return 0;
	if (category === 'total') return tokens.totalTokens;
	if (category === 'cached') return tokens.cachedInputTokens;
	if (category === 'output') return tokens.outputTokens; // Includes reasoning; do not charge it twice.
	return Math.max(0, tokens.inputTokens - tokens.cachedInputTokens);
}

function inverse(matrix: number[][]): number[][] | null {
	const n = matrix.length;
	const a = matrix.map((row, index) => [...row, ...Array.from({ length: n }, (_, j) => Number(index === j))]);
	for (let c = 0; c < n; c++) {
		let pivot = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
		if (Math.abs(a[pivot][c]) < 1e-9) return null;
		[a[c], a[pivot]] = [a[pivot], a[c]];
		const scale = a[c][c];
		for (let j = 0; j < 2 * n; j++) a[c][j] /= scale;
		for (let r = 0; r < n; r++) if (r !== c) {
			const factor = a[r][c];
			for (let j = 0; j < 2 * n; j++) a[r][j] -= factor * a[c][j];
		}
	}
	return a.map((row) => row.slice(n));
}

function train(observations: UsageObservation[], features: Feature[]) {
	if (!features.length || observations.length < Math.max(3, features.length + 2)) return null;
	const x = observations.map((sample) => features.map((f) => amount(sample.tokens[f.group], f.category) / 100_000));
	const gram = features.map((_, i) => features.map((_, j) => x.reduce((sum, row) => sum + row[i] * row[j], 0)));
	const covariance = inverse(gram);
	if (!covariance) return null;
	const beta = features.map(() => 0);
	const prediction = observations.map(() => 0);
	let prior = features.map(() => 0);
	// First locate a centre, then fit against each quantized reading's possible interval.
	for (const censored of [false, true]) {
		for (let iteration = 0; iteration < 500; iteration++) {
			let maxChange = 0;
			for (let c = 0; c < features.length; c++) {
				let numerator = 1e-6 * prior[c], denominator = 1e-6;
				for (let r = 0; r < x.length; r++) {
					const centre = observations[r].percent;
					const target = censored ? Math.max(Math.max(0, centre - 1), Math.min(centre + 1, prediction[r])) : centre;
					numerator += x[r][c] * (target - prediction[r] + x[r][c] * beta[c]);
					denominator += x[r][c] ** 2;
				}
				const next = Math.max(0, numerator / denominator), delta = next - beta[c];
				beta[c] = next;
				for (let r = 0; r < x.length; r++) prediction[r] += x[r][c] * delta;
				maxChange = Math.max(maxChange, Math.abs(delta));
			}
			if (maxChange < 1e-8) break;
		}
		prior = [...beta];
	}
	const residual = observations.reduce((sum, sample, r) => sum + (sample.percent - prediction[r]) ** 2, 0);
	// Two rounded endpoints contribute uncertainty even for a perfect fitted centre.
	const variance = Math.max(1 / 6, residual / Math.max(1, observations.length - features.length));
	return { features, beta, covariance, variance };
}

export function learnTokenCosts(observations: UsageObservation[]) {
	const pure = new Map<string, UsageObservation[]>();
	for (const sample of observations) {
		const keys = Object.keys(sample.tokens).filter((key) => sample.tokens[key].totalTokens > 0);
		if (keys.length !== 1 || !Number.isFinite(sample.percent) || sample.percent <= 0) continue;
		const key = keys[0], samples = pure.get(key) ?? [];
		samples.push(sample); pure.set(key, samples);
	}
	let groups = [...new Set(observations.flatMap((sample) => Object.keys(sample.tokens)))].filter((group) => observations.filter((sample) => (sample.tokens[group]?.totalTokens ?? 0) > 0).length >= 3);
	// A newly observed model must not erase established estimates; don't assign its unknown cost to known models.
	let eligible: UsageObservation[] = [];
	while (true) {
		eligible = observations.filter((sample) => Object.keys(sample.tokens).every((group) => groups.includes(group)));
		const supported = groups.filter((group) => eligible.filter((sample) => (sample.tokens[group]?.totalTokens ?? 0) > 0).length >= 3);
		if (supported.length === groups.length) break;
		groups = supported;
	}
	const samples = (group: string) => eligible.filter((sample) => (sample.tokens[group]?.totalTokens ?? 0) > 0).length;
	const fallback = train(eligible, groups.map((group) => ({ group, category: 'total' as const })));
	const categories: Category[] = ['uncached', 'cached', 'output'];
	// A clean model must not be blocked by an unrelated rank-deficient mixture.
	const independent = new Map<string, { total: ReturnType<typeof train>; weighted: ReturnType<typeof train> }>();
	for (const [group, samples] of pure) {
		const total = train(samples, [{ group, category: 'total' }]);
		const complete = samples.every((sample) => { const t = sample.tokens[group]; return Math.abs(t.inputTokens + t.outputTokens - t.totalTokens) <= 1; });
		const features = categories.filter((category) => samples.some((sample) => amount(sample.tokens[group], category) > 0)).map((category) => ({ group, category }));
		independent.set(group, { total, weighted: complete ? train(samples, features) : null });
	}
	let weighted = fallback;
	// Upgrade identifiable groups independently; another group's collinear mix keeps its labeled fallback.
	for (const group of groups) {
		if (!weighted || samples(group) < 3) continue;
		const complete = eligible.every((sample) => { const t = sample.tokens[group]; return !t || Math.abs(t.inputTokens + t.outputTokens - t.totalTokens) <= 1; });
		if (!complete) continue;
		const groupFeatures = categories.filter((category) => eligible.some((sample) => amount(sample.tokens[group], category) > 0)).map((category) => ({ group, category }));
		const candidate = [...weighted.features.filter((feature) => feature.group !== group), ...groupFeatures];
		weighted = train(eligible, candidate) ?? weighted;
	}
	function estimate(group: string, tokens: TokenTotals): CostEstimate | null {
		const local = independent.get(group);
		let fit = weighted?.features.some((feature) => feature.group === group) ? weighted : local?.weighted ?? local?.total ?? null;
		const hasWeights = fit?.features.some((feature) => feature.group === group && feature.category !== 'total');
		if (fit && hasWeights && categories.some((category) => amount(tokens, category) > 0 && !fit!.features.some((f) => f.group === group && f.category === category))) fit = null;
		if (fit && Math.abs(tokens.inputTokens + tokens.outputTokens - tokens.totalTokens) > 1) fit = null;
		fit ??= fallback?.features.some((feature) => feature.group === group) ? fallback : local?.total ?? null;
		if (!fit || !fit.features.some((f) => f.group === group)) {
			const single = pure.get(group) ?? [];
			if (!single.length || tokens.totalTokens <= 0) return null;
			const totals = single.reduce((sum, sample) => {
				const t = sample.tokens[group];
				return { tokens: sum.tokens + t.totalTokens, cached: sum.cached + t.cachedInputTokens, output: sum.output + t.outputTokens, percent: sum.percent + sample.percent };
			}, { tokens: 0, cached: 0, output: 0, percent: 0 });
			// Early total-token rates only extrapolate to broadly similar mixes.
			// Sparse evidence cannot price an uncached/output-heavy task from a
			// cached-input-heavy observation.
			if (Math.abs(tokens.cachedInputTokens / tokens.totalTokens - totals.cached / totals.tokens) > 0.15
				|| Math.abs(tokens.outputTokens / tokens.totalTokens - totals.output / totals.tokens) > 0.15) return null;
			const scale = tokens.totalTokens / totals.tokens;
			return { value: totals.percent * scale, low: Math.max(0, totals.percent - single.length) * scale,
				high: (totals.percent + single.length) * scale, samples: single.length, weighted: false, provisional: true };
		}
		const vector = fit.features.map((f) => f.group === group ? amount(tokens, f.category) / 100_000 : 0);
		const value = vector.reduce((sum, feature, i) => sum + feature * fit.beta[i], 0);
		const uncertainty = Math.sqrt(Math.max(0, fit.variance * vector.reduce((sum, feature, i) => sum + feature * vector.reduce((s, other, j) => s + other * fit!.covariance[i][j], 0), 0)));
		return { value, low: Math.max(0, value - 1.96 * uncertainty), high: value + 1.96 * uncertainty,
			samples: fit === weighted || fit === fallback ? samples(group) : pure.get(group)?.length ?? 0,
			weighted: fit.features.some((feature) => feature.group === group && feature.category !== 'total') };
	}
	function weights(group: string): Record<'uncached' | 'cached' | 'output', number | null> {
		const result = { uncached: null, cached: null, output: null } as Record<'uncached' | 'cached' | 'output', number | null>;
		const fit = weighted?.features.some((feature) => feature.group === group) ? weighted : independent.get(group)?.weighted;
		if (fit) for (const category of categories) {
			const index = fit.features.findIndex((f) => f.group === group && f.category === category);
			if (index >= 0) result[category as keyof typeof result] = fit.beta[index];
		}
		return result;
	}
	return { estimate, weights, calibrated: Boolean(fallback || weighted || [...independent.values()].some((fit) => fit.total || fit.weighted)) };
}

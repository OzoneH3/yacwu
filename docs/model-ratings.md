# Model picker ratings

Reviewed October 8, 2026. The implementation is in
[`model-display.ts`](../src/lib/model-display.ts).

## Ordering

GPT and Claude use the same rules:

1. Remove known choices when another available rated choice has equal or
   greater capability and efficiency, with a strict improvement on at least one.
2. Sort by efficiency, then capability, both descending. Original catalog order
   breaks ties. The value rating is displayed but is not a sort key.
3. Keep unknown models after rated choices, without assigning speculative ratings.
   Claude catalogs exclude GPT choices from the adapter's optional Codex proxy.

The GPT profiles and resulting order are unchanged: GPT-6 Luna, GPT-6.1 Sol,
then GPT-6 Astra when all currently rated GPT choices are present.

Claude aliases (`default`, `opus`, `sonnet`, `haiku`, and context variants) use
the version in their catalog display name. Concrete versioned IDs take priority.
Future versions receive no rating until reviewed. The picker only offers models
the backend advertises; a profile does not add a model to that catalog.
The Claude picker hides the default alias and combines duplicate aliases for
the same model version, preferring a concrete ID. Extended-context variants
remain separate. Sessions already using an alias select its visible equivalent.

## What the scores mean

Capability is a rough Yacwu task-fit score on a 0–100 scale. It is not an accuracy
percentage, a weighted benchmark average, or a calibrated comparison between
GPT and Claude. Efficiency summarizes likely resource cost for useful work,
including token prices, reported task costs, and latency. Value is a subjective
0–5 rating for capability relative to that cost.

Existing GPT value estimates emphasize Pro allowance. Claude's estimates use
published API prices and vendor task-cost evidence as proxies; they do **not**
measure subscription allowance per task. Model-picker tooltips explain this
basis. Actual cost varies with effort, token mix, context size, caching, retries,
and task success. Recorded allowance calibration remains separate from these
static ratings.

## Claude estimates

These numbers are Yacwu's interpretation of the evidence below, not scores
published by Anthropic. Fable's 100 denotes the specialist reasoning tier: it
does not mean it wins every benchmark against Opus. Keeping that tier lets users
try Fable on tasks where their Opus evaluations fall short, as Anthropic advises.

| Model | Capability estimate | Efficiency estimate | Value estimate |
| --- | ---: | --- | ---: |
| Haiku 5.5 | 78 | Exceptional | 5.0 |
| Haiku 4.5 | 65 | Excellent | 4.0 |
| Sonnet 5.5 | 93 | Excellent | 4.5 |
| Sonnet 5 | 84 | Very good | 3.5 |
| Sonnet 4.6 | 78 | Good | 3.0 |
| Sonnet 4.5 | 75 | Good | 2.5 |
| Opus 5.5 | 98 | Good | 3.5 |
| Opus 5 | 92 | Moderate/low | 2.0 |
| Opus 4.8 | 87 | Moderate/low | 2.0 |
| Opus 4.7 | 84 | Moderate/low | 1.5 |
| Opus 4.6 | 81 | Moderate/low | 1.5 |
| Opus 4.5 | 79 | Moderate/low | 1.5 |
| Fable 5.1 | 100 | Moderate/low | 1.5 |
| Fable 5 | 96 | Moderate/low | 1.0 |

The CLI-only catalog initially retained Haiku 4.5, Sonnet 5, Opus 5.5
(including its default alias), and Fable 5.1. Discovery now supplements that
catalog with concrete IDs from the account's Models API, which confirms
Haiku 5.5 and Sonnet 5.5 are available. The retained order becomes
Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1. Older
versions can still appear when their replacements are absent. Filtering is a
convenience based on these rough scores, not proof that a hidden model is worse
on every task.

Prompt suggestions use Haiku for short scoped edits, Sonnet for routine work,
Opus for complex tasks, and Fable for exacting reasoning. They fall back to the
best available rated model and only choose advertised thinking settings.

## Evidence

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing):
  input/output prices per million tokens are $0.10/$0.50 for Haiku 5.5 up to
  100k prompt tokens ($0.50/$2.50 above that), $1/$5 for Haiku 4.5, $2/$10
  for Sonnet 5 and 5.5, $3/$15 for Sonnet 4.5 and 4.6, $4/$20 for Opus 5.5,
  $5/$25 for Opus 4.5–5, and $10/$50 for Fable 5 and 5.1. Cache pricing
  differs and materially affects agentic workloads.
- [Haiku 5.5 announcement](https://www.anthropic.com/claude-haiku-5-5): a
  substantial capability improvement over Haiku 4.5, especially in reasoning
  and tool use, with much lower cost. It remains intended for scoped work,
  while Sonnet and Opus are stronger for complex agentic coding.
- [Haiku 4.5 announcement](https://www.anthropic.com/news/claude-haiku-4-5):
  establishes the older fast, inexpensive tier for coding and scoped tasks.
- [Sonnet 5.5 announcement](https://www.anthropic.com/claude-sonnet-5-5):
  improved coding and everyday work over Sonnet 5, faster generation, and
  reduced task cost. Anthropic still finds Opus stronger on open-ended work
  requiring sustained judgment, despite close scores on some evaluations.
- [Sonnet 5 announcement](https://www.anthropic.com/research/claude-sonnet-5):
  stronger agentic work than Sonnet 4.6 and a lower-cost complement to Opus 4.8.
- [Sonnet 4.6 system card](https://www-cdn.anthropic.com/78073f739564e986ff3e28522761a7a0b4484f84.pdf):
  evidence for the older Sonnet tier relative to 4.5.
- [Opus 5.5 announcement](https://www.anthropic.com/claude-opus-5-5):
  broad capability gains over Opus 5, performance near Fable 5.1 on most work,
  and lower prices and typical task costs. Its public benchmark results do
  not establish universal superiority over Fable.
- [Opus 4.8 announcement](https://www.anthropic.com/news/claude-opus-4-8),
  [Opus 4.7 announcement](https://www.anthropic.com/news/claude-opus-4-7), and
  [Opus 4.6 announcement](https://www.anthropic.com/news/claude-opus-4-6):
  evidence for progressive capability gains across the older Opus tier.
- [Fable 5.1 overview](https://platform.claude.com/docs/en/models/fable-5-1/overview):
  recommends Opus 5.5 for most workloads and Fable for demanding reasoning,
  long-horizon work, or tasks where Opus at higher effort falls short. Fable
  costs more per input/output token and has slower latency, but its cache
  reads are cheaper than Fable 5's.

These are vendor-reported evaluations under different effort levels and
harnesses. The estimates should be revisited as models change and local
task-cost observations accumulate.

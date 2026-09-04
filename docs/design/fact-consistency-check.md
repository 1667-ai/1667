---
summary: Plan for a check that reports where prose contradicts the Facts that apply to it
read_when:
  - changing Facts, Fact States, or Anchors
  - changing the Aside or utility request path
  - adding an operation that reads the story line and writes no prose
---

# Fact consistency check

## Outcome

1667 will report the places where the prose contradicts a Fact that applies at
that point in the story line. The writer decides what to do about each report.
1667 changes no prose.

A writer keeps a character's eye color, a rank, a date, or a place name in
Facts. Over a long story line the prose drifts away from them. Finding that
drift by rereading is the work this check removes.

## Why this is not a Write operation

The check reads the story and returns commentary about it. That is the same
shape as Aside, and it takes the same boundary.

- It uses the `utility` Generation Profile.
- It does not send the Author Brief, the Author's Note, story phrase bias, or
  banned strings.
- Its output can never enter a Write prompt. Continue, Direct, Retake, Rewrite,
  title, and summary builders cannot read a finding.

The last rule is the load-bearing one. A finding that could reach a
continuation prompt would make the model write toward the check, and the
writer would lose the reason to trust either one. Record the rule in
[Generation boundaries](../generation-boundaries.md) in the same change, beside
the Side Note rule it copies.

## Product behavior

The writer runs the check from the command palette, which already carries the
contextual Fact commands. It needs no new global key.

| Command | Runs against |
| --- | --- |
| Check chapter against Facts | The parts of the focused chapter |
| Check story line against Facts | Every part of the selected story line |

A run opens a findings list. Each finding shows the Fact Name, the quoted
prose, and one line that states the contradiction. Selecting a finding moves
focus to the part that holds the quote.

A finding offers no action that edits prose. The writer edits the part with `e`
as usual, or opens the Fact with `f` and changes it there. Either resolution is
the writer's, and the check does not guess which one is correct.

## Which Facts apply at a part

This is the correctness core of the feature. A Fact contains one or more Fact
States, and a Fact State can have an Anchor. The set of Facts that constrain a
part is therefore a property of the position in the story line, not of the
story.

For each part in the run, resolve the applicable Fact States exactly as the
Facts panel resolves them for its story-line scope filter:

- An unscoped Fact applies from the start of the story line.
- A scoped Fact applies from its Anchor down the story line.
- An End State stops its Fact at its Anchor and below.
- A part with no applicable state for a Fact is not checked against that Fact.

Reuse the existing resolver. A second implementation will drift from the panel,
and a check that disagrees with the panel is worse than no check, because the
writer cannot tell which one is wrong.

Checking a part against a Fact that has not started yet, or one that has ended,
produces a contradiction that is not real. That failure is the most likely way
this feature loses the writer's trust, so it needs a test for each of the four
cases above.

## Request shape

Send one request for each part, not one request for the story line. A
novel-length story line with many Facts does not fit in a context window, and a
single large request also makes every finding harder to attribute.

Each request carries:

- The text of the selected take at that part.
- The applicable Fact States for that part, with their Fact Names and tags.
- No other part, and no Side Note.

Requests within one run are independent, so they can go out concurrently under
the same connection limits as any other utility request.

The model returns zero or more findings. Each finding must carry:

| Field | Purpose |
| --- | --- |
| `fact_id` | The Fact the prose contradicts |
| `quote` | The exact prose span from the part |
| `statement` | One line: what the Fact holds, and what the prose says |

## Models

### Route

The check uses the utility route. An unset utility route falls back to the
default route, as it does for Aside. The check adds no Generation Route, no
Settings row, and no guidance row. A writer who wants a different model for
the check changes the utility route.

The check is a reading task. A small, fast model can do it. The utility route
already serves the operations that read the story and write no prose. A fourth
route would add a Settings schema change and a Profile Export change for one
operation. See [Configurable prompts](configurable-prompts.md): the utility
route stays a Generation Profile route.

Only one run is active for a story at a time. A run does not lock the story.

### Output contract

1667 cannot ask a provider for structured output. The provider adapters send no
JSON mode, no response schema, and no tool call, and Text Completions has none
of these. The check therefore uses a plain-text contract and a tolerant
parser, as autoname and summary do.

The request numbers the applicable Fact States from 1. A finding names that
number. 1667 maps the number to the Fact before the verification rules run. A
model reproduces a short number more reliably than a stored identifier. A
number outside the list fails rule 1 below.

The model returns one block for each finding. Each block has three labeled
lines:

| Line | Content |
| --- | --- |
| `FACT` | The number of the Fact State |
| `QUOTE` | The exact prose span |
| `STATEMENT` | One line: what the Fact holds, and what the prose says |

The model returns `NONE` when it finds no contradiction. It ends every answer
with a request-specific completion marker, as a summary does. The parser
accepts light decoration around a block. A block that does not parse counts as
a dropped finding.

A part fails when the marker is missing. The run marks the part as unchecked
and names the reason. The finish reason selects the reason text, with the same
rule as summary: output cut by the token limit names the limit, and a model
that stopped on its own gets a retry message. A failed part does not fail the
run.

### Temperature and sampling

The check caps temperature at `0.2`, as summary does. The stored profile value
does not change. The check wants the same answer for the same input, and a
creative temperature produces invented findings.

The check sends no phrase bias and no banned strings, from the profile or from
the story. It requests no token probabilities. The other sampling settings of
the profile apply unchanged.

### Reasoning

The reasoning setting of the profile applies. 1667 does not store a thought
with a run, and Keep thought does not apply. Most providers count a thought
against the same output limit as the answer. A long thought can cut the
findings before the marker. The unchecked reason then names the token limit.
The fix is a higher max output or a lower reasoning effort on the utility
profile.

### Context fit

Each request must fit the usable context: the context window minus the max
output of the utility profile. The Facts budget, Fact priority, and Fact
budget do not apply. Those rules drop a Fact from a Write request without a
report. A Fact that the check drops without a report is a missed contradiction
with no signal.

When the part and its applicable Fact States do not fit, 1667 splits the Fact
States into batches. Each batch carries the whole part text and one subset of
the Fact States. A finding from any batch belongs to the part. When the part
alone does not fit, the run marks the part as unchecked. 1667 never cuts the
part text. An unknown context window sends the request without this check, as
Aside does.

### Prompt cache

The block order is: contract, Fact States, part text, request. The Fact States
block ends with a candidate cache boundary. Between two Anchors, consecutive
parts share one applicable set. On a route with a cache policy, those parts
reuse the prefix through the Fact States. The cache policy of the profile
applies unchanged.

### Dry run

The dry-run provider returns one placeholder finding for each part. The
finding names the first Fact State and quotes the first sentence of the part,
so it passes the verification rules. Its statement says that it is a dry-run
placeholder. A writer and a test can then operate the findings list without a
provider.

### What a run records

A run stores the provider preset, the model ID, and the profile name that
produced it, with the dropped-finding count. A run is not a Generation Record,
and it creates no take. Autoname and Aside have no Generation Record, and the
check follows them. A run never stores a credential, a base URL, a custom
header value, or the raw provider text.

### Model evaluation

Tests with a fake provider prove the four scope cases, the verification rules,
the parser, the batch split, and the marker rule. They cannot prove that a
real model finds real contradictions.

Add an eval under `evals/` beside the Gemma replay. The fixture is a short
story with planted contradictions and the Facts that they contradict. The eval
records found, missed, and dropped findings for each model. Model evaluations
are optional and do not block a release. When practical, run the eval on one
local model and one hosted model. Use Gemma through KoboldCpp as the local
model, because it is the compatibility baseline in the
[prompt quality review](../prompt-quality-gate.md). Run the eval again when you
change the contract text and a suitable model is available.

## Reject invented findings

A model will report contradictions that are not in the text. Verify each
finding before it reaches the writer:

1. Drop the finding if `fact_id` is not in the set that applies at that part.
2. Drop the finding if `quote` is not a literal substring of the part's
   selected take.
3. Drop the finding if `quote` is empty or is the whole part.

Rule 2 is cheap and removes most invented findings, because a model that
invents a contradiction usually invents the prose along with it. Count the
dropped findings and show the count with the results. A run that drops most of
its findings tells the writer that the model or the profile is a poor fit,
which is information worth having.

## Storage

Store a run the way an Aside session is stored: a bounded, content-addressed
object, with only presence data in the story payload, loaded when the writer
opens it. See [Story storage](../story-storage.md).

Keep runs separate from Side Notes. A Side Note is a question the writer chose
to keep. A finding is machine output the writer has not yet judged. Merging
them would make the Aside history untrustworthy as a record of the writer's own
thinking.

A run records the story line it checked and the take at each part. Each part
also records whether its take was selected when the run started. A finding
from an active-line run whose take is no longer selected is stale, and the
list marks it so. A run started on an unselected take marks that finding off
line while the take exists and still contains the quote. A changed or deleted
take is stale.

## Cost and the size of a run

One request for each part means a long story line costs real money and time.

- Default the palette to the chapter command. Offer the story line command
  without making it the easy choice.
- Show the part count and let the writer cancel before the run starts.
- Skip a part that has no applicable Fact State. It has nothing to contradict.

## Non-goals

- 1667 will not edit prose to match a Fact.
- 1667 will not edit a Fact to match prose.
- The check does not judge style, pacing, or quality. Aside already answers
  those questions, and mixing them here would bury the contradictions the
  writer came for.
- The check does not run on its own. The writer starts every run.

## Decisions

- A finding belongs to the take. A finding is stale when that take is no
  longer selected.
- A Fact tag cannot opt out of the check. Add an opt-out only after use shows
  that a stable tag policy is necessary.
- Each request contains one part. This keeps request size and finding
  ownership explicit.

## Related documents

- [Generation boundaries](../generation-boundaries.md)
- [Facts, context, and model providers](../model-providers.md)
- [Story storage](../story-storage.md)
- [Prompt quality review](../prompt-quality-gate.md)
- [Configurable prompts](configurable-prompts.md)
- [Technical terms](../technical-terms.md)

# Plan 002: Add non-destructive story memory

> **Executor instructions**: Follow this plan step by step. Run every verification
> command before continuing. Stop on any condition in "STOP conditions"; do not
> improvise. When complete, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 151f794..HEAD -- shared/types.ts shared/tokens.ts shared/story-facts.ts server/story-format.ts server/story-codec.ts server/stories.ts server/story-facts.ts server/story-context.ts server/context-cache.ts server/providers.ts server/index.ts web/src/api.ts web/src/App.tsx web/src/StoryView.tsx web/src/styles.css test/story-context.test.ts test/context-cache.test.ts test/story-facts.test.ts README.md plans/003-canonical-story-facts.md plans/README.md`
> Plan 003 is an explicit dependency and will appear in this diff. Confirm its
> temporal canonical-fact contract still matches "Current state" below. Line
> references are approximate anchors — stop on structural mismatches, not line drift.

> **REBASELINE NOTE (2026-07-14, post flat-facts):** temporal fact states were
> removed after user testing — facts are flat (one tag + one text, all always
> sent via `factsSystemMessage(story)`; no boundaries, no resolver). Read every
> fact reference below through that lens. The "Current state" line references
> also predate the summary-branches/human-edit merge; re-verify structure
> against HEAD before executing, and re-anchor the drift base to the flat-facts
> merge commit.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: `plans/001-content-addressed-story-bundles.md` (DONE),
  `plans/003-canonical-story-facts.md`
- **Category**: direction
- **Planned at**: commit `4465578`; revised at `151f794`, 2026-07-14, after review.
  Scope was trimmed for a controlled, quickly releasable first version: **two-tier**
  summaries instead of a recursive rollup pyramid, **no new settings** (behavior is
  driven by whether a context window is configured), and simplified cache pruning.
  Two spec defects were also fixed: leaf cache keys are content-based (no revision
  IDs — those broke append reuse), and the author brief is neither a summarizer
  input nor a cache-key component.

## Why this matters

Continuations currently send every prompt/prose pair verbatim. Once that exceeds the
model's usable context, the meter turns red but generation still relies on the
provider to truncate or reject. Story text must never be destructively compacted:
authors still need to read and edit chapter one. Build derived, inspectable memory
over immutable revision chunks; keep the recent tail or rewrite target verbatim; and
rebuild only affected summaries after an old edit. Canonical facts (Plan 003) remain a
separate verbatim layer: attach the canonical facts message, budget it first,
and never summarize it.

## Current state (baseline `151f794` + Plan 003)

- `server/index.ts:341-356` builds continuation messages from every part;
  `server/index.ts:452-458` joins the entire story for a rewrite, even a rewrite at the
  beginning of a very long story.
- `shared/tokens.ts:8-22` estimates the full prompt at ~4 chars/token plus framing;
  `web/src/StoryView.tsx:621-659` (ContextMeter) warns at 80% and turns red at
  `contextWindow - maxTokens`. It knows nothing about a server-side context plan.
- `web/src/api.ts:150-155` ignores unknown SSE event types, so new `status`/`context`
  events are additive-safe; typed handling still needs wiring.
- `server/providers.ts:11` already has a `"title"` generation kind, and
  `handleAutoname` collects a stream to a string internally — the exact pattern the
  summarizer call needs.
- v2 bundles are landed: parts carry ordered `revisionIds` + `activeRevision`
  (`server/story-format.ts:24-34`); revisions list stable paragraph-boundary chunk
  hashes (`story-format.ts:59`), so editing one paragraph changes one chunk and the
  revision, never unrelated chunks.
- Part instructions are editable (`6559144`), so instruction text hashes into the keys
  of summaries that cover them.
- `server/autoname.ts:4` separately caps title-generation source at 24,000 chars; that
  bounded prompt stays independent. This plan governs continuation and rewrite.
- Facts are flat: `factsSystemMessage(story)` yields one deterministic canonical
  message (or null) used identically by every operation. This plan must keep that
  message fixed, verbatim, and outside all summary inputs.

## Product behavior and invariants

1. **No destructive compaction.** Story manifests, revisions, exports, version swipes,
   branches, and editor text remain complete. Context memory is a disposable cache.
2. **One behavior, no new settings.** When the full prompt fits the safe budget — or
   the context window is unknown — send today's messages **byte-for-byte**. Compact
   only when the window is known and the full prompt exceeds the safe budget. Clearing
   the context window in Settings is the documented escape hatch back to verbatim
   behavior. If fixed costs alone cannot fit a known window, fail with an
   action-oriented error; never silently truncate.
3. **Transparent cost.** Before any summary model call, SSE sends a `status` event
   such as "Preparing story memory (2 sections)…". Stop aborts summary calls too.
   Failures save neither a continuation nor partial context state.
4. **Safe budget.** `usable = contextWindow - maxTokens`; prompt budget is
   `floor(usable * 0.90)` to absorb tokenizer error. Subtract system prompt, new
   instruction, the canonical facts message, and framing first. If this fixed
   cost does not fit, fail clearly; never shorten or drop facts.
5. **Facts precede memory.** Message order: author brief, canonical facts,
   one clearly labelled derived-memory system message, the
   newest verbatim prompt/prose pairs, the new instruction. Facts override memory on
   conflict. Target 20–25% of the remaining non-fixed input for memory, capped at
   2,048 estimated tokens; spend the rest on verbatim recent prose.
6. **Massive single parts work.** Walk active-revision chunks from the end. If the
   last part alone exceeds the verbatim allowance, send its instruction plus the
   largest chunk suffix that fits, labelled as a recent excerpt with an explicit
   omission marker. Summary segmentation may split an oversized chunk by offsets.
7. **Early rewrites work.** Always include the exact marked target and a budgeted
   local neighborhood around it, then global memory for the rest. Never replace an
   editable region with its summary merely because it is old.
8. **Content-based exact invalidation.** A leaf summary's cache key contains its
   ordered source spans — for an instruction unit the part ID + instruction text hash;
   for a prose unit the part ID + ordered chunk IDs with UTF-16 start/end offsets —
   plus summary prompt version, model identity, and tier. **No revision IDs** (they
   change on every edit or append to the part and would invalidate untouched leaves —
   including on every append into the last part) and **no author-brief hash** (the
   brief is not a summarizer input). Chunk IDs are content-addressed, so editing one
   paragraph invalidates only leaves whose spans contain it, appending preserves every
   closed leaf, and swiping back to a previous version becomes a cache **hit**.
   Fact text is deliberately absent: summaries represent prose only; facts attach
   independently to the final request.
9. **Derived-cache limits.** Cache files are safe to delete at any time. After
   successful planning, prune least-recently-used files beyond 256 per story. Never
   touch prose objects or the v1 backup.

## Target cache format

Keep summaries inside each v2 story bundle, outside the story manifest:

```text
<story-id>/context/summaries/<first-2>/<cache-key>.json
```

```ts
interface ContextSummaryV1 {
  format: "1667-context-summary";
  schemaVersion: 1;
  cacheKey: string;
  promptVersion: 1;
  tier: "leaf" | "rollup";
  source: ContextSourceSpan[];      // leaves: spans; rollup: empty
  children?: string[];              // rollup: ordered child cache keys
  model: { provider: Provider; baseUrl: string; model: string };
  text: string;
  estimatedTokens: number;
  createdAt: string;
  lastUsedAt: string;
}
```

Canonical JSON and SHA-256 for `cacheKey`; never include an API key. Validate cache
contents strictly, but treat malformed or missing cache files as misses, never as
story corruption.

## Two-tier summarization

- Convert active story content into ordered source units: each part instruction, then
  chunk text spans. Leaf boundaries are append-stable and target at most the smaller
  of 4,096 tokens or half the safe prompt budget. Split oversized chunks by exact
  offsets.
- Leaf prompt: summarize only supported facts under compact Markdown headings —
  events, character state/goals/relationships, setting, unresolved threads, timeline,
  voice/style cues. Mark uncertainty; invent nothing. Summary calls receive **only**
  their named prose source (or child summaries) plus summarizer instructions — no
  author brief, no `Story.facts`, no canonical-facts message.
- If the concatenated leaf summaries for the old prefix exceed the memory allowance,
  make **one** rollup call over them with bounded output (at most the allowance,
  never above 2,048 tokens), cached by its ordered child keys. Two tiers, no
  recursion: bounded output guarantees fit.
- A cache hit is valid only when its full canonical key matches. Never patch summary
  text. Memory is explicitly labelled derived; the model is instructed to trust
  verbatim prose over memory on conflict.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `npm test` | exit 0; all tests pass |
| Context tests | `node --import tsx --test --test-name-pattern='story context|context cache' test/*.test.ts` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0 |
| Audit | `npm audit --audit-level=high` | exit 0 |
| Hygiene | `git diff --check` | exit 0, no output |

## Scope

**In scope**:

- `shared/types.ts` (ContextUsage wire type), `shared/tokens.ts`,
  `shared/story-facts.ts` (reuse)
- `server/story-format.ts`, `server/story-codec.ts`, `server/stories.ts` (source
  descriptors), `server/story-facts.ts` (reuse), `server/story-context.ts` (create),
  `server/context-cache.ts` (create), `server/providers.ts`, `server/index.ts`
- `web/src/api.ts`, `web/src/App.tsx`, `web/src/StoryView.tsx`, `web/src/styles.css`
- `test/story-context.test.ts`, `test/context-cache.test.ts` (create)
- `README.md`, `plans/README.md` status only

Keep new modules below roughly 500 lines; propose a named split before exceeding it.

**Out of scope**:

- New settings or modes (`contextMode` was cut; the context-window field already
  provides the on/off switch), so `SettingsPanel.tsx` is untouched.
- Recursive rollup hierarchies beyond the single rollup tier.
- Altering, pruning, or replacing stored story prose or version history.
- Embeddings, retrieval ranking, cross-story memory, or any change to the flat
  fact schema or CRUD behavior.
- Changing storage schema v2 or copying summary caches into branches.
- Exact provider tokenizers; the shared conservative estimator stays authoritative.
- Background/hidden model calls before the user initiates Write/Rewrite.
- Replacing the bounded autoname excerpt with story memory.

## Git workflow

- Begin only after Plan 003 is reviewed and marked DONE, from a clean worktree on a
  reviewed descendant of `151f794`.
- Conventional commits with explicit paths. Suggested units:
  `feat: build two-tier story memory`, `feat: compact generation context safely`,
  `feat: explain automatic story memory`.
- Do not push or open a PR unless explicitly requested.

## Steps

### Step 1: Expose active source identity and centralize budgeting

Add server-only source descriptors from `StoryStore`: per part, the instruction text,
and the active revision's ordered chunk IDs/texts with exact offsets. If a request
targets a legacy story, migrate it storage-only while preserving `updatedAt`; normal
reads stay lazy. Do not add disk identities to the public `Story` wire type.

Extend `shared/tokens.ts` with pure `contextBudget()` and message-estimation helpers
used by both server and meter. Reuse `factsSystemMessage(story)`; treat the resulting
message, the author brief, current instruction,
reply reservation, and framing as fixed costs before allocating memory or raw prose.

**Verify**: context tests prove prompts below budget retain byte-for-byte message
content; descriptors follow active version selection; a facts-only overflow returns a
named result rather than negative allowances. Run typecheck.

### Step 2: Build the derived summary cache and summarizer boundary

Create `server/context-cache.ts` with strict parsing, canonical content-based keys
(invariant 8), atomic writes, hits, and fail-safe LRU pruning. Define a `Summarizer`
interface so tests use a deterministic fake. Add a provider helper that collects
`streamCompletion()` internally (the `handleAutoname` pattern) with summary-specific
settings — low temperature, bounded output, a `"summary"` generation kind — and the
same abort signal; deterministic dry-run summary text; summary deltas never reach the
prose UI.

Cache writes occur only after a complete non-empty summary. Aborted or failed calls
leave temp files only. A corrupt cache file is ignored and rebuilt. Adding or editing
a fact must remain a cache hit for unchanged prose spans.

**Verify**: cache tests cover canonical hit/miss; edit/append/version-swipe
invalidation (only overlapping leaves change; append preserves closed leaves —
including append into the last part; swiping back re-hits); prompt/model invalidation;
atomic abort behavior; malformed-cache recovery; the 256-file prune; and no path
traversal. Run all tests.

### Step 3: Implement continuation and rewrite context plans

Create `server/story-context.ts` as a pure planner around the injected
summarizer/cache:

- Return current messages unchanged when the full input fits (or the window is unknown).
- Reserve the canonical facts message as immutable
  fixed context before memory, recent-tail, or rewrite-neighborhood allowances.
- Form append-stable leaves for the old prefix; summarize misses; roll up once only if
  the concatenation exceeds the memory allowance. Walk backward for the largest
  verbatim recent tail that fits.
- Re-estimate final messages and shrink recent content/memory deterministically until
  `estimatedTokens <= safePromptBudget`; never rely on provider truncation.
- Massive final part: instruction + largest chunk suffix + omission marker.
- Rewrite mode reserves the exact target plus nearby raw text first, then memory.
- Return `ContextUsage`: full source tokens, sent tokens, window, reply reserve,
  compacted flag, summarized range, summaries generated/reused.

**Verify**: table tests cover 8.2k/32k/200k windows, unknown windows, one enormous
part, many small parts, append reuse, old paragraph/prompt edit invalidation,
version swap and swap-back, early rewrite, and summary failure. Every successful plan
is within budget; source stories are deeply equal before/after planning.

### Step 4: Integrate generation without weakening save races

In `handleContinue`, open SSE before context preparation, send `status`/`context`
events, then pass planned messages to the existing streaming/commit path. Preserve
final ordering (invariant 5). Stop must abort summary and
prose generation. Preserve `genId`, reload-under-lock, partial-save, regenerate, and
deletion race behavior exactly.

Apply rewrite planning before `streamModel`; keep marker nonce, stale-selection
checks, boundary whitespace, length targets, and commit conflict checks unchanged.
If fixed facts overflow a known window, explain that facts must be shortened or
consolidated (they are never dropped or summarized).

**Verify**: integration tests with fake summarizer/provider show summary calls precede
prose, status is never appended as prose, Stop during summary saves nothing, and all
existing generation race tests stay green. Run `npm test` and typecheck.

### Step 5: Make compaction visible

Extend SSE parsing with typed `status` and `context` callbacks. During preparation the
story view shows "Preparing story memory…" and Stop stays available. After planning,
the meter distinguishes full source size, fixed facts cost, planned/sent prompt size,
reply reservation, and how much older prose is represented by memory. An overlong
source in a known window shows working/compacted styling with the transformation
explained in the tooltip; red remains for unknown-fit failures. Do not expose cache
files or hashes.

**Verify**: build passes; pure view-model tests cover fits-verbatim, compacted,
preparing, failed, and unknown-window states. **User test** (Chris, running app): a
story well past a small configured window continues coherently, the meter explains
what was summarized, and Stop during "Preparing story memory…" saves nothing.

### Step 6: Document and run the gate

README: story memory is derived, costs an extra model call only when a known window
overflows, never changes prose, is rebuilt after old edits, and clearing the context
window restores fully verbatim prompts. Contrast with canonical facts: attached
verbatim, budgeted first, never summarized. Document
massive-part behavior and facts-overflow failure. Run the full gate; mark this plan
DONE in `plans/README.md`.

**Verify**: all gate commands exit 0; no story-storage fixtures are mutated.

## Done criteria

- [ ] A fitting story (or unknown window) produces the exact pre-feature messages.
- [ ] Every compacted prompt is within the conservative budget with reply space reserved.
- [ ] Planning mutates no story; all prose remains editable and exportable.
- [ ] Editing one old paragraph invalidates only leaves overlapping it; appending —
      including into the last part — preserves all closed leaves; version swap-back hits.
- [ ] Fact edits change final requests but never invalidate prose summaries.
- [ ] Facts precede memory in every operation.
- [ ] Facts-only overflow fails without dropping or summarizing facts.
- [ ] A massive single part gets prefix memory plus a verbatim labelled suffix.
- [ ] An early rewrite always receives the exact target and local raw context.
- [ ] Summary calls are visible, abortable, cached, bounded, never prose deltas.
- [ ] Summary failure saves no continuation/rewrite.
- [ ] Step 5 user test performed in the running app before the gate.
- [ ] Tests, typecheck, build, audit, and diff hygiene all pass.

## STOP conditions

- Storage identities (revisions/chunks/offsets) are absent or only exposable by
  changing the public web API.
- A provider cannot abort summary work with the request's signal.
- The planner can exceed its safe budget in any named test case.
- Correct early rewrite behavior would require sending the entire story verbatim.
- Cache invalidation would require modifying or deleting source prose objects.
- Two summary tiers cannot cover a real story within the memory cap — do not add a
  third tier unilaterally; stop and re-scope.
- Facts leak into summary inputs or summary cache keys.
- Product direction changes to hidden background summaries or embeddings.
- A verification fails twice or an out-of-scope file becomes necessary.

## Maintenance notes

- Increment `promptVersion` for any summary instruction/shape change; old cache
  entries become misses.
- The summary cache is derived and non-authoritative; facts stay a distinct
  manifest/object model attached at request time. Never add fact hashes —
  or revision IDs, or an author-brief hash — to summary keys.
- Provider-exact tokenization may later replace estimates behind the same budget API.
- Reviewer focus: no destructive compaction, fact precedence,
  content-based invalidation, safe budgets, abort behavior, early rewrites, and
  unchanged generation commit races.

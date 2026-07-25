# Plan 003: Add temporal canonical story facts and LitRPG authoring

> **HISTORICAL (superseded 2026-07-14).** This plan shipped in PR #14 and was then
> simplified after user testing: temporal states, boundaries, and the resolver were
> removed. Facts are flat — one tag + one text, always all sent. This document is
> the design record for the temporal experiment; do not execute or extend it.

> **Executor instructions**: Follow this plan step by step. Run every verification
> command before continuing. Stop on any condition in "STOP conditions"; do not
> improvise. When complete, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 151f794..HEAD -- shared/types.ts shared/tokens.ts shared/story-facts.ts server/story-format.ts server/story-codec.ts server/story-objects.ts server/stories.ts server/story-facts.ts server/index.ts server/autoname.ts web/src/api.ts web/src/App.tsx web/src/StoryView.tsx web/src/FactsPanel.tsx web/src/styles.css test/story-facts.test.ts test/story-format.test.ts test/story-store.test.ts test/autoname.test.ts test/continue.test.ts README.md plans/002-nondestructive-context-memory.md plans/README.md`
> Confirm the v2 manifest, immutable text-object, and branch contracts still match
> "Current state" below. Line references are approximate anchors, not exact
> contracts — stop only on structural mismatches (missing function, changed
> semantics), not on line drift.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: `plans/001-content-addressed-story-bundles.md` (DONE)
- **Category**: direction
- **Planned at**: commit `4465578`; revised at `151f794`, 2026-07-14, after review.
  Scope was trimmed for a controlled, quickly releasable first version: pinning and
  the scroll-following rail, review provenance (`needsReview`), reading-position
  tracking, extra templates, and temporal export annotations are **deferred** (see
  "Deferred with triggers" below and the growth budget in `plans/README.md`).

## Why this matters

Stories need durable truths that are neither prose history nor lossy model-generated
memory: world rules, character state, items, factions, locations, situations. LitRPG
makes those truths temporal: a character is level 4 before a battle and level 5 after
it; a quest clock moves from 2/6 to 3/6. A continuation, a regeneration, an early
rewrite, and a fork must each see the state that is true at their own story position.

Implement one fact model with a history of plain-text states anchored after story
parts. A one-state fact anchored at story start behaves like a normal static fact.
Multiple states make it temporal without any character-sheet or quest-clock schema.

## Current state (baseline `151f794`)

- `shared/types.ts:1-18` defines ordered `StoryPart`s with stable part IDs. Rewrites,
  regenerations, manual edits, and swipes change a part's active text while keeping its ID.
- `shared/types.ts:33-40` exposes `Story` with title, origin, timestamps, and parts only.
- v2 content-addressed bundles are **landed on `main`** (since `1d2b673`, hardened in
  `a0e6818`): `server/story-format.ts:24-34` defines `StoryManifestV2`;
  `server/story-codec.ts:29-78` maps story text to immutable revision/chunk objects;
  chunking is paragraph-boundary (`story-format.ts:59`), so unchanged blocks share chunks.
- `server/stories.ts:101-126` forks through a full-part or mid-part cut
  (`prepareBranchParts` at `stories.ts:340`). Part IDs stay identical across the shared
  prefix, which provides durable fact anchors.
- `server/index.ts:341-356` builds continuation messages; regeneration omits the last
  part; append continues inside it. `server/index.ts:452-458` sends the full active
  story for a rewrite.
- `server/index.ts:210-249`: part deletion runs under `withLock` and already requires a
  `DeletePartRequest` confirmation (`mode: "variant" | "part"` plus expected text hash
  and version counts, `409` on drift). This plan's anchor check composes with that flow.
- `server/index.ts:201-208` (version select) and `server/index.ts:250-260` (part PATCH)
  are **not** under `withLock` yet; this plan retrofits them so anchor checks and writes
  are indivisible.
- `web/src/StoryView.tsx:201-230` renders ordered parts inside `.story-scroll`; the file
  is ~704 lines, so fact UI goes into a new `FactsPanel.tsx`, not `StoryView.tsx`.
- `server/autoname.ts:4` caps the title prompt at 24,000 chars; its collect-to-string
  internal call pattern (`handleAutoname`) is the model for non-streaming model use.
- Plan 002 (revised) adds lossy, derived story memory. Fact state remains a distinct
  authoritative layer, resolved at the request boundary, sent verbatim, and absent from
  summary inputs and cache keys.

## Product behavior and invariants

1. **One temporal model.** A fact owns ordered states. Each state is plain multiline
   text and becomes effective after one story part; `null` means story start. One state
   at story start is a static fact. No `dynamic` flag, no type-specific schema.
2. **Part-boundary anchors.** Changes take effect after a complete story part, not at
   character offsets. Passage-level anchors are deferred.
3. **Position-aware truth.** Resolve each fact independently at a named boundary.
   Exclude facts whose first state is still in the future. Send only the effective
   state — never its history — to a model request.
4. **Every effective fact is included.** Panel search and display filters never
   determine prompt inclusion.
5. **Facts outrank derived memory.** Prompt instructions identify resolved facts as
   canonical. If one conflicts with Plan 002 memory, the fact wins. Generation itself
   never mutates stored fact states.
6. **No silent model edits.** All fact changes are explicit user actions. A later AI
   assistant may propose post-commit diffs, but authors accept or reject them.
7. **Stable chronology across prose changes.** A state anchor follows its part ID
   across rewrites, edits, and version swipes, so it never disappears unexpectedly.
   (Review-provenance badges are deferred; authors re-read sheets after big rewrites.)
8. **No orphan anchors.** Whole-part deletion (`mode: "part"`) returns `409` while any
   fact state references the part, listing bounded fact/state IDs so the UI can point
   at what must be reanchored or deleted first. Variant deletion (`mode: "variant"`)
   stays allowed — the part and its ID survive. Never silently move or discard states.
9. **Fork at the cut.** Copy fact identities and states effective through the fork
   boundary. A full-part fork includes states anchored after that part; a mid-part fork
   excludes them. Exclude facts not yet introduced. Retained IDs/history then diverge.
10. **Self-contained content-addressed storage.** Fact identity, tag, state IDs,
    anchors, and timestamps live in the v2 manifest. State bodies use the existing
    immutable text revision/chunk objects.
11. **Bounded but never compacted.** Enforce limits on mutation and reserve resolved
    facts before compaction. If fixed context cannot fit, reject; never omit,
    summarize, truncate, or time-shift a fact state.

## Target wire and storage contracts

Add normalized public types:

```ts
interface StoryFactState {
  id: string;
  text: string;
  /** null = effective from story start; otherwise effective after this part. */
  effectiveAfterPartId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface StoryFact {
  id: string;
  tag: string | null;
  createdAt: string;
  updatedAt: string;
  states: StoryFactState[];
}
interface Story {
  // Existing fields unchanged.
  facts: StoryFact[];
}
```

Manifest metadata references immutable fact-state text:

```ts
interface StoredFactStateV1 {
  id: string;
  revisionId: ObjectHash;
  effectiveAfterPartId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface StoredFactV1 {
  id: string;
  tag: string | null;
  createdAt: string;
  updatedAt: string;
  states: StoredFactStateV1[];
}
```

Extend `StoryManifestV2` with `facts: StoredFactV1[]`. v2 landed only days ago and no
external bundles exist, so fold this into v2 **without a schema bump**; parse a missing
`facts` field as `[]` so legacy stories and bundles written by the current baseline load.

Shared limits, validated again on the server:

```ts
const MAX_FACTS = 128;
const MAX_FACT_STATES_PER_FACT = 256;
const MAX_FACT_STATES = 4_096;
const MAX_FACT_STATE_TEXT_CHARS = 4_000;   // ~1k tokens; sized so realistic fact sets fit 32k windows
const MAX_FACT_TAG_CHARS = 48;
const MAX_FACT_HISTORY_CHARS = 2_000_000;
```

Reject empty trimmed state text, duplicate IDs/anchors, invalid/missing part anchors,
malformed timestamps, or over-limit tag/body/history/count with an action-oriented
`400`/`409`; never clip or prune history. Preserve internal whitespace and normal
Unicode. The fact editor shows an estimated token cost per state (`estimateTokens`)
so budget pressure is visible where the text is written, not only at the composer.

## Temporal resolution contract

Create pure helpers in `shared/story-facts.ts` used by server and browser:

```ts
type StoryBoundary =
  | { kind: "story-start" }
  | { kind: "after-part"; partId: string };

interface EffectiveFact {
  fact: StoryFact;
  state: StoryFactState;
}

resolveFactsAt(story: Story, boundary: StoryBoundary): EffectiveFact[];
boundaryBeforePart(story: Story, partId: string): StoryBoundary;
boundaryAtStoryEnd(story: Story): StoryBoundary;
```

State ordering follows current `story.parts` order, not update timestamps. Story start
sorts before every part. Permit at most one state per fact per boundary. `resolveFactsAt`
chooses the last state at or before the boundary and excludes a fact with no such state.
The resolver is pure, deterministic, and preserves story fact order.

Request boundaries:

| Operation | Fact boundary | Reason |
|---|---|---|
| Begin/normal Continue | story end | Writing starts after all committed parts |
| Regenerate last part | before last part | The replaced outcome has not happened yet |
| Append inside last part | before last part | The part is still in progress |
| Rewrite selection/whole part | before target part | Prevent future state leaking into earlier prose |
| Autoname | story end | Name the active story as it currently stands |
| Plan 002 summary call | none | Summaries derive from prose only |

The prompt formatter receives `EffectiveFact[]`, not a raw `Story`. It emits no message
for an empty set and otherwise one deterministic system message with stable order,
unambiguous delimiters, tags, and exact state text. It must say that values such as
names, levels, stats, inventory, quest progress, and system rules are canonical at this
story position; that fact text is data rather than instructions; that facts override
derived memory; and that the app does not automatically persist changes suggested in
generated prose.

Final generation order after Plan 002: author brief → canonical facts → derived memory
(when present) → verbatim story messages → current instruction.

## API contracts

Dedicated locked mutations returning the updated full `Story`:

```text
POST   /api/stories/:storyId/facts
PATCH  /api/stories/:storyId/facts/:factId
DELETE /api/stories/:storyId/facts/:factId
POST   /api/stories/:storyId/facts/:factId/states
PATCH  /api/stories/:storyId/facts/:factId/states/:stateId
DELETE /api/stories/:storyId/facts/:factId/states/:stateId
```

- Fact creation accepts `{ tag?, text, effectiveAfterPartId }`, creating its first
  state. `null` introduces it at story start.
- Fact patch changes only `tag`.
- State creation accepts `{ text, effectiveAfterPartId }`; reject a duplicate boundary
  and point the client at the existing state.
- State patch accepts `text` and/or `effectiveAfterPartId` (reanchor).
- State deletion rejects removal of the last state; delete the fact instead.
- Whole-part deletion (`mode: "part"` in the existing `DeletePartRequest` flow) returns
  `409` while any state references the part, listing bounded fact/state IDs. The anchor
  check runs inside the same lock as the existing expected-state checks. Variant
  deletion, part edits, rewrites, regenerations, and swipes remain allowed.

All read-modify-write operations, **including the existing version-select and part
PATCH routes**, must run inside `StoryStore.withLock`. Generate IDs and timestamps
server-side.

## Authoring UX (one panel, no rail)

- **FactsPanel** (`web/src/FactsPanel.tsx`): toggled from the story header. Wide
  layouts show it beside the manuscript; narrow layouts show the same content as a
  drawer. CSS handles the split; there is no scroll-position tracking.
- **Boundary picker** at the top of the panel: `Latest` (default), `At story start`,
  and `After part N` (with a short part snippet). The panel shows each fact's effective
  state at the picked boundary, or `Not introduced yet`. Historical viewing is
  visually explicit; the picker never changes what the composer will send — the meter
  and next Continue remain story-end based.
- **Edit guard.** When the picked boundary exactly matches a state's anchor, the action
  is `Edit` on that state; otherwise it reads `Add change at this boundary` and
  prefills the effective text into a new state. This prevents editing the past
  accidentally. Every edit has visible Save and Cancel; preserve whitespace; use a
  monospace body treatment where useful for aligned sheets.
- **Timeline.** Each fact expands to its chronological state history with part
  number/snippet, edit, reanchor, and delete actions.
- **Two templates**, inlined in `FactsPanel.tsx` as plain-text prefills (no parser,
  no arithmetic): **Character sheet** (name, level, class, HP/resources, attributes,
  skills, equipment, conditions, goals) and **Quest clock** (title, objective,
  progress/segments, status, deadline, consequences, next trigger).

Deferred (do not build in this plan): pinned facts and the sticky rail, scroll-position
boundary following, review badges, more templates, temporal export annotations.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `npm test` | exit 0; all tests pass |
| Focused tests | `node --import tsx --test --test-name-pattern='story facts|story format|story store|autoname' test/*.test.ts` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0 |
| Audit | `npm audit --audit-level=high` | exit 0 |
| Hygiene | `git diff --check` | exit 0, no output |

## Scope

**In scope**:

- `shared/types.ts`, `shared/tokens.ts`, `shared/story-facts.ts` (create)
- `server/story-format.ts`, `server/story-codec.ts`, `server/story-objects.ts`,
  `server/stories.ts`, `server/story-facts.ts` (create), `server/index.ts`,
  `server/autoname.ts`
- `web/src/api.ts`, `web/src/App.tsx`, `web/src/StoryView.tsx` (panel toggle wiring
  only), `web/src/FactsPanel.tsx` (create), `web/src/styles.css`
- `test/story-facts.test.ts` (create), `test/story-format.test.ts`,
  `test/story-store.test.ts`, `test/autoname.test.ts`
- `README.md`, `plans/002-nondestructive-context-memory.md`, `plans/README.md`

Keep new modules below roughly 500 lines; propose a named split before exceeding it.

**Out of scope**:

- Everything in the deferred list above (pinning/rail, position tracking, review
  provenance, extra templates, export annotations).
- `server/story-snapshot.ts` changes. Re-storing fact-state bodies on save is
  idempotent and cheap at ≤128 facts because the object store is content-addressed;
  extend the snapshot only if save profiling later shows it matters.
- Automatic AI extraction, mutation, or acceptance of fact changes.
- Passage/character-offset anchors, calendar/world-time semantics, cross-part ranges.
- Structured stat/quest schemas, calculations, progress widgets, or validation.
- Cross-story fact libraries, live inheritance after fork creation, branch merging.
- Multiple tags per fact, semantic retrieval, embeddings, ranking, per-request toggles.
- Implementing Plan 002's summarizer/cache/compaction machinery in this change.
- New dependencies.

## Git workflow

- Execute from `main` at `151f794` or a reviewed descendant, from a clean worktree.
- Conventional commits with explicit paths. Suggested units:
  `feat: persist temporal story facts`, `feat: resolve facts by story position`,
  `feat: add the story facts panel`, `docs: explain canonical story facts`.
- Do not push, merge, or open a PR unless explicitly requested.

## Steps

### Step 1: Define temporal types and deterministic resolution

Add the public types/limits in `shared/types.ts`. Create `shared/story-facts.ts` with
boundary validation, chronological state ordering, `resolveFactsAt`,
`boundaryBeforePart`, and `boundaryAtStoryEnd`. Treat a missing `facts` array as empty
at storage/import boundaries, but return a normalized array on every `Story` response.
Reject duplicate state boundaries rather than resolving them by timestamps.

**Verify**: `test/story-facts.test.ts` table-tests story start, first introduction,
multiple changes, two facts changing at different parts, before-part versus after-part,
absent future facts, and invalid/missing anchors. Input stories remain deeply equal
after resolution. Run focused tests and typecheck.

### Step 2: Store fact state bodies in the v2 object graph

Extend manifest parsing/serialization with `StoredFactV1`/`StoredFactStateV1`; missing
facts parse as `[]`. Store/read state bodies through the existing immutable
revision/chunk object store (`storeText`/`readTexts`); unchanged text reuses its object
by content address. Include fact-state body `revisionId`s in reachability/sweep.
Template text should use blank-line sections so unchanged blocks share paragraph
chunks; the chunk format itself stays generic.

Update branch preparation before object publication: copy story-start states and
states anchored before the cut; include the target part's after-states only for a
full-part fork; exclude unintroduced facts. Preserve retained fact/state IDs and
timestamps. `reuseFrom` hard-links or copies reachable fact objects into the
self-contained destination bundle exactly as it does prose objects.

**Verify**: format/store tests cover pre-facts-v2 compatibility, exact multiline
round-trip, state-object reuse across saves, sweep reachability, full-part versus
mid-part fork cuts, fork independence after the cut, and unchanged prose word counts.

### Step 3: Add locked temporal CRUD and mutation safeguards

Implement validation/formatting helpers in `server/story-facts.ts`, then add the
fact/state routes. Every mutation loads and saves within `StoryStore.withLock`.
Retrofit the version-select and part-PATCH routes into `withLock` so anchor checks and
writes are indivisible. Add the anchored-part check to whole-part deletion inside the
existing confirmed-delete lock section; return the bounded conflict payload. Server-
enforce all limits, anchor existence, one state per fact/boundary, last-state deletion,
Unicode validity, and total history size. Fact/tag edits update fact/story timestamps;
state edits update state/fact/story timestamps.

**Verify**: route/store tests cover create/update/delete, historical edit, reanchor,
duplicate boundary, missing anchor, limits, concurrent edits, and blocked whole-part
deletion composing with the `DeletePartRequest` 409s. Run all tests and typecheck.

### Step 4: Resolve facts for every user-facing model operation

Build the canonical system message from `EffectiveFact[]`. Integrate the operation
table: normal continuation and autoname use story end; regeneration, append, and
rewrite use the boundary before their target part. Preserve existing generation IDs,
partial-save behavior, rewrite markers, stale-selection checks, and commit races.
Generation input stays the request snapshot, matching current prose behavior.

Extend `estimatePromptTokens` with the resolved story-end facts so the meter tracks the
real next prompt. Keep every effective fact and shrink autoname's prose excerpt first.
If fixed resolved facts cannot fit a known context, return a clear failure; never
substitute latest, historical, or summarized state.

**Verify**: provider-message tests prove the exact boundary for begin/continue,
regenerate, append, early/late rewrite, and autoname. Each contains every effective
fact once and no future or superseded state. No-fact stories preserve their old
message shape byte-for-byte.

### Step 5: Build the facts panel

Create `FactsPanel.tsx` with the boundary picker, per-boundary effective states,
timeline management, the edit-vs-add-change guard, the two templates, search,
whitespace preservation, Save/Cancel, focus return, and the narrow-screen drawer.
Wire a toggle into the story header; keep `StoryView.tsx` changes to wiring. Resolve
displayed facts with the same shared helper the server uses.

**Verify**: build passes; pure view-model tests cover boundary selection, introduction,
multiple state changes, exact-boundary edit versus historical add, template prefill,
and Save/Cancel. **User test** (Chris, in the running app): a character sheet changing
level/inventory and a quest clock advancing across at least three parts, on wide and
narrow layouts, plus a fork before/after a state change — before starting Step 6.

### Step 6: Document, reconcile, and run the gate

README: explain static versus temporal facts, `after part` semantics, operation
boundaries, fork cuts, all-effective-facts prompt inclusion, manual updates only, the
two templates, and overflow behavior. Reconcile the front-page "no character cards"
line: canonical facts are plain local text, not card systems. State explicitly that
prose events do not automatically update sheets or clocks. Then run the full gate
(commands table) and mark this plan DONE in `plans/README.md`.

**Verify**: all gate commands exit 0; existing no-fact stories remain readable.

## Test plan

- `test/story-facts.test.ts`: pure boundaries/resolution, validation, formatter, and
  operation-specific messages, table-driven like `test/autoname.test.ts`.
- `test/story-format.test.ts`: manifest facts, object IDs, anchors, canonical
  serialization, missing-facts compatibility.
- `test/story-store.test.ts`: reachability, fork cuts, locks, blocked deletion.
- `test/autoname.test.ts`: story-end facts take priority over the prose excerpt.
- Keep view-model logic importable by Node tests; no browser-test dependency.

## Done criteria

- [ ] Legacy and pre-facts v2 stories load with `facts: []`; fact bodies round-trip exactly.
- [ ] A one-state story-start fact behaves as a static fact without a mode flag.
- [ ] Continue/autoname use story-end facts; regenerate/append/rewrite use pre-target facts.
- [ ] No model request receives a future or superseded fact state.
- [ ] Fact state bodies participate in content-addressed reachability and fork reuse.
- [ ] Full-part and mid-part forks retain exactly the fact history valid at their cut.
- [ ] Prose edits/swipes never orphan or move a fact state.
- [ ] Deleting an anchored part fails clearly until its states are moved or deleted,
      composing with the existing delete-confirmation 409s.
- [ ] Version-select and part-PATCH routes run under the story lock.
- [ ] Boundary picker views history without changing what generation sends.
- [ ] Templates are plain text with visible Save/Cancel; generation never mutates facts.
- [ ] Step 5 user test performed in the running app before the gate.
- [ ] Tests, typecheck, build, audit, and diff hygiene all pass.

## STOP conditions

- The `151f794` baseline differs materially or is unreachable from the execution branch.
- Product direction requires passage-offset precision or automatic AI fact writes.
- A fact type needs arithmetic, structured validation, or merge behavior plain text
  cannot meet.
- Required effective facts cannot fit a configured model context after all prose is
  removed.
- The object sweep cannot include fact-state revisions without risking prose objects.
- Part deletion cannot be made atomic with its anchor check under the story lock.
- Any deferred item (pinning/rail, position tracking, review provenance, export
  annotations) turns out to be load-bearing for this plan — stop and re-scope with Chris.
- A verification fails twice or an out-of-scope file/dependency becomes necessary.

## Deferred with triggers (do not build speculatively)

- **Pinned rail + scroll-position tracking**: build only if the boundary picker proves
  clumsy during real writing sessions.
- **Review provenance (`needsReview`)**: build only if stale sheets after rewrites bite
  in practice; the design (anchor revision IDs as review metadata) is in this plan's
  git history at `9082853`.
- **Temporal export annotations**: build when export consumers exist.
- **More templates**: add when a real story needs one, as plain-text prefills only.

## Maintenance notes

- `effectiveAfterPartId` is a public chronology contract. Do not reinterpret it as
  "during" or "before" a part; add a new anchor kind if passage precision is justified.
- Applicability follows stable part IDs, so states survive prose version swipes.
- A future AI update assistant must run only after a successful prose commit, return
  reviewable proposals, and create accepted states anchored after that part.
- If hundreds of facts become effective, design explicit retrieval rather than
  weakening all-facts inclusion.
- Reviewer focus: boundary semantics, no future-state leakage, object reachability,
  fork cuts, locked deletion, prompt ordering, and edit-vs-add clarity.

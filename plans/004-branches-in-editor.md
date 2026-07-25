# Plan 004: Branches live inside the editor

Written 2026-07-15 from the Storyline v2 design handoff
(`docs/design/design_handoff_storyline_v2/README.md`, §2 header switcher, §7
branches panel, §9 summary-branch flow) and Chris's feature description.
Baseline: `9700543` on branch `branches-chapters`.

## Status

IN PROGRESS — executing via codex-first this session.

## Why this matters

Today "branch" forks a **standalone story**: a full copy appears in the sidebar
and the user navigates away. The design moves branches inside the work,
NovelAI-style: one shared base of parts + N branch tails, one active line,
switcher in the header, management panel in the editor. The sidebar stays flat
(one row per work, passive `⑂ N` chip). Promote is the escape hatch that turns
a branch back into a standalone story.

## Current state (baseline `9700543`)

- `POST /api/stories/:id/branch` + `/branch-summary` create standalone stories
  via `server/story-branch.ts` (`copiedBranchStory` / `summaryBranchStory`),
  with `Story.origin` recording the fork point. `StorySummary.branched` drives
  a sidebar chip.
- Stories persist as content-addressed bundles: `StoryManifestV2` (strict,
  fail-closed parse in `server/story-format.ts`), revisions/chunks in
  `server/story-objects.ts`, encode/decode in `server/story-codec.ts`,
  durability in `server/story-lifecycle.ts`, store API in `server/stories.ts`.
- All generation and part CRUD in `server/index.ts` operates on `story.parts`
  directly (~25 call sites incl. `server/generation-prompts.ts`).
- Client (`web/src/App.tsx` 517 LOC, `StoryView.tsx` 886 LOC) renders
  `story.parts`; summary-branch flow shows a banner then navigates to the new
  story.
- LOC ledger (plans/README.md): `server/index.ts` (922), `web/src/StoryView.tsx`
  (886), `server/story-format.ts` (583), `server/stories.ts` (504) are at/over
  the 500-line limit — their named splits MUST execute before feature code
  lands in them. `web/src/App.tsx` (517) is also over; its reduction happens in
  Step 4 by extracting the branch/summary flows into a hook.

## Product behavior and invariants

The model (frozen):

- A story has one shared **base** (`story.parts` — this is also the main line)
  plus zero or more **branches**. Each branch is a **tail** of parts plus a
  fork point into the base. The **active line** = base prefix (up to the fork
  point) + the active branch's tail; when no branch is active, the line is the
  base itself.
- **Editing a shared part edits every line that contains it** (including
  versions/regeneration of a shared part). This is deliberate — shared history
  is shared. Deleting a base part that is some branch's fork anchor is rejected
  with 409 naming the branch.
- Branches carry: `name`, `color`, `label` ('' | Canon | Alt | Draft |
  Discarded | Summary), optional `canon` flag (at most one branch), frozen
  fork-point display meta (`forkPartIndex`, 1-based ordinal in the line it
  forked from).
- **Creating a branch activates it.** Fork from a base part: prefix = base up
  to that part (inclusive when `forkOffset` is null; exclusive when cut — the
  cut copy becomes `tail[0]` with a NEW part id). Fork from a tail part: the
  new branch reuses the active branch's fork point and clones the tail up to
  the branch point (new part ids, cut applied to the last clone when offset).
- **Summary branch** is now in-work: same SSE generation flow, but on
  completion it creates a teal branch (`label: "Summary"`, `forkPartId: null`,
  tail = one `role: "summary"` part) and activates it. No navigation away.
  Cancel keeps nothing. Summary parts stay **editable** (settled preference
  from the UI refresh — the design's "locked" treatment is deliberately NOT
  implemented; regenerate stays blocked as today).
- **Promote** lifts a branch out as a standalone story (materialized line,
  copied facts, `origin` set when `forkPartId` is non-null) and removes it
  from the work. **Delete** removes a branch (active → falls back to main).
  **Prune** removes every branch labeled Draft or Discarded (canon-flagged
  branches are never pruned; if the active branch is pruned, fall back to
  main).
- Part ids are unique across base + all tails (parse-time invariant).
- Caps: MAX_BRANCHES = 32; branch name 1–80 chars trimmed.
- Colors: regular branches rotate `["#4b45c9", "#2f9e6b", "#c98a2b", "#c53b30",
  "#8a4bc9", "#3b7bc9"]` by creation count; summary branches are always teal
  `#0e9c8a`; canonical star gold `#e0a83c` (render-side).

## Target wire and storage contracts

`shared/types.ts` (additive):

```ts
export type BranchLabel = "" | "Canon" | "Alt" | "Draft" | "Discarded" | "Summary";

export interface StoryBranch {
  id: string;
  name: string;
  color: string;
  label: BranchLabel;
  canon?: true;
  createdAt: string;
  /** Base part id whose position anchors this branch; null = no base prefix. */
  forkPartId: string | null;
  /** Non-null: the fork part was cut mid-text at creation; the cut copy is
   *  tail[0] and the base prefix EXCLUDES the fork part. Display/meta only
   *  after creation. */
  forkOffset: number | null;
  /** 1-based ordinal of the fork part in the line it forked from, frozen at
   *  creation. 0 when forkPartId is null. Display only. */
  forkPartIndex: number;
  tail: StoryPart[];
}

// Story gains:  branches: StoryBranch[];  activeBranchId: string | null;
// StorySummary gains:  branchCount: number;   (branched stays as-is)
export const MAX_BRANCHES = 32;
```

`shared/story-lines.ts` (new, used by BOTH server and client — the only line
resolution in the codebase):

```ts
export function activeBranch(story: Story): StoryBranch | null;
export function basePrefix(story: Story, branch: StoryBranch): StoryPart[];
export function lineFor(story: Story, branch: StoryBranch | null): StoryPart[];
export function activeLine(story: Story): StoryPart[];
/** The mutable array that receives appends on the active line. */
export function lineTailArray(story: Story): StoryPart[];
/** Locate a part anywhere on the active line, with its owning mutable array. */
export function locateLinePart(story: Story, partId: string):
  { part: StoryPart; list: StoryPart[]; index: number } | null;
```

Storage — `StoryManifestV3`: `schemaVersion: 3`, everything from V2 plus
`branches: StoredBranchV1[]` and `activeBranchId: string | null`.
`StoredBranchV1` = branch meta + `parts: StoredPartV2[]` (the tail, same
encoding as base parts). Parse accepts schemaVersion 2 (→ `branches: []`,
`activeBranchId: null`) and 3; serialize always writes 3. Fail-closed
validation: `activeBranchId` references an existing branch or is null;
`forkPartId` references a base part or is null; `forkOffset` only with
`forkPartId`, integer ≥ 1; labels from the enum; ≤ MAX_BRANCHES; part ids
unique across base + all tails. `liveRevisionIds` and `activeWordCount` /
`partCount` cover the ACTIVE line (sidebar reflects what opening the story
shows); cleanup/GC must include all tails' revisions.

## API contracts

All under `/api/stories/:id`; every mutation runs inside the store's per-story
lock and returns the full updated `Story` unless noted.

- `POST /branches` `{ partId, offset, expected? , name? }` → create + activate.
  `partId` must be on the active line; offset/expected guards identical to the
  existing branch endpoint (reuse the validation in `prepareBranchParts`-style
  logic). Auto-name `Branch N` (N = branches.length + 2, i.e. main is 1),
  auto-color by rotation.
- `POST /branches/activate` `{ branchId: string | null }` → switch line
  (null = main).
- `PATCH /branches/:branchId` `{ name?, label?, canon? }` → update meta.
  `canon: true` clears the flag on every other branch; `canon: false` clears it.
- `DELETE /branches/:branchId` → remove (active → main).
- `POST /branches/:branchId/promote` → `{ story, promotedId }`: standalone
  story titled `«title» — «branch name»` from the branch's materialized line,
  facts copied, `origin` set when `forkPartId` non-null; branch removed from
  source. Object reuse from the source bundle like today's `branch()` (pass
  `reuseFrom`).
- `POST /branches/prune` → remove all label ∈ {Draft, Discarded} without the
  canon flag; returns Story.
- `POST /branch-summary` (existing route, reworked): same request body and SSE
  stream; `done` event now carries `{ branchId }` and the story keeps its id.
  Fingerprint guard stays and covers the active line at request time.
- `POST /branch` (standalone fork) REMAINS for now but is no longer called by
  the UI (promote covers the need). Do not delete the endpoint in this plan.
- Every existing part/generation endpoint (`/continue`, `/parts`, `/parts/:id`
  PATCH/DELETE, `/version`, `/rewrite`, `/autoname`) resolves parts and builds
  context from the ACTIVE line via `story-lines` helpers. `genId` dedup scans
  the line. The "delete part" handler adds the fork-anchor 409 guard.

## UX spec (from the handoff README — fidelity high)

- **Header switcher chip** (only when `branches.length >= 1`): pill with 7px
  color dot + branch name (ellipsized) + chevron. Dropdown lists Main first,
  then branches: color dot, name, canon star (gold), mono meta
  (`from ¶2 · Canon · 1 part`); active row `--accentSoft`; footer link
  "Manage all branches" opens the panel. Main shows the star when no branch
  has the canon flag.
- **Branches button** in the header (fork icon + count) next to Facts.
- **Branches panel**: right slide-over, 370px, slide-in 0.18s ease, panel
  shadow per tokens. Rows: fork icon, color dot + name, gold star when canon,
  mono meta line, hover-revealed actions promote (↑) + delete (×). One
  addition beyond the handoff (flagged for user test): a small label select
  per row (— / Canon / Alt / Draft / Discarded) so Prune has something to act
  on; picking Canon also sets the canon flag. Footer: **New branch** +
  **Summary branch** side by side, **Prune drafts & discarded** ("keeps
  canon"), caption explaining promote/summary. Mutually exclusive with the
  facts panel.
- **Part tools fork button + selection-popover Branch** now create an in-work
  branch (activating it) instead of a standalone story.
- **Summary flow**: existing `--warnSoft` banner with pulsing dot + Cancel
  stays; on completion the story reloads on the new teal branch and the notice
  reads "Summary branch ready — the model now reads the recap, not the full
  text."
- **Sidebar**: passive `⑂ N` chip (mono 10px, `--chip` bg) when
  `branchCount > 0`.
- Responsive shedding per handoff §2 (<1120px Facts/Branches drop labels,
  branch chip shrinks with internal ellipsis; title never below 140px).

## Commands you will need

```sh
npm run typecheck   # tsc over server+shared+web
npm test            # node test runner
npm run dev         # server on AI_1667_PORT (default 7373) + vite
```

Dev data dir is per-worktree (`AI_1667_DATA`, defaults to `<repo>/data`).
Provider is dry-run — generation must work end-to-end against it.

## Scope

IN: everything above. OUT (do not build): chapters/books (Plan 005), drag &
drop, toast component (reuse the notice bar), branch color picker, branch
rename UI beyond the panel (name set at creation; PATCH exists for the label
select), per-part fork-point UI beyond what part tools already expose, locking
summary parts, deleting the legacy `/branch` endpoint, any migration tooling
beyond read-V2/write-V3.

## Git workflow

Work happens on `branches-chapters`. Codex NEVER commits — Claude reviews each
step's diff and commits with the session trailer. PR to `main` at the end.

## Steps

### Step 1: Execute the named-split ledger (no behavior change)

Pure moves, zero semantic diff:
- `server/index.ts` → move the generation handlers (continue, rewrite,
  branch-summary, autoname + their SSE plumbing) to `server/generation-http.ts`;
  routing stays in index.ts. Both files < 500 after.
- `server/stories.ts` → move the part helpers (`newPart`, `findPart`,
  `supersede`, `selectVersion`, `deleteActiveVariant`, attribution clone) to
  `server/story-parts.ts`; the `StoryStore` class stays.
- `server/story-format.ts` → move fact + attribution parsing
  (`parseStoredFacts`, `parseVersionAttributions`, `validateVersionAttributions`
  and their local helpers) to `server/story-format-facts.ts`.
- `web/src/StoryView.tsx` → extract the part card (tools row, prompt row,
  prose rendering, edit mode) to `web/src/PartCard.tsx`.
Update imports everywhere. Gate: typecheck + full tests green, `git diff
--stat` shows moves, every touched file < 500 LOC.

### Step 2: Shared model + storage (types, lines, format V3, codec)

Files: `shared/types.ts`, `shared/story-lines.ts` (new),
`server/story-format.ts`, `server/story-format-facts.ts` (only if the branch
parsing shares helpers), `server/story-codec.ts`, `server/stories.ts` (only
`liveRevisionIds` + summary), `test/story-format` + new
`test/story-lines.test.ts`. Contracts exactly as specified above. V2 bundles
on disk load with empty branches and re-save as V3.

### Step 3: Server branch operations + line-aware generation

Files: `server/story-branch.ts` (in-work creation + promote materialization),
`server/branch-summary.ts` (in-work rework), `server/stories.ts` (store
methods), `server/index.ts` (routes), `server/generation-http.ts`,
`server/generation-prompts.ts` (line-based context), new
`test/story-branches.test.ts` + updates to continue/rewrite/generation tests.
Every part-resolution and context-build call site switches to `story-lines`
helpers. Fork-anchor delete guard. Endpoints per API contracts.

### Step 4: Web UI

Files: `web/src/api.ts`, new `web/src/use-branches.ts` (branch handlers + the
summary-branch flow moved OUT of App.tsx — App must end < 500 LOC), new
`web/src/BranchSwitcher.tsx`, new `web/src/BranchesPanel.tsx`,
`web/src/App.tsx`, `web/src/StoryView.tsx` + `PartCard.tsx` (line rendering via
`activeLine`, fork buttons rewired), `web/src/Sidebar.tsx` (⑂ chip),
`web/src/icons.tsx` (star, grip if missing), `web/src/styles.css` (or the
repo's CSS file). Visuals per UX spec + design tokens already in the CSS.

### Step 5: Gate and closeout (Claude, not Codex)

Full typecheck + tests, browser smoke on dry-run (create story → parts →
branch from part → switch → continue on branch → summary branch → promote →
prune → delete), /autoreview + thermo review, PR.

## Test plan

- story-lines: prefix/line/locate math incl. offset-cut branches, empty base,
  fork-from-tail cloning (fresh ids), tail append targeting.
- format: V3 round-trip; V2 read; every fail-closed rejection (bad
  activeBranchId, orphan forkPartId, duplicate part id across tails, label
  enum, offset without forkPartId, > MAX_BRANCHES).
- store: branch create/activate/patch/delete/prune/promote through the store;
  GC keeps tail revisions (waitForMaintenance + reload); promote reuses
  objects; summary fingerprint 409 on drift; fork-anchor delete 409.
- generation: continue/regenerate/append on an active branch touch only the
  tail; context sent to the provider = active line; rewrite + version swipe on
  tail parts; genId dedup on the line.
- existing suites stay green (standalone /branch endpoint keeps its tests).

## Done criteria

- All of the above tests green; typecheck green; every touched module < 500
  LOC; the four ledger splits landed.
- Browser smoke passes end-to-end on dry-run.
- Sidebar stays flat; switcher/panel/summary flow match the handoff visually
  (tokens, radii, meta lines) with the two flagged deviations (editable summary
  parts, label select in panel).
- PR open against main with the deviations + ceiling note called out.

## STOP conditions

Codex must STOP and report instead of proceeding when:
- any change would push a file past 500 LOC,
- the spec is ambiguous or contradicts existing behavior/tests,
- work would touch files outside the step's list,
- an existing test needs semantic (not mechanical) changes the spec didn't
  predict.

## Notes

- LOC ceiling: repo is at ~7.6k of the ~8k benchmark; this plan adds roughly
  +1.1k net. Proposal recorded in plans/README.md: raise the benchmark to
  ~10k through the branches + chapters era. Chris signs off via this PR.
- The legacy standalone-branch endpoint and `Story.origin` stay untouched;
  promote produces exactly that shape.

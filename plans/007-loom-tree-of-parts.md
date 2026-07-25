# Plan 007: Loom — the story is a tree of parts

Written 2026-07-16 from the Loom design handoff
(`docs/design/design_handoff_loom/` — `IMPLEMENTATION_PROMPT.md` is the
contract, `DESIGN_SPEC.md` the surface spec, `Storyline Loom.dc.html` the
interactive reference). Baseline: `342c4e5` on branch `loom`.

## Status

IN PROGRESS — implementation complete; final gates, reviews, and PR smoke in progress.

## Why this matters

Plan 004 gave the app two overlapping alternative mechanisms: per-part
`versions[]` (in-place ‹n/N› swipe) and in-work `branches[]` (base + tails).
Loom merges them into one structure: **the story is a tree of parts;
alternatives of a part are siblings ("takes"); what you read is one root→leaf
path (a "line")**. Bookmarks on leaves replace named branches. "Branch" and
"version" are retired words — in UI copy AND, where practical, in code.

## The model (frozen)

### Shared types (`shared/types.ts`)

```ts
export interface StoryNode {
  id: string;
  /** null = a root: a take of the story's beginning. */
  parentId: string | null;
  instruction: string;
  text: string;
  model: string;
  createdAt: string;
  /** Set on any in-place mutation (human edit, rewrite, append). */
  updatedAt?: string;
  /** Human-edit spans of the current text. */
  attribution?: HumanEditAttribution | null;
  /** This take began when the user typed at a seam (or composer Write). */
  human?: true;
  genId?: string;
  role?: "summary";
  /** Which child continues the line through this node. null = no preference
   *  recorded (leaf, or story ends here on purpose). Must be a child's id. */
  activeChildId: string | null;
}

export const BOOKMARK_LABELS = ["", "Canon", "Alt", "Draft", "Discarded", "Summary"] as const;
export type BookmarkLabel = (typeof BOOKMARK_LABELS)[number];

export interface Bookmark {
  /** The bookmarked leaf. One bookmark per node. */
  nodeId: string;
  name: string;          // 1–80 chars trimmed
  label: BookmarkLabel;
  color: string;
  createdAt: string;
}

export interface Story {
  id: string; title: string; createdAt: string; updatedAt: string;
  origin?: StoryOrigin;          // unchanged (standalone-fork lineage)
  /** Flat, document order. Invariants: parent appears before child (acyclic
   *  by construction); sibling order = array order; ids unique. */
  nodes: StoryNode[];
  /** Root whose subtree the reader is on; null only when nodes is empty. */
  activeRootId: string | null;
  bookmarks: Bookmark[];
  /** Leaf ids of recently-read lines, most recent first, cap 5. */
  recentNodeIds: string[];
  facts: StoryFact[];            // unchanged
}
```

`HumanEditAttribution` keeps UTF-16 highlight ranges plus an optional positive
`deletedCharacters` count. The count uses grapheme characters, so one emoji or
combining sequence counts as one. Older stored attribution without the field
remains valid.

Deleted: `StoryPart.versions/activeVersion/versionAttributions`, `StoryBranch`,
`BRANCH_LABELS`, `MAX_VERSIONS`, `MAX_BRANCHES`, `PartVersionToken`,
`SelectVersionRequest`, `BranchRequest`, `DeletePartRequest`'s version fields.
`StoryPart` itself is replaced by `StoryNode` (grep for stragglers).
`StorySummary`: `branched`/`branchCount` → `forked: boolean` (any node with >1
children) and `lineCount: number` (leaf count).

### Line resolution (`shared/story-tree.ts`, replaces `story-lines.ts`)

The only tree math in the codebase; server and client both import it.

```ts
export function childrenOf(story, parentId: string | null): StoryNode[];   // array order
export function nodeById(story, id): StoryNode | null;
/** Active path: activeRootId, then follow activeChildId while valid.
 *  A dangling/invalid activeChildId fails closed at parse; at runtime stop. */
export function activePath(story): StoryNode[];
export function activeLeaf(story): StoryNode | null;                       // last of path
export function pathTo(story, nodeId): StoryNode[];                        // root→node, throws if unknown
export function subtreeIds(story, nodeId): string[];                       // node + descendants
export function takeIndex(story, nodeId): { index: number; count: number };// 1-based among siblings
/** Rollups for stubs, one O(n) walk: childCount, leafCount, lastTouched
 *  (max createdAt/updatedAt in subtree). */
export function computeRollups(story): Map<string, Rollup>;
/** Context for generation: path slice from the last role:"summary" node
 *  (inclusive) to the end — a summary resets model context. */
export function contextSlice(path: StoryNode[]): StoryNode[];
```

Switching lines (`switchToNode`): retarget every ancestor's `activeChildId`
down to the node, set `activeRootId`, then below the node follow existing
`activeChildId`s to a leaf (each subtree remembers where you last were).
Records the previous leaf in `recentNodeIds` (dedupe, cap 5).

### Mutation semantics (frozen)

- **New take (the only branching primitive).** Creating a node = choosing
  `parentId` (null = new take of Part 1). Covers: Continue at end of line
  (parent = active leaf), regenerate any part (parent = that part's parent;
  model prose), write-at-a-seam (parent = the part above the seam; typed prose,
  `human: true`), selection-branch (sibling of the selected part whose text is
  the cut prefix `text.slice(0, offset)`, attribution clipped). Creation always
  sets the parent chain's `activeChildId` to reach the new node (it becomes the
  active line's leaf) and stamps `genId` when model-generated.
- **In-place mutation** (id stable, `updatedAt` stamped): human edits (PATCH,
  inserted/replaced ranges plus removed-character count recorded), selection **rewrite** (model infill splices
  into the SAME node — mid-line rewrites must not truncate the line; not in the
  design's sibling list), empty-instruction Continue **append** into the active
  leaf, Stop-commit appends. Optimistic concurrency: `expectedTextHash` only
  (version count/index tokens are gone).
- **Regenerate ≠ replace.** The old `replaceLast` supersede is retired; the old
  take stays as a childless sibling ("regen drafts" in the design).
- **Delete = subtree.** Removing node X removes X and descendants, drops their
  bookmarks and recents entries. If X was on the active path: parent's
  `activeChildId` → next surviving sibling of X (by array order, else previous,
  else null). Deleting a root re-anchors `activeRootId` the same way. Guard:
  request carries `expectedSubtreeCount` (nodes incl. X); 409 on mismatch — the
  confirm the user saw must match what dies.
- **Summary take** = node with `role: "summary"`, created as a child of the
  part it condenses (offset cut allowed as today; the summarized prefix =
  `pathTo(parent)` + cut text). Same SSE flow + fingerprint guard as today
  (fingerprint hashes the path slice actually summarized). Old guards stay:
  no regenerate of summary nodes, no append into them; Continue after one
  starts a new node.
- **Bookmarks.** One per node; ≤1 with label Canon per story (setting Canon
  demotes the previous Canon bookmark to label ""). Creating a node under a
  bookmarked node that had NO children moves the bookmark to the new node
  (continuing a named line keeps its name; forking never moves it). Deleting a
  bookmarked node deletes the bookmark. Colors: rotate
  `["#4b45c9", "#2f9e6b", "#c98a2b", "#c53b30", "#8a4bc9", "#3b7bc9"]` by
  bookmark creation count; summary-labeled use teal `#0e9c8a`; canon renders
  gold `#e0a83c` (render-side).
- **genId dedup** scans ALL nodes (stop-commit vs stream-commit race, as
  today; the second writer no-ops).

### Storage — `StoryManifestV4` (`schemaVersion: 4`)

`StoredNodeV1`: `{ id, parentId, instruction, model, createdAt, preview?, words?,
updatedAt?, genId?, role?, human?, revisionId: ObjectHash, attribution?, activeChildId }` —
ONE revision per node (versions are siblings now). Manifest: V2 fields minus
`parts`, plus `nodes: StoredNodeV1[]`, `activeRootId`, `bookmarks:
StoredBookmarkV1[]`, `recentNodeIds`. `activeWordCount` = active path.

Fail-closed parse (`server/story-format-nodes.ts`, replaces
`story-format-branches.ts`): ids unique; `parentId` must reference an EARLIER
node in the array (topological order ⇒ acyclic) or be null; `activeChildId`
null or a child of that node; `activeRootId` null only when `nodes` empty, else
a root; bookmarks reference existing nodes, unique per node, ≤1 Canon, labels
from enum; `recentNodeIds` reference existing nodes, ≤5; attribution validated
against the single text as today.

**Migration (stored layer only — no prose hydration; revision ids move, texts
don't).** `parseManifest` accepts 2, 3, 4; serialize always writes 4.
V2/V3 → V4 conversion (pure function over the parsed V3 shape, own tests):

1. Base part with `revisionIds[k]` → k sibling nodes (order preserved = take
   order). The `activeRevision` node keeps the ORIGINAL part id and the
   children (next part's siblings hang off it, `activeChildId` chains the old
   active line); other versions get ids `${id}@v${i}`, are childless, and
   carry their `versionAttributions[i]` as `attribution`.
2. Branch with `forkOffset: null`: tail chains under the fork part's
   active-revision node (tail[0]'s siblings = fork part's other children).
   With `forkOffset` non-null: tail[0] (the cut copy) becomes a SIBLING of the
   fork part's takes (child of the previous part's active node; root sibling
   when the fork part was parts[0]).
3. Summary branches (`forkPartId: null`) → their tails chain as extra ROOTS
   (root siblings = takes of the beginning).
4. Each branch's final active node gets `{ name, label, color }`. An empty-tail
   branch, or a tailed branch after the final base part, gets a distinct
   endpoint so every old named ending and Main stay selectable. Empty branches
   at the root or first cut use a transitional empty node whose canonical
   empty-text revision is materialized on the first V4 save.
   `canon: true` is authoritative and becomes the
   sole Canon bookmark; stale `label: "Canon"` values on non-canon branches are
   cleared.
5. `activeBranchId` → `activeChildId` chain + `activeRootId` reproducing the
   old active line; null → the old base line. `recentNodeIds: []`.
6. Old `Main` line gets NO bookmark (unnamed lines have working names).

`story-codec.ts`: encode walks `story.nodes` in order (stable manifest ↔
runtime mapping). Saved previews/word counts let normal loads hydrate only the
active path and facts; switching hydrates the selected remembered path before
save/response. Unchanged hidden revisions reuse their manifest ids without
reading prose. GC liveRevisionIds = every node revision + fact revisions (all
takes stay live).

### Wire contract — the lazy-loading shape

`GET /api/stories/:id` (and every mutation) returns a `StoryPayload`, not the
raw Story:

```ts
export interface NodeStub {
  id: string; parentId: string | null;
  preview: string;            // first ~100 chars of text
  words: number;              // word count of this node's text
  childCount: number; leafCount: number; lastTouched: string;
  human?: true; role?: "summary"; hasInstruction: boolean;
  activeChildId: string | null;
}
export interface StoryPayload {
  id: string; title: string; createdAt: string; updatedAt: string;
  origin?: StoryOrigin;
  nodes: NodeStub[];          // whole tree, stubs only, document order
  path: StoryNode[];          // FULL nodes (prose) for the active path only
  activeRootId: string | null;
  bookmarks: Bookmark[]; recentNodeIds: string[]; facts: StoryFact[];
}
```

Column and server hydration cost are O(active path) prose; peek/map/minimap/
lines-menu read manifest-backed stubs already on the client. Prose loads on
switch (the switch response carries the new path). **Deliberate deviations from
the design's lazy contract, flagged for the PR:** all stubs ship with the story
(per-node lazy child fetch is deferred until stub counts hurt), and rollups are
recomputed in one O(n) walk per response rather than maintained O(depth) on
write. Client tree indexes are built once per payload. Take peek
virtualizes after 50 siblings; the lines menu and map page large groups; the
map progressively reveals long spines; and very deep active paths collapse
older prose behind locally expandable stubs. Active continuations repeated
inside a map fork use a fixed 12-head/13-tail window, and Mini Loom memoizes its
fork-wide derivations. The Story Map itself is memo-stable across stream ticks
and computes the largest fork in one linear pass. Story listing reads at most
four manifests concurrently. Every user-visible behavior in the acceptance
checklist still holds without rendering an unbounded DOM.

### API (all under `/api/stories/:id`; mutations under the store lock; every
non-SSE mutation returns `StoryPayload`)

- `POST /switch` `{ nodeId, stopAtNode? }` — switch the line (any node;
  leaf-completion via remembered `activeChildId`s). Undo sets `stopAtNode` to
  restore a formerly terminal node even if it gained a child. Updates recents.
  Summary activation additionally
  supplies `expectedLineFingerprint` (title plus every active node id/text) for
  its atomic no-steal guard.
- `POST /nodes` `{ parentId?: string | null, appendTo?: string, text,
  instruction?, genId? }` — direct text commit, 201. Without `genId`: a human
  take (armed-pen Write; `human: true`). With `genId`: the Stop-commit of a
  streamed generation (model attribution via the in-flight generation map;
  genId dedup; `appendTo` carries `expectedTextHash`). Replaces the old
  stop-save `POST /parts`.
- `PATCH /nodes/:nodeId` `{ text?, instruction?, expectedTextHash }` — in-place
  human edit. Deletion-only edits show `human edit · −N chars`; mixed edits put
  their removal count in the badge tooltip.
- `DELETE /nodes/:nodeId` `{ expectedSubtreeCount }` — subtree delete.
- `POST /prune-unused-takes` `{ expectedStoryRevision, expectedTakeCount,
  expectedPartCount }` — atomic cleanup of
  abandoned leaf takes. Preserves continuations, bookmarked root-to-leaf
  lines, single-take seams, and one leaf per fork; rejects a stale preview.
- `PUT /bookmarks/:nodeId` `{ name, label }` — create/update (color assigned
  server-side on create). `DELETE /bookmarks/:nodeId`.
- `POST /continue` (SSE, reworked): `{ instruction?, genId, parentId?: string
  | null, appendTo?: string }`. Exactly one of: `parentId` present → new model
  take under it (regenerate/fork/continue-new-part; `parentId` omitted defaults
  to the active leaf = today's continue); `appendTo` → append into that node
  (must be the active leaf, not summary, with `expectedTextHash`). `done`
  carries the payload.
- `POST /nodes/:nodeId/rewrite` (SSE): unchanged infill contract; commits
  IN PLACE (rewriting a summary node stays allowed — docs/summary-branches.md).
- `POST /nodes/:nodeId/take-from-cut` `{ offset, expected? }` — the selection
  branch: sibling of the target whose text is the cut prefix (trimmed end,
  attribution clipped, instruction/model/role copied). 201.
- **Retarget rule:** creating a node activates it ONLY when its parent is on
  the active path at commit time (or it is a root take). Otherwise (reader
  switched lines mid-stream) the take is inserted silently as a non-active
  sibling and the bookmark-advance rule is skipped. Retargeting that changes
  the leaf records the previous leaf in recents, like a switch.
- Summary streaming is the exception: the server always inserts the completed
  summary without retargeting. The client switches explicitly only while still
  on the unchanged launch line with no competing generation.
- `POST /summary-take` (SSE, replaces /branch-summary): `{ nodeId, offset?,
  expected? }` → summary node child of `nodeId`; `done` carries `{ nodeId }`.
- `POST /autoname`, `GET /export`, facts routes: operate on the active path;
  otherwise unchanged.
- **Removed:** `/branch`, `/branches*` (all), `/branch-summary`,
  `/parts/:partId/version`, and the whole `/parts*` family (superseded by
  `/nodes*`). `reconstruct-branches.ts` + its test are deleted
  (its V3 outputs now migrate to V4 on load; grafting old standalone forks
  into trees is future work, trigger: real data that needs it).

## UX spec (fidelity to DESIGN_SPEC.md §3; tokens §4; copy contract §2/§3 of
IMPLEMENTATION_PROMPT.md — retired words never appear in UI copy)

- **Header**: title + `N PARTS · X,XXX WORDS IN THIS STORYLINE` stats; **line chip**
  always visible (★/color dot per bookmark label, name or italic working name
  derived from the leaf's first ~6 words, `TAKE n/N` of the leaf, caret).
  Chip opens the **Lines menu**: NAMED (bookmarks w/ label chip + stub meta) /
  UNNAMED (working names; sibling groups of childless unnamed non-active takes
  roll up as "+ N regen drafts") / RECENT (from `recentNodeIds`, cap 5).
  Footer: "Every leaf is a line with a working name. Naming is optional."
  **Map** button. **Mini-loom toggle** (icon, accent when on).
- **Part cards**: a quiet mono `PART n` marker stays visible at the left of the
  tool rail, matching Map ordinals; collapsed stubs keep the same marker.
- **Fork signal** between parts wherever the upper part has >1 child:
  thread-split glyph (2 strands at 2 takes; fan + mono count at many),
  `rgba(accent,.5)` idle → accent on hover; click opens the take peek.
  Every seam with following prose also exposes `✎ WRITE HERE` (mono 8px,
  hover-only with zero layout footprint on a linear story) so the first sibling
  can be authored before a fork exists. Armed:
  full-width accentSoft band, "PEN HERE — WRITING FORKS (SIBLING OF N TAKES) ·
  ESC OR CLICK AGAIN TO CANCEL". Ship `threads` only (ticks/pill variants cut —
  deviation, flagged).
- **Take stepper** in the tools row of any part whose parent has >1 child:
  `‹ n/N ›` — arrows switch takes directly; the count opens the peek. Arrow
  hover tooltip from the incoming take's stub: first line + `3 PARTS BELOW ·
  YESTERDAY` or amber `NO CONTINUATION — STORY WOULD END HERE`. No prose loads
  on hover.
- **Take peek** (popover ~360px): header `N TAKES — WHAT FOLLOWS PART k`; one
  row per take: `TAKE n/N` (+ `— READING`), label chip (bookmark labels found
  at/below), canon star when a Canon leaf is below, 2-line snippet (stub
  preview), meta (`3 PARTS · 412 WORDS BELOW` / amber ends-here), age.
  Active row accentSoft + inset accent bar. Footer: `+ New take — moves the
  pen` (arms the pen at this seam) · `STUBS ONLY — PROSE LOADS ON SWITCH`.
- **Switching** (stepper, peek row, lines menu, map row, minimap tip): every
  switch fires a dark toast `Now on: {line name} — N parts follow.` /
  `— the story ends after Part k.` + `Back to {prev}` + dismiss. Undo =
  switch back. History client-side cap 5.
- **Composer & pen**: PEN chip always states the target — default
  `→ END OF THIS LINE — PART {k+1}`; armed `→ AFTER PART k — WRITING FORKS
  (SIBLING OF N TAKES)`. Button **Continue** (model, end of line) ↔ **Write**
  (armed; POST /nodes, silent fork, undoable toast, human chip). Esc or second
  click disarms. Empty take (leaf, no children): tombstone `THE STORY ENDS
  HERE`; placeholder "Continue — writes the first part of this take…".
- **Story map** (overlay ~640px): spine of active-path parts → at each fork a
  header (`N TAKES OF WHAT FOLLOWS`) → take rows (dot, idx, chip, star,
  snippet, meta; hover actions **flag** = bookmark leaf-below w/ default label
  Draft, **prune** = inline red proportionate confirm — never on the active
  take) → active take's children as sub-rows with `YOU ARE HERE` pill on the
  leaf → childless unnamed takes collapsed as `▸ N regenerated takes — all
  empty` (expand renders their rows). Any row click switches, closes, toasts.
  Footer states the lazy contract.
- **Bookmarks**: unbookmarked leaf end cap: hairline + `⚑ Name this storyline` →
  popover (name input, placeholder = working name; label chips Canon/Alt/
  Draft; Save). Bookmarked leaf shows its chip at the end cap.
- **Mini-loom** (flag `1667.miniloom` in localStorage, default OFF):
  corner widget above the composer — schematic threads (trunk → forks → one
  thread per named/authored take, length ∝ parts below, gold canon, teal
  summary, dashed regen bundles), active thread bold. Click → panel with
  clickable thread-tip chips (switch + toast). Footer `SCHEMATIC — FORKS ONLY,
  O(FORKS)`. Never aligned to prose scroll.
- **Deletes** (part tools + map prune): confirm counts the subtree — "Delete
  this take and the N parts beneath it? N+1 parts total, gone for good."
- **Human-edit highlight** and instruction chips: unchanged. Summary nodes:
  teal recap card (new `--summary`/`--summary-soft` tokens in every palette),
  existing guardrails (badge, no regenerate, Continue starts a new node).
- **Summary take launchers** (carried 1:1 from docs/summary-branches.md): the
  per-part tools icon on every non-summary part (through that part) and the
  selection popover (through the highlighted prose, offset+expected). Old
  streaming flow preserved: one at a time, header status chip + Cancel, prefix
  locks, completion switches only if still on the source story and idle.
- **Sidebar**: `⑂ N` chip when `lineCount > 1`.
- **A linear story renders with ZERO fork chrome — pixel-identical to today.**

## LOC budget

Deletions: BranchSwitcher (102) + BranchesPanel (165) + use-branches (206) +
story-branch (250) + reconstruct-branches (248) + version UI/plumbing. Rough
net: shared +200, server ±0, web +700, CSS +400. Repo lands ≈ 8.5–9k TS —
within the ~10k budget proposed in plans/README.md. Modules stay < 500 LOC
(StoryView splits: seams/peek/map/minimap are separate files).

## Commands

```sh
npm run typecheck   # tsc over server+shared+web
npm test            # node test runner (server+shared)
npm run dev         # server on AI_1667_PORT (default 7373) + vite
```

Dev data dir is per-worktree (`AI_1667_DATA` → `<repo>/data`); provider
dry-run — everything must work end-to-end against it.

## Steps

### Step 1 — shared model + tree math (additive, repo fully green)

`shared/types.ts` (new types ADDED alongside old; nothing removed yet),
`shared/story-tree.ts` (full helper set incl. switchToNode/computeRollups/
contextSlice + pure V3→V4-shape converter helpers if they live shared),
`test/story-tree.test.ts` (path math, take indices, rollups, switch semantics,
subtree ops, context slice at summaries, edge: empty story, single line,
30-sibling forks). Gate: typecheck + all tests green, zero behavior change.

### Step 2 — server core (server/shared green; `web/src` MAY be red — list
every red file in the report)

Format V4 + migration (`story-format.ts`, new `story-format-nodes.ts`, delete
`story-format-branches.ts`), codec + snapshot single-revision rework, store
(`stories.ts`: summaries via active path, GC over node revisions),
`story-parts.ts` → `story-nodes.ts` (create/append/edit/delete helpers),
delete `story-branch.ts` + `reconstruct-branches.ts` (+ test), summary-take
(`branch-summary.ts` → `summary-take.ts`), generation prompts (contextSlice,
path-based), generation-http (continue/appendTo/parentId modes, rewrite
in-place, summary-take), `index.ts` routes (switch/nodes/bookmarks/payload),
export/autoname on path, payload builder (`server/story-payload.ts`).
Old shared types removed HERE. Tests reworked + new: format V4 fail-closed
matrix, migration fixtures (versions→siblings incl. attributions; offset/null
branch tails; summary branches→roots; canon normalization; empty/final-tail
boundary clones; active line reproduction), lazy/full codec round-trip, store CRUD/GC keeps
sibling revisions after delete elsewhere, generation modes + genId dedup +
stop-save, rewrite in place, summary fingerprint, bookmark rules (canon
exclusivity, advance-on-append, delete-with-node), switch + recents, subtree
delete + re-anchor + count guard. Gate: `npm test` + `tsc` green outside
`web/src`.

### Step 3 — web (repo fully green)

`api.ts` (payload + new endpoints), `use-loom.ts` (replaces use-branches:
payload state, switch+toast+undo, pen state, history), `App.tsx` (payload
plumbing, generation targets), `StoryView.tsx` (path rendering, seams, stats,
tombstone, end cap), `PartCard.tsx` (stepper, human chip, teal summary card,
subtree delete confirm), new `LineChip.tsx` (+ Lines menu), `ForkSeam.tsx`,
`TakePeek.tsx`, `StoryMap.tsx`, `BookmarkPopover.tsx`, `Toast.tsx`,
`MiniLoom.tsx`; delete BranchSwitcher/BranchesPanel/use-branches; CSS (tokens
`--summary`/`--summary-soft` in all 4 palettes × light/dark, seam glyph, peek,
map, toast, chips, tombstone, pen band, mini-loom). Gate: typecheck + tests
green; every file < 500 LOC.

### Step 4 — gate & closeout

Docs (`docs/summary-branches.md` → summary takes; CHANGELOG; plans/README row),
full typecheck/tests, browser smoke against dry-run per the acceptance
checklist below, /autoreview + thermo-nuclear review + fixes, PR.

## Acceptance checklist (from IMPLEMENTATION_PROMPT.md §8 — verified in Step 4)

1. Linear story: zero fork chrome, pixel-identical to today.
2. 31-sibling fork: stepper n/31; peek scrolls 31 stub rows without prose;
   switching to an empty take shows tombstone + composer retarget.
3. Arrow hover shows incoming stub incl. amber ends-here; no prose on hover.
4. Every switch → undo toast; recents appear in the Lines menu.
5. Header chip always names the line; unnamed leaves show italic working names.
6. WRITE HERE → pen chip updates → submit forks silently with undo; human chip
   on the new take.
7. Map: jump / flag / prune with proportionate confirm; regens stay collapsed.
8. Deleting any part warns with exact subtree counts.
9. Rollups stay correct after write, fork, prune (stubs refresh per response).
10. Minimap flag OFF by default; ON renders O(forks) schematic, clickable tips.

Plus: V3 bundle on disk (incl. offset, empty, summary, and canon branches plus
versions) loads, reproduces every old line, and re-saves as V4; V2 and legacy
`.json` still load.

## STOP conditions (Codex)

- Any change pushing a file past 500 LOC.
- Spec ambiguity or conflict with existing behavior/tests.
- Work outside the step's file list.
- Existing tests needing semantic changes the spec didn't predict.

## Non-goals

Fork-signal `ticks`/`pill` variants; per-node lazy child-stub fetch; O(depth)
persistent rollups; ghost-prose hover; prose-aligned rail; zoomable loom
space; coach marks; auto-pruning regens; chapters
(Plan 005); grafting old standalone forks into trees.

## Open-question calls (DECISIONS.md §Open, decided here, Chris can veto on PR)

1. Thread-glyph coach mark: none.
2. Continue always writes at end of line (PEN chip is the mitigation).
3. Canon: exactly one per story.
4. Regen retention: keep forever.

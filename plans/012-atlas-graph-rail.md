# Plan 012: Atlas round two — graph rail, mass sort, and the keys modal

Written 2026-07-21 on branch `atlas-graph`. Design handoff:
`docs/design/design_handoff_1667_tui/` (the version committed on this branch —
turns 4–9). Grids **9a**, **9c**, **9e** in `1667 TUI.dc.html` are the visual
ground truth; `DESIGN_SPEC.md` §4 (Atlas paragraph), §6, §7 and `DECISIONS.md`
§9 are normative prose.

## Status

TODO — frozen spec, ready for implementation.

## Why

The atlas shipped in plan 011 renders grid **6a**: depth runs left→right, runs
collapse to `──n──`. The design's round two (doc turn 9) rejects that as the
default for one reason: a left→right map runs out of **width**, the one axis a
terminal does not have. Grid **9a** replaces it with a git-log-style tree that
flows top→**down** — the direction a terminal scrolls without limit. 214 parts
or 40 forks make a longer page, never a wall.

Two smaller pieces land with it: **9c**, a word-count bar chart reachable as a
sort inside the atlas (answers "which line is real and which is a stub", which
no topology view can), and **9e**, the keys modal reorganised from ten
overlapping groups into six ordered by the arc of a session.

## Scope

**In:**

1. Atlas tree rendering switches from the 6a weave to the 9a graph rail.
2. `s` cycles the atlas through graph → mass·size → mass·recency → mass·name.
3. The keys modal is regrouped per 9e.
4. Tests, 80×24 degradation, demo-fixture touch-ups for the above.

**Out — do not build, do not scaffold, do not leave hooks for:**

- Grid **9b** (warp / thread-per-line). Metaphor demo only, per DECISIONS §9.
- Grid **9d** (fisheye split). A separate post-POC *mode*, not an atlas zoom
  level. Explicitly out of the POC per IMPLEMENTATION_PROMPT's checklist.
- Turn **8** (READ mode, galley/folio/proof-pass, `m`/`n` marks). Not written
  into DESIGN_SPEC.md; deferred to its own plan by decision 2026-07-21.
- Server changes, `shared/` changes, new dependencies, mouse support in the
  atlas, changes to the map/loom, story view, facts rail, or themes.

## 1 · The 6a weave is replaced, not kept

Delete the left→right row rendering. Do **not** ship it as a third sort, a
config flag, or dead code. Decided 2026-07-21: DECISIONS §9 says 6a is
"superseded ... kept in the doc for rationale, not shipped."

**What survives untouched** — `tui/src/atlas-layout.ts`'s *derivation* is
correct and hardened by four review rounds. Keep, and do not re-derive:

- segment walk + run-collapse (`SegmentNode`, the single-child chain rule),
- line-vs-sketch classification (incl. the bookmark and `insideOpened` rules),
- cold-fold at 21 days, and "never cold-fold the active line",
- `createLoomIndex` reuse, the `activeEnd` row rule, leaf/fork/part rollups,
- the cursor set, `openedColdFolds`, `showSketches`, row budget/scroll.

**What changes** — how those visual nodes become rows: `AtlasRow.tree` (the
pre-rendered weave string), the anchor/`cutColumn` trunk-windowing machinery,
`gutterWidth`/`┄` leaders, and `screens/atlas.ts`'s row painter.

Trunk windowing (`maxTreeWidth`, `windowed`, the `‹ ¶1–n` stub, the `cutColumn`
logic and its tests) exists **only** because the weave ran out of width. The
graph rail cannot: width grows with rails live at once, "rarely past 4–5"
(9a caption). Delete it. If a pathological tree still overflows, truncate the
label, never the rails.

## 2 · The graph rail (grid 9a)

```
  ┏━ atlas · graph ━ depth flows down · scrolls past the fold ━ j/k row · l follow · enter reroutes ━━
  ┃
  ┃  ● ¶1   the rain came in off the harbor sideways
  ┃  │
  ┃  │   ·· 9 parts
  ┃  ├─● ¶10  he set the brass compass on the bar       fork ×3
  ┃  │ │
  ┃  │ │   ·· 12 parts
  ┃  ├─● ¶23  the storm leaned on the shutters          fork ×2
  ┃  │ │ │
  ┃  ◉ │ │ ¶99  ⚑ canon-storm           31,204 w  ‹ you
  ┃  │ └─○ ¶74  the long thaw            22,861 w
  ┃  └── ▸ ×3 lines · cold 2–3 wks
  ┃
  ┃  + 23 sketches folded · a reveals
```

### 2.1 Rail model (normative — this rule set wins over pixel-matching)

A **rail** is a branch that has been opened and not yet terminated. Rails are a
left-to-right list; rail `k` occupies character columns `2k` and `2k+1` of the
tree field.

Walk the visual tree depth-first. At every fork, order children exactly as
`atlas-layout.ts` already orders them: the **current-line child first**, then
the other line-heads, then cold folds, then sketches.

1. **First child continues its parent's rail.** This is the git-log
   "first-parent" rule and it is what pins the trunk left: the current line
   holds rail 0 from the root to `◉ you`.
2. **Every additional child opens the next free rail to the right.**
3. **A rail dies when its branch terminates** (a leaf row, a cold-fold row, or
   the last sketch of a group). Rails to its right **compact left** on the
   following row — this is why `◉` at rail 0 is followed by rows whose rails
   have shifted in.
4. Width = the high-water mark of live rails, not the depth of the tree.

### 2.2 Row kinds

| Kind | Shape | Notes |
|---|---|---|
| node | `{rails}{connector}{glyph} ¶{n}  {label}{meta}` | root, fork anchor, or leaf |
| run | `{rails}   ·· {n} parts` | the collapsed forkless chain, dim |
| spacer | `{rails}` | one row of bare rails between a node row and the run row under it |
| cold | `{rails}└── ▸ ×{n} lines · cold {a}–{b} wks` | terminates its rail |
| sketch | `{rails}⌇ ○ ¶{n}  "{first words}‥"` | only when `a` has revealed them |

- `{rails}` = for each live rail left of this row's own rail, `│` then a space.
- `{connector}` = nothing when the node continues its parent's rail; `├─` when
  the fork it hangs off has more children to come; `└─` when it is the last.
  The connector is drawn from the rail the branch forks off, so a node one rail
  right of its fork reads `├─●` — exactly as 9a draws it.
- `{glyph}` = `◉` the current line's terminus (`you`), `●` a node on the
  current line or a fork anchor, `○` an off-line leaf, `◌` a streaming leaf.
- `{meta}` = right-hand field: `fork ×{n}` on fork anchors (chrome); on line
  leaves the label gutter — bookmark badge `⚑ {name}` or `unnamed · {d mon}`,
  then `{n,nnn} w` right-aligned; `‹ you` (chrome) trails the current leaf.
- The `·· {n} parts` run row replaces 6a's `──n──`. Same arithmetic:
  `n = depth(terminus) − depth(anchor)`; **omit the run row entirely when
  `n === 0`** (9a has no zero-length runs; a `·· 0 parts` row is noise).
- Emit the spacer row only when a run row follows. Two node rows in sequence
  get no spacer.

### 2.3 Colour (existing `DisplayRole`s only — no new palette entries)

- Current line's rails, its `●`/`◉`, its `¶n`, and its connectors:
  `accent · deep` (`focus / accent` for the `◉` row's `¶n`, as 9a lights the
  current leaf brighter than the trunk above it).
- Off-line rails and connectors: `chrome`, one step down — reuse the dim rail
  treatment already in `screens/atlas.ts`.
- Fork-anchor preview text: `summary`. Off-line labels: `prose · dim`.
  Cursor row's label: `prose`. Counts, `fork ×n`, `‹ you`, `·· n parts`:
  `chrome`. Bookmark badges keep their `bookmark · *` roles.

### 2.4 Keys (atlas)

| Key | Action |
|---|---|
| `j` / `k` / ↑ ↓ | move the cursor between rows |
| `l` | **follow a rail** — jump the cursor to the next row belonging to the rail under the cursor; on a cold-fold row, open the fold (fold wins) |
| `h` | move the cursor to the row this branch forked off |
| `a` | toggle sketch reveal |
| `s` | cycle sort — see §3 |
| `Enter` | reroute through the cursor row's leaf (reuse the existing reroute path in `story-actions.ts`; do not write a second one) |
| `Esc` | back to the map, not the page |

`h`/`l` now have real, non-lying meanings — 9a's hint reads `j/k row · l follow`.
This retires plan 011's documented deviation ("`h` is unbound in the atlas").

Panel hint line: `j/k row · l follows a rail · a sketches · s by size · enter reroutes · esc back`.

### 2.5 Title

Unchanged from plan 011 except the mode word, per 9a's `atlas · graph`:

```
┏━ atlas · graph ━ {lines} lines · {parts} parts · {forks} forks ━ {hot} hot · {cold} folded cold ━━
┏━ atlas · graph ━ {lines} lines + {n} sketches revealed ━ a hides ━━
```

## 3 · Mass sort (grid 9c)

```
  ┏━ atlas · mass ━ bar width = words ━ where the weight sits ━ s re-sorts · enter reroutes ━━
  ┃
  ┃  trunk ¶1–10    ████████          8.1k · shared
  ┃
  ┃  ⚑ canon-storm  ██████████████████████████████████ ◉ 31.2k
  ┃    the long thaw █████████████████████████          22.9k
  ┃  ⚑ ashe confess ███████████████████                17.0k
  ┃    maren leaves  ██████████                         9.4k
  ┃    unnamed·12jun ████████                           8.1k
  ┃
  ┃    23 sketches   ▏▏▏                                <1k ea · a reveals
```

- Not a tree. One row per **line** (the same line-heads the graph derives), no
  rails, no connectors, structure deliberately discarded.
- Row: label gutter (bookmark badge or `unnamed · {d mon}`, truncated to a
  fixed width) · `█` bar · `◉` on the current line's row · word count in `k`
  form to one decimal at or above a thousand (`31.2k`, `9.4k`), and the **exact
  count** below it (`307 w`).

  **Amended 2026-07-21, after seeing it render.** This line originally said
  `<1k` under a thousand, copying 9c's sketch-footer wording. That is wrong for
  line rows: any story younger than the mockup's 31k-word fixture renders every
  line as `<1k`, which erases the single question this view exists to answer —
  which line is real and which is a stub. `<1k ea` stays on the sketch footer,
  where 9c actually uses it and where the point is that sketches are all
  negligible.
- Bar width ∝ `words`, scaled so the largest line fills the available field.
  Minimum one cell for a non-zero line.
- **Shared trunk drawn once on top**: a `trunk ¶1–{n}` row for the parts before
  the first fork, `{words} · shared`, then a blank row.
- Sketches collapse to one footer row: `{n} sketches  ▏▏▏  <1k ea · a reveals`
  (`▏` per sketch, capped at the field width). `a` reveals them as ordinary
  rows below the lines, dim.
- `Enter` on a row reroutes, same path as the graph. `j`/`k` move. `l` and `h`
  do nothing here.
- Works at 80×24 with no special-casing — shrink the bar field, keep the label
  and the count.

**`s` cycles the atlas:** `graph → mass · by size → mass · by recency →
mass · by name → graph`. The title names the current one
(`atlas · graph`, `atlas · mass · by size`, `… · by recency`, `… · by name`).
The sort applies to the line rows; the trunk row and the sketch footer keep
their positions. Sort state is per-overlay-open, not persisted.

Rationale for one key doing both jobs: DESIGN_SPEC §4 calls mass "`s` re-sorts
into the mass view", DECISIONS §9 calls it "a sort *within* the atlas, not a
rival view", and 9c's own hint reads `s re-sorts`. One key, four stops.

## 4 · The keys modal (grid 9e)

```
  ┏━ keys ━ grouped by what you're doing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ┃
  ┃   MOVE     j/k ↑/↓ focus  h/l ←/→ takes  g/G top/leaf  ^d/^u scroll  u undo
  ┃
  ┃   WRITE    enter continue  i direct  r retake  w write  e $EDITOR
  ┃           · composing: enter send  ⇧enter newline  ↑/↓ history  esc back
  ┃
  ┃   SHAPE    b bookmark  C end chapter  [ ] chapter jumps  d prune  y/Y copy part/line
  ┃
  ┃   OPEN     t map  o library  f facts  c chapters  p directions  : commands  , settings  ? keys
  ┃
  ┃   IN A     j/k move  h/l walk  enter apply/jump/reroute  / filter  esc close one layer
  ┃   PANEL    · chapters also: s summarize  e rename  n break  d remove
  ┃
  ┃   MOUSE    click focuses  click again runs  right-click part menu  wheel scrolls
  ┃
  ┗━ arrows ≡ vi keys · q quit ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Replaces the ten groups in `renderKeysOverlay` (`tui/src/screens/overlay.ts`).

**Take from 9e:** the six groups, their order, the label gutter (fixed-width
left column so the eye lands on the group name), the sub-lines under WRITE and
IN A PANEL, the footer wording.

**Do not take 9e's key letters where they disagree with the shipped app.** The
modal must be true. Reconcile against `tui/src/keys.ts` — the mockup predates
the loom→map rename, so `t map` is wrong (`m` opens the map). Known
corrections, but verify every token against `keys.ts` rather than trusting this
list:

- OPEN: `m` map, not `t`. Add **`T` atlas** — the atlas is missing from the
  current modal entirely, which is a real bug this plan fixes.
- OPEN: `:` and `/` both open commands today; `F` toggles the facts rail
  (currently filed under VIEW) — put it in OPEN.
- IN A PANEL: add the atlas's own verbs as a second sub-line —
  `· atlas also: s by size  a sketches  l follows a rail`.
- MOUSE: right-click opens the part menu, also on `x`.

Every key is one accent-coloured token, label gutter in accent, keys in `prose`.

**80×24:** drop the two sub-lines (they live in those panels' own footers) —
the six group rows survive. Wrapping already exists; keep it.

## 5 · Demo fixture

`tui/src/demo.ts` already spreads `lastTouched` for cold folds and carries
sketches (plan 011). Extend minimally so the graph rail and mass view are
demoable: at least **three live rails at once** (a fork whose off-line child
itself forks) and lines with clearly unequal word counts so the mass bars are
not all the same length. Surgical only — existing story-view and map goldens
must not move.

## 6 · Constraints (hard)

- No new dependencies. No server changes. No `shared/` changes.
- Every file stays under 500 LOC. `screens/atlas.ts` is the only place tree
  painting lives; `atlas-layout.ts` stays pure (no I/O, no OpenTUI imports).
  If mass rendering pushes `screens/atlas.ts` past ~250 LOC, split it into
  `screens/atlas-mass.ts` rather than growing one file.
- Net LOC should be roughly flat: the weave renderer and the whole trunk-
  windowing path come out as the rail renderer and mass view go in. If the diff
  is ballooning past ~+400 net, **stop and report** — this repo has an explicit
  anti-complexity guardrail.
- No abstractions this plan did not name. No defensive `try`/`catch`. No
  config flags, no feature toggles, no "keep the old renderer just in case".
- Match the surrounding idiom exactly: pure model + render split, the existing
  comment density, naming, and test style.
- Do not touch the map/loom, story view, facts rail, themes, chapters, or
  console commands.

## 7 · Tests (bun, `tui/test/`)

1. `atlas-layout.test.ts` — rewrite the rendering assertions, keep the
   derivation ones. New: rail assignment (first child keeps the parent's rail;
   each extra child opens the next rail), rail compaction after a branch
   terminates, high-water rail count, run rows omitted at `n === 0`, spacer
   emission.
2. Mass view — ordering under all three sorts, bar scaling against the largest
   line, the trunk row's word count, `<1k` formatting, the sketch footer.
3. Golden frames — atlas graph at 120×36 and 80×24; atlas mass at 120×36.
   **Do not hardcode expected numbers that the fixture also computes** — assert
   against values derived from the fixture, or the golden tests are tautologies.
4. Keys — `T` from NAV enters, `t`/`m` from the map enters, `Esc` returns to
   the map (not the page), `a` toggles, `s` cycles all four stops and wraps,
   `l` follows a rail and opens a cold fold, `h` walks back to the fork.
5. Keys modal — six groups present in order; every key token in the modal
   resolves to a real action in `keys.ts` (a table-driven test that fails when
   the modal drifts from the bindings is the point of this one).
6. A reroute test proving `Enter` from both graph and mass goes through the
   existing reroute path and preserves remembered continuations.

## 8 · Proof required

`cd tui && bun test` all green · `cd tui && npx tsc --noEmit` clean · root
`npm run typecheck` clean · root `npm test` still green. Report files changed,
net LOC, and pasted test output.

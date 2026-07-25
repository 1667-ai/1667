# Plan 011: Atlas — the whole-tree zoom-out for 1667

Written 2026-07-20 on branch `atlas` (merged from `cli`). Design handoff:
`docs/design/design_handoff_1667_tui 3` (that snapshot folder has since been
pruned — read it from git history, or `docs/design/design_handoff_1667_tui`
for the current package) — the delta from handoff 2 is exactly
this feature. Grids 6a / 7a / 7b in `1667 TUI.dc.html` are the visual ground
truth; `DESIGN_SPEC.md` §4 (Atlas paragraph), §6, §7 are normative.

## Status

IMPLEMENTED on branch `atlas` 2026-07-20 — four review rounds (two independent
reviewers per round), user test pending.

### Deviations from this spec, and why

- **Trunk panning with `h`/`l` was cut.** §4 wants the leftmost run to collapse
  into a `‹ ¶1–n` stub with `h/l` sliding the window. The elision ships and
  works; the *sliding* does not, and cannot as specified: every row's cut is
  floored at the earliest anchor that still fits its right-hand suffix, because
  an earlier cut drops the leaf end — including `◉ you`. Revealing the trunk and
  preserving the terminus are mutually exclusive at a fixed width. Round 2 shipped
  a version that amputated the terminus and it was rightly rejected, so the
  terminus wins and the stub names what was dropped instead. `h` is unbound in
  the atlas and the hint no longer offers it. Revisit only if the hidden trunk
  turns out to matter in practice — a deliberate pan that trades the leaf end
  away is defensible, but it needs its own design, not a clamp change.
- **Cursor preview uses the leaf's opening, not its last line** (§4). Off-line
  leaves reach the client as `NodeStub`s carrying `preview`; the tail is not in
  the payload and fetching per cursor move would put a round-trip on `j`/`k`.
- **The `▸` cursor on sketch and cold rows sits at the panel's left margin**,
  where grid 7b puts it immediately before the fragment. Unambiguous; polish.
- **80×24 geometry is not strictly "unchanged"** (§6). Rows cut at different
  depths render a plain `─` run instead of `└`/`├`, because sharing a connector
  column would assert a sibling relationship that does not exist.
- **A root that is its own terminus prints no run.** The `n === 0` rule above
  would give `¶1 ───── ◉ 1`, a separator between ¶1 and itself. It renders
  `¶1 ◉ 1`, and when that root is a fork, just `¶1 ─┬─…` — repeating the depth
  after the ¶ marker read as a typo (`¶1 1 ─┬─…`).

### Reviewed and rejected

- **Giving bookmarked mid-chain nodes their own row.** Raised twice: a
  bookmarked node with `activeChildId: null` and a surviving inactive child is
  collapsed into its run, so its label is not shown and it cannot be selected.
  Rejected — run-collapse is the entire point of this view ("size grows with
  forks, not parts"), and a row per bookmark would let a heavily bookmarked
  story grow unbounded, which is what the sketch fold and cold fold exist to
  prevent. The existing map (`loom-layout.ts`) already shows bookmark badges
  only on childless nodes, so this matches shipped behaviour rather than
  diverging from it. Bookmarks on line *ends* — what the design's label gutter
  is about — work. Revisit if a real story loses a bookmark that mattered.

## Why

The story map (`t`, internally `LOOM` mode) is one-line-deep by design: rows
are the current line's parts, other lines exist only as sibling stubs. The
missing level is the zoom-out — every line at once. The atlas is that view:
depth runs left→right, runs of forkless parts collapse, so **size grows with
forks, not parts**. A 200-part story with 3 forks is four rows.

## Scope

In: a new `ATLAS` overlay — derivation model, rendering, keys, 80×24
degradation, tests. Out: server changes, new dependencies, mouse support,
theming work, any change to the existing map/loom behaviour.

## Entry and exit

- `T` (shift+t) from NAV opens the atlas directly.
- `t` (or `m`) inside the map zooms out to the atlas.
- `Esc` from the atlas steps back into the map — **not** to the page. A second
  `Esc` closes the map. Esc peels exactly one layer, as everywhere else.
- Mode block reads `ATLAS`. Status bar otherwise unchanged.

## Derivation model (`tui/src/atlas-layout.ts`, pure)

Mirror `loom-layout.ts`: a pure function over `StoryPayload` returning a
render-ready layout. No I/O, no rendering, no OpenTUI imports. Use
`createLoomIndex(payload)` from `shared/loom-model.ts` — it is memoized per
payload and already gives `depthByNodeId`, `subtreeCountByNodeId`,
`bookmarkByNodeId`, `bookmarkBelowByNodeId`. Do not rebuild the tree.

### Segments and run-collapse

Walk the tree into **segments**. A segment starts at an anchor and runs down
the single-child chain until it hits a node that is a **fork**
(`childCount >= 2`) or a **leaf** (`childCount === 0`). That end node is the
segment's terminus.

- Trunk's first segment anchors at the root.
- Every other segment anchors at a **fork child** — i.e. descend one edge into
  the branch first, then follow the chain.
- Segment number `n = depth(terminus) - depth(anchor)`.
- Render `──n──` when `n > 0`; render `─────` (no number) when `n === 0`.
- After the run, print the terminus' ¶ number.

Worked from grid 6a — this arithmetic is the acceptance test:

```
¶1 ──5── 6 ─┬─3── 10 ─┬─8── ◉ 19
            │         └─2── ○ 13
            └─1── 8 ─┬─4─── ○ 13
                     └───── ○  9
```

- `¶1 ──5── 6` — anchor root ¶1, chain to fork ¶6, `6 − 1 = 5`.
- `─┬─3── 10` — fork ¶6, child ¶7, chain to fork ¶10, `10 − 7 = 3`.
- `─┬─8── ◉ 19` — fork ¶10, child ¶11, chain to leaf ¶19, `19 − 11 = 8`.
- `└─2── ○ 13` — fork ¶10, child ¶11, chain to leaf ¶13, `13 − 11 = 2`.
- `└─1── 8` — fork ¶6, child ¶7, chain to fork ¶8, `8 − 7 = 1`.
- `└───── ○ 9` — fork ¶8, child ¶9, leaf ¶9, `n = 0`, no number.

**Known mockup inconsistency:** grid 7a row `└────── ○ 49` hangs off the fork
at ¶46, so `n = 2` and the rule says it should read `─2────`. The mockups are
hand-drawn; **the rule above wins**. Do not special-case it.

### Lines vs sketches

A fork child is a **line-head** if its subtree extends past the fork
(`childCount >= 1`) **or** it carries a bookmark (`bookmarkByNodeId`) **or**
its subtree carries one (`bookmarkBelowByNodeId`). Otherwise it is a
**sketch**: a lone take nobody ever continued.

- Lines get a row, a `┄` leader, a label-gutter entry and a word count.
- Sketches are hidden by default and counted:
  `+ n sketches folded — single takes never continued · a reveals`
  (7a wording when they span several forks:
  `+ n sketches folded across n forks · a reveals`).
- `a` reveals them hanging off their fork on a `⌇` stem: `⌇ ○ {¶}  "{first
  words}‥"`, no gutter, no word count, dim. While shown, the fork's last
  connector flips `└` → `├`.
- The cursor treats a revealed sketch as an equal: `▸` previews it and `Enter`
  reroutes through it (which is what promotes it to a line — once continued it
  has a child and classifies as a line on the next derive; no explicit
  promotion code).

### Cold-fold

`NodeStub.lastTouched` is already a subtree-max rollup — use it directly. A
fork child whose `lastTouched` is older than **21 days** relative to
`state.now` folds, together with its whole subtree, into one row:

```
└─▸ ×{lines} lines · cold {weeks} wks
```

`weeks = Math.floor(days / 7)`. `lines` = leaf count in that subtree
(`leafCount`). Cold folds keep their sketches inside until opened. `l` on a
cold-fold row opens it (adds its id to an opened set; the row expands to
normal lines/sketches on the next derive). Opened folds stay open for the
lifetime of the overlay.

Never cold-fold a subtree containing the active line — you can always see
where you are.

### Label gutter

Leaves land ragged, so each line row gets a faint `┄` leader run to a **fixed**
gutter column, then:

- bookmark badge `⚑ {name}` when the leaf is bookmarked, else `unnamed · {d mon}`
  (e.g. `unnamed · 12 jul`, lowercase, from `lastTouched`);
- word count right-aligned, thousands-separated, `{n,nnn} w`.

The gutter column is fixed per render: compute it from the widest tree row so
all leaders end in the same column.

### Width windowing

A nested fork costs ~11 cells; ~9 fit at 120 cols. When the tree is wider than
the panel, window the trunk: the leftmost run becomes a `‹ ¶1–{n}` stub and
`h/l` slides the window. When it fits, no stub and `h/l` does nothing to the
window (see keys).

Vertical overflow scrolls with a `▼ {n} more sketch rows · j scrolls` hint
(7b), reusing the map's row-budget approach.

## Keys (atlas mode)

| Key | Action |
|---|---|
| `j` / `k` / arrows | move the cursor between rows (lines, sketches, cold folds) |
| `h` / `l` | slide the trunk window when the tree overflows the panel width |
| `l` on a cold-fold row | open that fold (takes precedence over windowing) |
| `a` | toggle sketch reveal |
| `Enter` | reroute the line through the cursor row's leaf |
| `Esc` | back to the map |

**Ambiguity resolved deliberately:** grid 6a's hint reads `h/l walks forks`,
but 6a fits in width, so windowing would make that hint a no-op — a lying
hint. Rather than invent a second meaning for `h/l`, ship windowing only and
write the hint to match what the keys actually do:
`j/k line · enter reroutes · a sketches · esc back`, appending
`· h/l slides` **only when the tree is actually windowed**. Flagged for the
user to confirm on test.

`Enter` must reuse the existing reroute path in `story-actions.ts` (the same
one the map uses) so remembered continuations are preserved. Do not write a
second reroute implementation.

## Rendering

New file `tui/src/screens/atlas.ts` — do not grow `screens/overlay.ts` past
500 LOC. Reuse `dimPage`, `placePanel`, `raisedSegment` from `overlay.ts`.

Panel title, 6a/7a wording:

```
┏━ atlas · {title} ━ {lines} lines · {parts} parts · {forks} forks ━ {hint} ━━
┏━ atlas · {title} ━ {lines} lines · {parts} parts · {forks} forks ━ {hot} hot · {cold} folded cold ━━
┏━ atlas · {title} ━ {lines} lines + {n} sketches revealed ━ a hides ━━
```

Palette roles (existing `DisplayRole`s, spec §8 — no new colors): amber
`focus / accent` for the current line's path and `◉`; `chrome` for off-line
tree glyphs and `┄` leaders; `prose` for the cursor row's label; `prose · dim`
for other labels and sketch fragments; `bookmark · canon` etc. for badges;
`chrome` for word counts.

Cursor row shows `▸` and a preview at the panel foot:

```
‥{preview}
{...}                                          ¶ {n} · opening
                                               ¶ {n} · sketch · {n} w
```

**Deviation from the spec, justified:** §4 says the foot shows the leaf's
"last line". Off-line leaves reach the client as `NodeStub`s carrying
`preview` (the first 120 chars) — the tail is not in the payload, and fetching
per cursor move would put a network round-trip on `j`/`k`. Use `preview` and
label it `opening`. Document it in the plan's deviations.

## 80×24 degradation

Per §6: drop the preview line, truncate labels, geometry otherwise unchanged.

## Constraints (hard)

- No new dependencies. No server changes. No changes to `shared/`.
- Every file stays under 500 LOC; total new code should land around 400–500
  LOC. This repo has an explicit anti-complexity guardrail — if the
  implementation is ballooning, stop and report rather than pushing through.
- No mouse support for the atlas. Register no hit rows; clicks stay inert
  (consistent with the "inert panel chrome" rule from the mouse work).
- Do not touch the existing map/loom rendering or behaviour.
- Match the surrounding code's idiom: pure model + render split, comment
  density, naming.

## Demo fixture

The demo tree stamps every node with a single `CREATED` constant, so nothing
is ever cold and there are few sketches. Extend `tui/src/demo.ts` minimally so
the atlas is demoable and testable: spread `lastTouched` on off-line branches
so at least one subtree cold-folds, and make sure at least three sketches
exist. Keep changes surgical — the existing golden tests for the story view
and map must not move.

## Tests (bun, in `tui/test/`)

1. `atlas-layout.test.ts` — derivation: segment numbers against the 6a
   arithmetic above; line-vs-sketch classification incl. the bookmark rule;
   cold-fold threshold and that the active line never folds; leaf-count and
   fork-count rollups; trunk windowing stub.
2. Golden frames — atlas at 120×36 and 80×24 (assert title, a tree row, the
   sketch-fold line, the gutter, and that 80×24 drops the preview).
3. Keys — `T` from NAV enters, `t` from map enters, `Esc` returns to the map
   (not the page), `a` toggles, `l` opens a cold fold.
4. A reroute test proving `Enter` goes through the existing reroute path and
   preserves remembered continuations.

## Proof required

`cd tui && bun test` all green, `npx tsc --noEmit` clean, plus the root
`npm run typecheck`. Report files changed, LOC added, and the test output.

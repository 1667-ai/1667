# Plan 010: Chapters in the TUI

Written 2026-07-20 on branch `tui-backend` (already contains main's chapters,
PR #28; nothing to sync). Implemented on main 2026-07-20.

## Status

IMPLEMENTED — automated gates green; Chris user test pending before DONE.

Delivered: chapter-aware reading rows, TOC/context overlay, break CRUD + undo,
summary edit/refresh/expansion, chapter jumps, rail/narrow meters, HTTP + demo
transport, deterministic fixture coverage, and a 20k-part/100-chapter budget test.

## Why this matters

Chapters are the context-management story (PR #28): summaries stand in for
their chapter in the model's context, and long books stay generateable. The
TUI already *computes* chapter-aware context — `rail.ts:55` calls the shared
`assembleChapterContext` for its token gauge — but it renders no chapter
structure, offers no chapter actions, and its transport has none of the five
chapter endpoints. A 1667 user writing a long book today gets correct context
behavior with no way to see or steer it.

Per plan 008's charter this is not web parity. The web spreads chapters over
five surfaces (divider chips, summary cards, meter popover, map rows, seam
buttons). The TUI collapses them into **one overlay plus divider rows**, in
the loom/facts/palette idiom it already has.

## The model (all shared, nothing new server-side)

Zero server changes. Reuse from `shared/`: `deriveChapters`,
`assembleChapterContext`, `isChapterSummaryStale`, `isChapterSummary`,
`SUMMARY_TARGET_TOKENS`. Chapter summaries are dead-end nodes and never on
`payload.path` — the reading column derives summary cards from
`payload.nodes` stubs (chapter-summary stubs carry `text`, `tokens`,
`madeAt`, `editedByUser`). Numbering/extents derived per storyline, never
stored — same invariants as the web (see `1667-chapters-merged`
memory: the meter must mirror the shared assembler).

## Surfaces

### 1. Divider rows in the reading column

`model.ts` grows a discriminant: `StoryRow = part-row | divider-row |
summary-row` (today `StoryPart` is flat with an `isSummary` boolean; that
boolean folds into the discriminant as the legacy-summary part variant).
`createStoryViewModel` emits, at each break on the path:

    [summary-row?]                     § ch two summary · 240 tok · ✓ stands in
    [divider-row]              ── CHAPTER THREE · The Turning Tide · parts 7–12 ──

- Divider: centered rule in the `renderBoundary` style (`screens/story.ts:275`),
  meta color, no accent. Chapter-one heading row only when the story has >1
  chapter (web semantic).
- Summary card: one line, collapsed; amber + `stale — chapter changed` when
  `isChapterSummaryStale`. Focusable with j/k like a part. On focus:
  `e` opens $EDITOR on the summary text (edited summaries marked, never
  auto-replaced — same PATCH semantics as web), `r` re-summarizes/refreshes,
  Enter expands/collapses the full summary text inline.
- Divider row is focusable too: `e` renames (bookmark-style inline input
  mode), `d` removes the break (prune-style two-step confirm), `r`
  summarizes/refreshes the chapter it closes.

### 2. The chapters overlay — TOC + meter breakdown + actions in one

New mode `CHAPTERS`, key `c` in NAV (free), palette `:chapters`. A
`placePanel` list, one row per chapter of the active storyline:

    CH 2  The Turning Tide      parts 7–12   5.1k raw — no summary   [!]
    CH 3  (untitled)            parts 13–18  240 ✓ summary
    CH 4  current               parts 19–21  2.9k raw

- Row chips mirror web statuses (`summary ✓ tok` / `stale ↻` / `raw N — no
  summary` / `current · raw`). Chapters excluded from the assembled context
  (legacy-summary reset) render dimmed with `not sent` — server truth via the
  shared assembler, no drift.
- Enter jumps the reading column to the divider (this is the map-row jump
  nav). `s` summarize/refresh, `e` rename, `d` remove (confirm), `n` break
  after the focused reading-column part (also available without the overlay,
  below). `[!]` marks the biggest positive-savings unsummarized chapter when
  over budget; footer shows the one-line fix hint.
- Footer: `total 8.9k / 8k · over ~700` when over — the breakdown popover
  equivalent, computed from the same shared assembly the rail uses.

### 3. Creating breaks while writing

- NAV `C` (shift-c) on the focused part: "end chapter after this part" —
  break on the seam below it (`parentPartId` = focused part id). On the leaf
  this is the web's "End chapter here"; elsewhere it's retroactive carving.
  Toast mirrors web copy; renumbering is instant.
- After a leaf break, the composer hint line notes the next part opens the
  new chapter (compose header already shows the target part).
- Palette: `:chapter` (create at leaf), consistent with web plan 009's
  `/chapter`.

### 4. Status line + rail

- Rail (width ≥136): under the existing gauge, one line per over-budget or
  stale condition max (`ch 2 unsummarized · would free ~4.9k`); the rail
  gauge already uses assembled context — unchanged math.
- Narrow mode: the status bar's right segment gains `ch 3 · 7.2k/8k` (reuse
  `formatTokensShort`); over budget renders the total in the alert color.
  This is the only always-visible meter, matching the web's strip role.

### 5. Undo

`UndoEntry` (currently take-switches only) gains kinds:
`{ kind: "remove-break", breakId, removed }` restored via the restore
endpoint, and `{ kind: "create-break", breakId }` undone via delete — both
single-unit, pushed on the existing `u` stack. Generation/edit stay
non-undoable as today.

## API layer

`StoryApi` (+ `worker-api.ts` mirror, same method names) gains:
`createChapterBreak(storyId, parentPartId, title?) → {payload, breakId}`,
`renameChapterBreak`, `removeChapterBreak → {payload, removed}`,
`restoreChapterBreak`, `summarizeChapter`. Demo fixture (`demo.ts`,
lantern-keeper) gains two breaks + one summary (one fresh, one absent) so
render-once goldens can cover dividers, overlay, stale, and the narrow meter.

## Keys (proposed; all currently unbound in NAV)

`c` chapters overlay · `C` end chapter after focused part · `[` / `]`
previous/next chapter jump. Inside CHAPTERS: j/k, Enter jump, `s` summarize,
`e` rename, `d`+confirm remove, `n` new break, Esc/q close. On focused
divider/summary rows: `e` / `d` / `r` as above.

## Tests

- Unit: row-model derivation (dividers/summary rows from stubs; legacy
  summary still renders as part variant), overlay rows incl. `not sent`
  dimming and positive-savings pick, undo entries roundtrip.
- Golden render-once: divider + summary card frame, stale frame, chapters
  overlay, narrow status meter, `--keys "C"` break creation toast.
- Transport coverage: HTTP plus the in-memory demo adapter for all chapter
  methods. The worker layer named in the draft no longer exists on main.
- Perf: extend `bench/` budget — row model + overlay rows at 20k parts / 100
  chapters stay in the existing frame budget (shared derivations are already
  proven at this scale server-side).

## Out of scope (v1)

Remember-this (no text selection in the TUI; facts overlay covers manual
entry) · offer chips (the toast + overlay `[!]` replace them) · chapter
reordering/books · sticky headings · autoname for chapter titles (rename via
input; `:autoname` stays story-level) · any server or web change.

## Resolved for implementation

1. Keys: `c`/`C`/`[`/`]`.
2. Summary cards participate in j/k focus order.
3. Narrow-mode chapter meter is always visible.
4. Divider `d` stays direct with a two-step confirmation; the overlay offers
   the same guarded action.

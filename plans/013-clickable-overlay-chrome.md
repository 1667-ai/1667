# Plan 013: Clickable overlay chrome and mouse-model fixes

Written 2026-07-21 from Chris's live testing of the 1667 TUI on branch
`atlas-graph`. Six reported defects; two were clarified by him directly and are
recorded as decisions below.

## Status

TODO — frozen spec, ready for implementation.

## Why

The mouse model (lazygit's: click selects, click again runs, right-click opens
the part menu, wheel scrolls) only ever reached **list rows**. Everything that
is chrome — tag chips, the footer key menu, take cells in the map, the whole
settings panel — renders as inert `panel` targets, so the parts of an overlay
that name their own verbs are the parts you cannot click. Two other defects are
the click model itself being too eager on prose.

The blocker underneath four of the six is that a hit row is a single span:
`HitRow` carries one `target` and one `left`/`right` pair for the entire row.
Chips, footer keys and take cells all need **column-level** targets.

## 1 · Column-level hit spans (the enabling change)

`tui/src/hit.ts`. Keep the row-wide target as the fallback — most rows want it —
and add optional finer spans:

```ts
export interface HitSpan { target: HitTarget; left: number; right: number }
export interface HitRow { target: HitTarget; left: number; right: number; spans?: HitSpan[] }
```

`hitAt` searches `spans` first (first span whose range contains `x` wins), then
falls back to the row-wide target. Rows without `spans` behave exactly as today.

New `HitTarget` kinds:

- `{ kind: "chip"; index: number }` — a selectable chip (facts tags).
- `{ kind: "action"; action: KeyAction }` — a chrome affordance that runs a
  named action (footer menu keys, the settings theme arrows).
- `{ kind: "take"; row: number; take: number }` — one sibling take cell in the
  map.

## 2 · The footer menu is clickable (all overlays)

`placePanel` already renders a footer string like
`j/k move · tab tags · ↵ view · / filter · e edit · n new · x delete`. Give it an
optional parameter:

```ts
footerActions?: ReadonlyArray<{ token: string; action: KeyAction }>
```

When present, `placePanel` locates each `token` inside the rendered footer text
(scanning left to right, carrying an offset so repeated tokens resolve in order)
and registers a `{ kind: "action" }` span over those columns on the footer row.

**A token that is not found is a bug, not a no-op.** Add a test that renders
every overlay which declares `footerActions` and asserts each declared token was
located and each maps to an action the overlay's own handler accepts — the same
anti-drift guarantee the keys modal got in plan 012. A footer that says `e edit`
while `e` does nothing is exactly the failure this must prevent.

Opt in for: facts, library, chapters, commands, bookmark manager, story map,
settings. Leave the keys modal and the summary-take modal inert — one is a
legend, the other a progress readout; neither has verbs of its own.

**The atlas is excluded, deliberately.** Plan 011 made it mouse-inert on
purpose ("register no hit rows; clicks stay inert"), `mouseToAction` returns
`null` for `ATLAS` mode, and `story.ts` clears `hitRows` before rendering it.
An earlier draft of this section listed the atlas among the opt-ins; that was a
mistake and it contradicted §9. Wiring the atlas for the mouse is its own
decision, taken against plan 011's rationale — not a side effect of this one.
The footer-token and footer-truncation tests in §10 therefore cover the seven
opted-in overlays; the atlas is exempt from the token test but **not** from the
truncation rule, which is a pure render check and needs no hit rows.

## 3 · Facts tag chips (`tui/src/screens/panels.ts`)

The chips row currently renders as inert chrome. Register one `chip` span per
chip over its exact columns. A click selects that tag directly.

`factsAction` gains index support on the existing action: `cycle` with
`resolved.index` set jumps to that chip; without it, it advances by one as `tab`
does today. Selecting a tag resets the row cursor to 0, exactly as `tab` does.

## 4 · Map take cells and take arrows (`tui/src/screens/overlay.ts`)

A map row renders `¶ 12  ○─○─◉─○─○  ‹ take 3/5 ›  preview…`. Register:

- one `take` span per sibling glyph, over that glyph's columns;
- a `take` span on the `‹` and on the `›` of the counter, resolving to the
  take one step before / after the current one (clamped, no wrap — the counter
  is a position, and a click that silently jumps end-to-end reads as a glitch).

Clicking a take moves the map cursor to it; clicking the same take again
reroutes — the same two steps a row click takes.

**Resolved 2026-07-21 after Chris tested it.** The first implementation made
take cells apply in one click while rows stayed two-click, on the theory that a
take cell is an unambiguous target and a row is not. In use that read as an
inconsistency rather than a shortcut: one gesture meaning two different things
inside a single panel costs more than the extra click saves. Two clicks
everywhere.

Reuse the existing apply/reroute path in `story-actions.ts`. Do not write a
second reroute.

## 5 · Settings gets hit rows (`tui/src/screens/panels.ts`)

`renderSettings` is the only panel that passes no hits at all, so every click
inside it falls through to the scrim and dismisses the panel you were aiming at.
That is the whole of "settings is missing by mouse".

- Pass `{ rows: state.hitRows, targets }` like every other panel.
- The theme row's `‹` and `›` get `action` spans for the previous/next theme
  (the actions `h`/`l` already run in `SETTINGS`), so the arrows work.
- Every other settings line is inert `panel` chrome — visible, not actionable.
- Opt into `footerActions` per §2.

## 6 · Clicking prose never generates (`tui/src/mouse-actions.ts`)

Today a click on the already-focused part returns `continue`, which starts a
generation. Dragging to select text begins with a mouse-down on prose, so
selecting text can kick off a model call.

**Decision (Chris, 2026-07-21): a left click on prose only ever moves focus.**
Remove the click-again-runs branch for `target.kind === "part"`. Right-click
still opens the part menu; the composer and list rows are unchanged. Generation
stays keyboard-only from the story view (`enter`, `i`, `r`).

## 7 · Right-click leaves COMPOSE (`tui/src/mouse-actions.ts`)

**Decision (Chris, 2026-07-21).** While `state.mode === "COMPOSE"`, a
right-click anywhere resolves to `cancel` — it returns to NAV instead of opening
the part menu. The draft is preserved; `cancel` from COMPOSE already keeps it.

## 8 · Facts bodies wrap to the panel, not the terminal

`renderFacts` wraps an expanded fact with `Math.max(20, width - 20)`, where
`width` is the **terminal** width. The panel is capped at 106 and centred, so at
120 columns a long body renders 120 characters wide inside a 106-wide panel and
spills out the right edge. Reproduced: body lines measure 120 while every other
row measures 100.

Wrap to the panel's inner measure instead — panel width minus the frame and the
6-column body indent. Add a regression test asserting no rendered panel line
exceeds the panel width, for a fact body long enough to wrap twice.

## 8b · A footer must never be truncated

Reported alongside the above: in settings, `c check server` is visible but
`esc close` runs off the edge. `placePanel` renders the footer as
`truncate(footer, panelWidth - 4)`, and settings caps its panel at 76 columns
while its footer text is 78 — so the last key is silently cut.

A truncated footer is the same defect class as §2's missing token: the panel
advertises a menu and then hides part of it. Two changes:

- Shorten the settings footer copy so it fits its own panel at 80 columns —
  `h/l theme · e edit in $EDITOR · c check server · esc close`. Keep the terse
  house voice; do not widen the panel to fit prose.
- Add a test asserting that **for every overlay, at 120×36 and at 80×24, the
  footer renders untruncated** — compare the declared footer text against what
  the frame actually contains. Any overlay that fails gets its copy shortened,
  not the assertion relaxed.

This test and §2's token test overlap deliberately: one proves the menu is
complete, the other proves it is clickable.

## 8c · The story gutter's verbs are clickable too

Added 2026-07-21 on Chris's instruction ("all must be usable via mouse"), after
the focused part's gutter grew from two verbs to five:

```
     ¶ 12 ‹ take 3/5 ›  He did not move toward the stairs. Instead he set the
             ○ ○ ● ○ ○  bar between them, and its needle went around twice,
 ↵ continue · i direct  slow, like a dog deciding whether to lie down, and
    r retake · w write  stopped pointing at Maren. 'Has the cliff road ever
                e edit  been walked at night without a light?' he asked.
```

`GUTTER_VERBS` in `tui/src/screens/story.ts` already pairs each token with the
`KeyAction` it advertises, for exactly this reason. Each rendered verb gets an
`{ kind: "action" }` span over its own columns, so clicking `↵ continue` runs
continue and clicking `e edit` opens `$EDITOR`.

Two rules carry over from §2 and §6:

- The same anti-drift test applies — every verb in `GUTTER_VERBS` must resolve
  to an action NAV accepts. The pairing exists so the gutter cannot advertise a
  key that does nothing.
- These spans sit **on top of** the part's row-wide `part` target, so a click
  on the prose beside them still only moves focus (§6). Only the verb's own
  columns run anything.

**Owner: Claude, after §1 lands.** `story.ts` stays off the implementer's
allowlist — this section is written down so it is not lost, not to widen scope
mid-run.

## 9 · Constraints (hard)

- No new dependencies. No server or `shared/` changes. No design-package
  changes; this is bug work, not a new surface.
- Every file stays under 500 LOC. `panels.ts` is the one at risk — if it would
  cross, split the settings panel into `screens/settings-panel.ts`.
- No abstractions beyond the three `HitTarget` kinds and `footerActions` named
  here. No defensive `try`/`catch`. No config flags.
- Do not change the atlas rendering, the keys modal, or anything from plan 012.
- Match the surrounding idiom: pure model + render split, existing comment
  density, existing test style.

## 10 · Tests (bun, `tui/test/`)

Extend `hit-map.test.ts` — it already asserts the hit map through **real
rendered frames**, which is the only way these stay honest:

1. Span resolution: a row with spans resolves by column; a row without them
   still resolves row-wide.
2. Facts chips: clicking each chip's columns yields that chip's index; clicking
   between chips does not.
3. Footer menu: for every overlay declaring `footerActions`, each token is
   located in the rendered footer and its action is one the overlay accepts.
4. Map: clicking each take glyph and each counter arrow yields the right
   `take` target; the arrows clamp at the ends.
5. Settings: a click inside the panel is never `scrim`; the theme arrows resolve
   to the theme actions.
6. Prose: a click on the focused part yields `focus-index`, never `continue`.
7. COMPOSE: a right-click resolves to `cancel`.
8. Facts overflow: no rendered panel line exceeds the panel width.

## 11 · Proof required

`cd tui && bun test` green · `cd tui && npx tsc --noEmit` clean · root
`npm run typecheck` and `npm test` green. Report files changed, net LOC, pasted
test output, and a rendered facts frame at 120 columns showing an expanded long
fact staying inside the panel.

# Plan 008: TUI client — 1667 in the terminal

Written 2026-07-18 on branch `cli`. Exploration, not product work: the goal is
a genuinely good terminal writing loom, not web parity. Baseline: `e429a69`.

## Status

IMPLEMENTED on branch `cli` (2026-07-19) — phases 0–3 plus typewriter mode
and viewport scroll; ~5k LOC in `tui/`, 67 tests, perf bench with budgets.
Reviews: thermo-nuclear (all blockers resolved, incl. demo-as-StoryApi
unification) and six /autoreview rounds (26 findings fixed; notably stop now
keeps landed text, matching the web). Awaiting user test. Phase 4 leftovers:
selection rewrite (allowed to drop), themes, quota meter.

## Why this matters

Coding-agent TUIs (OpenCode, pi) proved the terminal is a first-class home for
streaming AI work — but nobody has built one single-mindedly for fiction.
1667's data model makes this unusually feasible: the story is already a
tree of discrete parts with actions, not a freeform document, so the TUI never
has to be a text editor. Prose edits punt to `$EDITOR`; everything else is
block navigation, streaming, and tree rendering — exactly what terminals do
best.

## Name

**1667** — the NaNoWriMo daily word quota (50,000 ÷ 30). Binary and npm name
`1667` (npm name verified free 2026-07-19); launched as `./1667`, `1667`, or
`npx 1667`. Verified working in sh/zsh/bash; the only shell quirk is
bash-specific `1667>file` (no space) parsing as an fd redirect and silently
running nothing — irrelevant for a full-screen TUI, and zsh handles even that
correctly. Not a valid JS identifier, so the source directory stays `tui/`.

## Architecture (frozen)

- **Second client, same server.** New top-level `tui/` directory. It speaks the
  existing HTTP + SSE API on `:7373` and imports `shared/types.ts`. Zero
  server changes in phases 0–2; any later server change must also serve the
  web client.
- **Stack (revised 2026-07-19 after phase-0 smoke test):** `@opentui/core`
  **imperative API** running under **Bun** — OpenTUI 0.4.5's native FFI is
  still Bun-only (Node entry exists but throws "FFI not available"); verified
  rendering headlessly under installed Bun 1.1.20 via
  `@opentui/core/testing`. The reconcilers were dropped: the app is a custom
  span-wrapped text buffer plus a few overlays; imperative fits (pi-tui
  precedent). Server stays Node; runtime mismatch is irrelevant to an HTTP
  client, and Bun can host the Node server later if the embedded-server idea
  lands. Fallback remains Ink on Node with a thin render layer.
- **`$EDITOR` integration:** suspend the TUI, open a temp file, diff on
  return. Used for prose/prompt edits and fact editing. This is the escape
  hatch that keeps the TUI out of the text-editor business.
- **Growth budget:** `tui/` is tracked separately from the app's LOC budget
  until it passes a user test (same rule as chapters). Estimate 2.5–3.5k LOC.
  If it becomes a keeper, the budget conversation reopens honestly.

## Interaction model (frozen)

Modal, vim-adjacent — but **arrow keys are first-class equivalents of
`hjkl` in every non-text context** (NAV, overlays, tree). Vi keys are the
power path, arrows the intuitive one; both appear in help and the `?` chart.
Arrows only mean "move the cursor" inside text inputs (COMPOSE, palette
filter). Three states:

- **NAV** (default): the story is a column of part blocks. `j`/`k`/`↑`/`↓`
  move focus between parts, `g`/`G` jump to top/leaf. **`h`/`l`/`←`/`→` flip
  between sibling takes at the focused part** — the signature interaction; the line below the
  focus point re-renders to the remembered continuation, with `‹take 2/5›`
  shown in the part header and one-key undo (`u`) after any switch.
- **COMPOSE**: `i` or `Enter` on the composer. Multiline instruction box at
  the bottom. `Enter` submits: empty composer = seamless Continue (prefill
  path), text = new part. `Esc` back to NAV. From NAV, `n` skips the box and
  continues immediately.
- **Overlays**: one at a time, `Esc` closes. Loom map (`t`), facts (`f`),
  library (`o`), settings (`,`), command palette (`:` or `Ctrl+K`).

Streaming renders live into the leaf block with a visible cancel affordance.
All destructive actions (prune) show the exact node count before confirm,
matching the web.

## Feature translation

| Web feature | TUI treatment | Phase |
|---|---|---|
| Story library (sidebar) | `o` overlay: title, words, updated; create/delete | 1 |
| Instruction → streamed part | Composer + SSE into leaf block | 0 |
| Seamless Continue (empty prompt) | Empty composer + Enter | 0 |
| Take switching + undo | `h`/`l` on focused part, `u` undo | 1 |
| Line chip | Status bar segment (current line name) | 1 |
| Bookmarks (name/label/color) | `b` on a leaf; palette for manage; colors → ANSI | 1 |
| Delete/prune with counts | `d` + count confirm modal | 1 |
| Prune unused takes | Palette preview + `d` confirmation; keeps continuations, named lines, and one leaf per fork | 4 |
| Export markdown | Palette command, writes file, toast with path | 1 |
| Show prompts toggle | `p` toggles instruction lines above each part | 1 |
| StoryMap / mini-loom | `t` full-screen tree overlay: box-drawing tree, previews, bookmark badges, active path bold; Enter switches line | 2 |
| Edit prompt+prose (pencil) | `e` → `$EDITOR` with prompt + prose sections; diff → human edit | 2 |
| Regenerate (sibling take) | `r` on focused part | 2 |
| Write here (human take at seam) | `w` on focused part → `$EDITOR` | 2 |
| Human-edit word marking | Underline/dim-color spans via attribution data | 2 |
| Story facts panel + search | `f` overlay: list, `/` filter, `e` per-fact `$EDITOR`, tag chips | 3 |
| Settings + check server + probe context | `,` form overlay reusing `/api/settings` endpoints | 3 |
| Summary take | Palette command → streaming modal with cancel + prefix-lock note | 3 |
| Autoname | Palette command | 3 |
| SillyTavern / character-card import | Defer to existing `npm run import` CLI; palette shows the command | 3 |
| Themes | 2 terminal themes (dark default); respect terminal palette | 4 |
| Selection rewrite / take-from-cut (phrase mode) | **Hardest feature in a TUI** — needs in-block visual selection across soft-wrapped lines. `v` visual mode within a part, then `r` rewrite / `c` cut-take. Attempt only after everything else works; acceptable to ship without | 4 |
| Drag & drop, chapters (plan 005) | Out of scope — not on the web yet either | — |

TUI-native additions (the "cool" dividend, phase 4): typewriter mode (`z` —
center active paragraph, dim chrome while streaming), fully SSH/tmux-safe
operation, keybinding cheat overlay (`?`), and the namesake **daily quota
meter** — a status-bar count of today's *human-written* words (composer
instructions + human takes + edit diffs) against 1,667.

## Phases

- **Phase 0 — spike (prove the risks).** OpenTUI app that loads one story,
  renders the active line with soft-wrap, streams a Continue via SSE, survives
  resize, and virtualizes long stories (render viewport only — server already
  hydrates active-line prose only). STOP if soft-wrapped streaming render is
  janky in OpenTUI; evaluate Ink before writing more.
- **Phase 1 — the writing loop.** Library, composer, new part + continue, take
  flipping with undo, bookmarks, prune with counts, export, prompts toggle,
  status bar. *Exit test: write a real scene start-to-finish without the web
  app.*
- **Phase 2 — the loom.** Tree overlay, regenerate, write-here, `$EDITOR`
  edits, human-edit spans. *Exit test: manage a 3-branch story entirely in
  the TUI.*
- **Phase 3 — depth.** Facts, settings, summary take, autoname.
- **Phase 4 — polish + stretch.** Typewriter mode, themes, `?` overlay,
  selection rewrite if feasible.

Each phase ends with a user test before the next starts (house rule).

## Risks

1. **Soft-wrap + streaming reflow** — the phase-0 gate; everything else
   assumes it works.
2. **OpenTUI maturity** (v0.4.x, native Zig dep) — mitigated by thin render
   layer + Ink fallback.
3. **Selection rewrite** may prove terminal-hostile — explicitly allowed to
   drop; the web keeps it either way.
4. **Two frontends drift** — mitigated: server API is the single contract,
   `shared/` types imported by both, and the TUI stays "exploration" status
   until user-tested.

## Deviations from the design handoff (running list)

- ~~Streaming cancel discards~~ **Corrected 2026-07-19 (autoreview round 6):**
  the design was right. The server never commits aborted streams, but the
  web client saves the landed partial via `createNode` + genId after stop —
  the TUI now does the same, copy restored to `esc stops`. The earlier
  deviation note misread the web flow (only its provider layer was checked).
- **Daily quota meter** not in this build (design shipped total words;
  DECISIONS §4 leaves the daily counter as an open option).
- **Command palette navigates with arrows only** (design footer said
  `j/k move`): command names themselves contain j/k/x, so letters go to the
  query and arrows navigate (autoreview round 4).
- **"Loom" renamed to "story map" in UI copy** (2026-07-19, user call):
  normies don't know looms; the web app already says StoryMap. Internal
  names (plan 007, code modules) keep loom.

## Parked: embedded server (post-user-test idea, 2026-07-19)

Once the TUI proves out, `1667` can become a single process by embedding the
server in-process: export `startServer({ port: 0 })`, TUI connects over
loopback/unix socket, HTTP+SSE contract unchanged (this is how OpenCode works
— its TUI talks to an embedded local server). Spec when picked up: try
connecting to a running `:7373` first, embed only if absent (so TUI and web
share a live session, and two processes never write one data dir); add a
data-dir lockfile. Nothing needed now except the phase-0 freebie already
implied: the API client takes a base URL rather than hardcoding `:7373`.

## Design handoff

`docs/design/tui-design-prompt.md` is the self-contained prompt for a design
pass (screen mockups, keybinding chart, visual direction). Its output should
land in `docs/design/design_handoff_tui/` and gets reviewed against this plan
before phase 1.

# Plan 005: Books, chapters, and drag & drop restructuring

Written 2026-07-15 alongside Plan 004. Spec-level only — detailed steps get
written when this plan starts (after Chris user-tests Plan 004 in the running
app, per the growth budget).

## Status

SUPERSEDED 2026-07-18 — this plan predates Loom (Plan 007), which deleted the
`StoryBranch` model it depends on. Chapters shipped instead as **in-story
chapter breaks + chapter-scoped context**, specced in
`docs/design/design_handoff_chapters/` (breaks live on seams inside the tree;
summaries stand in for their chapter in the model's context; no Book
container). The Work = Story | Book model below, multi-story books, and DnD
restructuring remain unbuilt and deferred until user testing shows the need.

The Plan 004 debt list below is retired: Loom removed `use-branches.ts`,
`branchStory`, `locateLinePart`, and the two continuation-commit copies'
surrounding model; App.tsx is back under 500 lines; canon is representable
only as a bookmark label. The file-size watchpoint moved to
`web/src/StoryView.tsx` (574 lines going into chapters — split on touch).

## Model (frozen at this altitude)

- `Work = Story | Book`. A **book** is an ordered list of **chapters**; each
  chapter has its own parts + branches (a chapter is structurally what a story
  is today). Chapters are belonging/order; branches are forks — never mixed.
- Facts are per-work: a book's chapters share the book's facts.
- Sidebar stays flat: a book is one row (book icon, `3 chapters · 3.7k words`).
- Chapter bar under the header (books only): prev/next arrows (wrap), chapter
  dropdown (numbered rows, part counts, grip handles, "+ New chapter"), mono
  position indicator `2 / 3`.
- Restructuring (design handoff "Interactions & Behavior", plus the turn-4
  spec in `Branch In Editor.dc.html` — read it when writing the full plan):
  - story → book row: drop zones "Add as Chapter N" / "Add as branch of X";
  - story → plain story: same zones; the target auto-converts to a book;
  - story → chapter dropdown: insertion line, drop at position, renumber;
  - chapter reorder within the dropdown;
  - chapter → sidebar: "Drop here — standalone story" detaches it (parts +
    branches travel).
  Every move toasts. Buttons/menus may ship before drag & drop if slicing is
  needed — DnD is an enhancement layer over the same endpoints.
- Biggest schema decision to make at planning time: whether a book embeds
  chapter manifests in one bundle or references per-chapter bundles. Decide
  against the object-store GC and the per-story write lock, not speculatively.

## Debt owed from Plan 004 review (execute before or during this plan)

- Extract one `commitContinuation(fresh, …)` into `server/story-parts.ts` — the
  continuation commit exists twice (`generation-http.ts` streaming commit,
  `index.ts` stopped-partial save) and both copies grew in lockstep during 004.
- `web/src/use-branches.ts` ref/state mirrors are at their complexity ceiling:
  adding ANY new in-flight operation kind requires inverting to one event-time
  ref as the source of truth with render state derived from it.
- `web/src/App.tsx` is at exactly 500 lines — split on first touch.
- `locateLinePart` callers dispatch on array identity (`list === story.parts`);
  give the result an explicit `where: "base" | "tail"` tag when next open.
- `web/src/StoryView.tsx` submit guard and Continue-button `disabled` spell the
  same predicate twice — one `submitBlocked` constant.
- Delete the dead `api.branchStory` client wrapper (server endpoint stays).
- Canon is representable two ways (`label: "Canon"` vs `canon` flag); the panel
  couples them but the format allows canon-with-other-label. Decide one
  representation before chapters add more branch metadata.

## Scope guards

Depends on Plan 004's `StoryBranch` model landing unchanged. No nested books.
No cross-book chapter references. Sidebar never shows chapters.

# Plan 006: Import SillyTavern character cards as canonical character facts

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. Stop on any condition in
> "STOP conditions"; do not improvise. When done, update this plan's row in
> `plans/README.md` unless a reviewer says they maintain the index.
>
> **Target-baseline drift check (run first)**:
> `git diff --stat c8efa8a..HEAD -- shared/types.ts shared/character-card.ts server/http.ts server/story-facts.ts web/src/api.ts web/src/FactsPanel.tsx web/src/CharacterCardImport.tsx web/src/facts.css test/character-card.test.ts test/continue.test.ts docs/character-card-import.md README.md CHANGELOG.md`
> This plan targets `origin/main` commit `c8efa8a`. Execute from that commit or a
> reviewed descendant.
> If a listed file changed, compare the live code with "Current state" before editing.

## Status

- **Priority**: P1
- **Effort**: M (roughly one to two focused days, including tests and user test)
- **Risk**: MEDIUM (untrusted binary metadata plus prompt-facing imported text)
- **Depends on**: `plans/003-canonical-story-facts.md` (DONE; flat facts remain)
- **Category**: direction
- **Planned at**: commit `c8efa8a`, 2026-07-16

## Why this matters

Authors already have reusable SillyTavern/Chub character cards, commonly distributed
as PNG images containing a Character Card V1 or V2 JSON payload. Re-entering the
character description and personality into 1667 facts is busywork. A small,
local importer can turn only the character-defining prose into ordinary canonical
facts without introducing a card runtime, remote service integration, lorebook,
avatar, or prompt override system.

The import must be selective because card files are untrusted and V2 explicitly
contains `system_prompt`, `post_history_instructions`, greetings, arbitrary
extensions, and an optional embedded `character_book`. None of those are 1667
facts. Importing them silently would let a downloaded card alter application behavior
or flood the fixed prompt context.

## Product decisions and invariants

1. **Current story only.** Entry point lives in the open story's Facts panel. A card
   adds facts to that story; it never creates a story or changes existing prose.
2. **Local files only.** Accept one `.png` or `.json` file at a time. No CharacterHub
   URL/API, account, network fetch, sync, or recursive linked-content import.
3. **Supported formats.** Support Tavern Character Card V1 JSON and Character Card V2
   JSON (`spec: "chara_card_v2"`, `spec_version: "2.0"`), either directly or
   Base64-encoded in a PNG `tEXt` chunk whose keyword is `chara`. A PNG containing
   one `chara` payload imports that V2
   fallback even when a separate `ccv3` chunk coexists; other text-chunk keywords are
   ignored. Reject `ccv3`-only V3, CHARX, WebP, compressed PNG text chunks, ordinary
   images without card metadata, and arbitrary JSON with a clear message. Do not guess
   or partially import an unsupported format.
4. **Imported fields.** Always retain the non-empty character `name`; include
   `description` and `personality` by default. Show `scenario` as an opt-in field,
   unchecked by default because it often describes a specific chat setup rather than
   durable character truth.
5. **Ignored fields.** Never import or display as candidate facts: `first_mes`,
   `mes_example`, `alternate_greetings`, `creator_notes`, `system_prompt`,
   `post_history_instructions`, `tags`, `creator`, `character_version`, `extensions`,
   or `character_book`. Ignore image pixels. Tests must prove prompt/control and
   lorebook content cannot enter generated facts.
6. **Editable preview.** Before saving, show the parsed name plus editable
   Description, Personality, and Scenario controls. Only non-empty checked sections
   are saved. State the ignored categories beside the form. React text rendering only;
   no HTML interpretation or `dangerouslySetInnerHTML`.
7. **Macro normalization.** In one non-recursive, case-insensitive pass, replace
   `{{char}}` with the edited character name and `{{user}}` with `the protagonist`.
   Inserted names are never scanned again. Preserve all other plain text and internal
   whitespace.
8. **Ordinary flat facts.** Every produced item has tag `Character`; no card schema or
   source metadata is persisted. Prefer one fact formatted as named sections. When it
   exceeds `MAX_FACT_TEXT_CHARS`, pack at field boundaries first, then split a single
   long field at paragraph/newline/word boundaries and finally a Unicode-safe hard
   boundary. Never truncate or split a surrogate pair. Repeat the character name and
   section label in continuation facts so each remains intelligible alone.
9. **Visible prompt cost.** Preview the exact number of facts and estimated total
   tokens after packing. Warn/disable save when the import would exceed the story's
   remaining `MAX_FACTS` capacity. Existing prompt-window refusal remains authoritative;
   this feature does not add retrieval, enable/disable state, or context clipping.
10. **Atomic save.** All generated facts validate before any mutation. Capacity or
    validation failure adds nothing. One locked story save returns the full updated
    story; the existing navigation-aware facts merge adopts only its facts.
11. **No new dependency.** The required PNG chunk walker and card validator are small,
    deterministic, browser/Node-compatible TypeScript. Do not add an image decoder,
    schema package, or UI test framework for this slice.

Reference schema: the approved
[Character Card V2 specification](https://github.com/malfoyslastname/character-card-spec-v2)
defines the V1 core fields and the V2 `data` wrapper. Chub currently advertises PNG
downloads compatible with V2. Treat both files and every decoded string as untrusted.

## Target data contracts

Add a small wire input beside `StoryFact` in `shared/types.ts`:

```ts
export interface FactInput {
  tag?: string | null;
  text: string;
}

export type CreateFactsRequest = FactInput | { facts: FactInput[] };
```

`POST /api/stories/:storyId/facts` keeps its existing single-fact body and gains an
atomic batch body:

```json
{
  "facts": [
    { "tag": "Character", "text": "Name: Mira\n\nDescription:\n..." },
    { "tag": "Character", "text": "Name: Mira\n\nPersonality:\n..." }
  ]
}
```

Reject an empty batch, a non-array `facts`, non-object entries, a body mixing
top-level `tag`/`text` with `facts`, and a batch that cannot fit. Parse every entry
with the same `parseTag`/`parseText` rules used by single creation before generating
IDs or pushing anything.

Create `shared/character-card.ts` with browser/Node-neutral exports shaped like:

```ts
export interface CharacterCardCore {
  version: 1 | 2;
  name: string;
  description: string;
  personality: string;
  scenario: string;
}

export interface CharacterCardSections {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
}

export function parseCharacterCard(bytes: Uint8Array): CharacterCardCore;
export function factsFromCharacterCard(source: CharacterCardSections): FactInput[];
```

Names may be at most 200 UTF-16 code units. Reuse the existing
`MAX_IMPORT_BYTES` (20 MB) browser pre-read cap for the whole PNG, and add a separate
1 MB decoded-card-JSON cap inside the parser. Check a Base64 payload's encoded length
before decoding it. JSON files also use the 1 MB card-data cap. Add
`MAX_JSON_BODY_BYTES = 1_000_000` in `shared/types.ts`, use it from the existing
`readJsonBody` implementation, and use the same constant to size the final UTF-8 JSON
batch before the UI enables save. This moves the current literal without changing the
server-wide request limit.

## Current state

- `shared/types.ts:62-72` defines `MAX_FACTS = 128`,
  `MAX_FACT_TEXT_CHARS = 4_000`, `MAX_FACT_TAG_CHARS = 48`, and flat `StoryFact`.
  `MAX_IMPORT_BYTES` currently has a chat-specific comment; generalize the comment,
  not the value.
- `server/story-facts.ts:16-24` parses and immediately appends one fact. Refactor this
  into parse-all-then-append logic while preserving existing single-create behavior.
  `factRoute` already owns the collection POST, so the batch body needs no new route.
- `server/http.ts:21-22` caps decoded JSON request bodies at a literal 1,000,000 bytes.
  Replace only that literal with the shared `MAX_JSON_BODY_BYTES`; request behavior
  stays unchanged and the importer can enforce the identical bound before POST.
- `server/index.ts:160-165` reads the fact POST body once, runs `factRoute` inside
  `withStory`, and returns the updated story. **Do not modify this 900+ line file.**
- `web/src/api.ts:40-43` sends one body through `api.createFact`. Broaden its request
  type to `CreateFactsRequest`; its path and response remain unchanged.
- On target baseline `c8efa8a`, `web/src/FactsPanel.tsx` is 173 lines. It owns fact
  editor state, error/busy handling, token display, and `onCreate`. Add the import
  launch/state here, but place parsing and preview UI in a new
  `web/src/CharacterCardImport.tsx` so the panel stays focused and below 500 lines.
- `web/src/App.tsx:348-357,496-505` already merges only facts from late mutations and
  wires `onCreate` through that safe path. Its target-baseline size is 517 lines.
  **Do not modify it:** the existing `onCreate` prop carries either request shape.
- `web/src/facts.css` owns the card-in-reading-area facts UI on the target baseline.
  Extend that file using existing surface, line, accent, mono, and focus conventions.
- `test/continue.test.ts:205-276` is the HTTP/in-process facts CRUD and limit exemplar.
  `test/story-facts.test.ts` demonstrates importing pure browser modules into Node's
  built-in test runner.
- There is no lint script. Baseline at `c8efa8a`: 111 tests pass; typecheck, production
  build, and `npm audit --audit-level=high` all exit 0.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm install` | exit 0; package lock unchanged |
| Parser tests | `node --import tsx --test test/character-card.test.ts` | all card tests pass |
| HTTP import test | `node --import tsx --test --test-name-pattern='story facts CRUD|character card fact import' test/continue.test.ts` | matching tests pass |
| Typecheck | `npm run typecheck` | exit 0, no errors |
| Full tests | `npm test` | exit 0, all tests pass |
| Production build | `npm run build` | exit 0 |
| Dependency audit | `npm audit --audit-level=high` | exit 0, no high/critical vulnerabilities |
| Hygiene | `git diff --check` | exit 0, no output |
| Scope | `git status --short` | only in-scope files plus plan-status edits |

## Scope

**In scope** (the only source/product files to modify):

- `shared/types.ts`
- `shared/character-card.ts` (create)
- `server/http.ts`
- `server/story-facts.ts`
- `web/src/api.ts`
- `web/src/FactsPanel.tsx`
- `web/src/CharacterCardImport.tsx` (create)
- `web/src/facts.css`
- `test/character-card.test.ts` (create)
- `test/continue.test.ts`
- `docs/character-card-import.md` (create)
- `README.md`
- `CHANGELOG.md`
- `plans/006-import-sillytavern-character-cards.md`, `plans/README.md` (status only)

**Out of scope** (do not touch):

- `server/index.ts`, `web/src/App.tsx`, `web/src/Sidebar.tsx`, `web/src/StoryView.tsx`.
- Story/manifest schemas, fact provenance, cross-story character libraries, dedupe,
  re-import updates, live sync, remote URL import, or credentials.
- Card avatars/art, first-message story creation, example-dialogue style extraction,
  card tags, creator metadata, embedded character/world books, lore retrieval.
- Card execution semantics: system prompts, post-history instructions, jailbreaks,
  greetings, alternate greetings, or app-specific extensions.
- V3 `ccv3`, CHARX, WebP, APNG-specific behavior, compressed `zTXt`/`iTXt`, export,
  drag-and-drop, multi-file import, and CLI import.
- Fact enable/disable, relevance retrieval, summarization, or Plan 002 memory work.
- New runtime/dev dependencies and broad visual redesign.

## Git workflow

- Start from `main` at `c8efa8a` or a reviewed descendant with a clean worktree.
- Use a feature branch; do not execute on the stale `ux` baseline from which this plan
  was authored.
- Conventional commits. Suggested logical commit:
  `feat: import character cards as story facts`.
- Use `committer` and list only intended paths. Do not push or open a PR unless the
  operator explicitly requests it.

## Steps

### Step 1: Parse bounded V1/V2 JSON and PNG card payloads

Add the shared input types/limits, then create `shared/character-card.ts`.

For JSON, decode UTF-8 strictly, tolerate one leading BOM, require an object, detect
V1 only when `spec` is absent and the V1 core shape is present, and detect V2 only for
`spec === "chara_card_v2"`, `spec_version === "2.0"`, with an object `data`. Missing
optional core strings become
empty strings; a present non-string core field is an error. Require a non-empty trimmed
name plus at least one non-empty description/personality/scenario. Ignore unknown keys.

For PNG, validate the eight-byte signature and walk bounded chunks using unsigned
big-endian lengths. Reject truncation/overflow, duplicate `chara` chunks, and missing
`IEND`. For an uncompressed `tEXt` chunk, split keyword/data at its first NUL; when the
keyword is exactly `chara`, strictly Base64-decode its value, strictly UTF-8-decode the
result, then pass it through the same JSON validator. Never decode image pixels. A PNG
without one `chara` chunk gets an actionable "ordinary image or metadata was stripped"
error. Ignore other chunk keywords, including a coexisting `ccv3`; a `ccv3`-only PNG
gets an explicit unsupported-V3 error.

Unit tests build tiny PNG byte arrays in memory; do not commit third-party card art or
binary fixtures. Cover V1 JSON, V2 JSON, Unicode, BOM, normal V2 `chara` PNG, ordinary
PNG, malformed chunk bounds, bad Base64, bad UTF-8/JSON, duplicate metadata, unsupported
spec/version, a PNG with both `ccv3` and V2-fallback `chara` (imports the fallback),
wrong field types, empty name/core, oversized JSON, and an encoded payload whose
projected decoded size exceeds the cap.

**Verify**: `node --import tsx --test test/character-card.test.ts` and
`npm run typecheck` both exit 0.

### Step 2: Convert only selected character prose into bounded flat facts

Implement `factsFromCharacterCard` as a pure deterministic mapper. Normalize macros in
one pass after the user-edited name/sections are supplied. Format the preferred single
fact as:

```text
Name: Mira

Description:
...

Personality:
...
```

Omit unchecked/empty sections. Pack whole sections while the exact final fact remains
at or below `MAX_FACT_TEXT_CHARS`. For an overlong section, split without data loss at
the best available boundary and label pieces (for example `Description (1/3):`), each
with `Name: ...`. Calculate piece counts before rendering labels so `(1/10)` cannot
push a fact over the limit. Reject an empty selection or a name that leaves no room for
content. Return `FactInput[]` in Description, Personality, Scenario order.

Tests must prove deterministic output, default/core ordering, exact 4,000-character
bounds, paragraph and hard splits, no lost non-edge source text, no surrogate-pair
split, one-pass `{{char}}`/`{{user}}` handling, and that every ignored V2 field
(especially both instruction fields and `character_book`) is absent from all output.
Also expose/test a small UTF-8 request-size helper that measures
`JSON.stringify({ facts })` with `TextEncoder`; newline escaping and wide Unicode must
be covered so UI capacity cannot be inferred from UTF-16 fact lengths alone.

**Verify**: parser tests and typecheck remain green.

### Step 3: Make collection POST atomically accept one fact or a batch

Broaden `api.createFact` to accept `CreateFactsRequest`. In `server/story-facts.ts`,
normalize a single body or `{ facts: [...] }` to an array; reject ambiguous/invalid
bodies. Check capacity once, parse every tag/text into temporary values, then generate
UUIDs/timestamps and append all facts in order. No mutation may occur before every
entry passes. Preserve current error codes/messages for existing single-fact calls
where practical; use `409` for insufficient remaining capacity.

Extend the existing facts CRUD HTTP test with:

- successful two-fact batch, returned/persisted in source order;
- malformed second entry leaves the story unchanged;
- insufficient capacity leaves the story unchanged;
- empty/mixed/non-array batch rejection;
- existing single-create, patch, delete, tag, text, Unicode, and limit behavior remains.

Name the new integration test exactly `character card fact import` so the focused
`--test-name-pattern` command cannot pass by matching only the pre-existing CRUD test.

Do not add a route or edit `server/index.ts`; its current collection POST already wraps
the mutation in one story lock/save.

**Verify**: focused HTTP test, parser tests, and typecheck all pass.

### Step 4: Add the editable Facts-panel import flow

Create `CharacterCardImport.tsx`; keep `FactsPanel` as the orchestration shell.

Flow:

1. Beside `+ New fact`, add a secondary `Import card` action. It opens a single-file
   chooser accepting `.png,.json,image/png,application/json`.
2. Check `file.size <= MAX_IMPORT_BYTES` before `arrayBuffer()`. Parse locally; display
   parser failures inside the Facts panel and reset the input value so the same file
   can be retried.
3. Show editable Name, Description, Personality, and Scenario. Description/Personality
   are checked when non-empty; Scenario starts unchecked. Empty source fields stay
   visible but unchecked/disabled or are clearly marked empty.
4. Recompute final packed facts and exact token estimate as fields/selections change.
   Show `Will add N Character fact(s) · ~T tokens`. Disable save on parse/mapping error,
   no selected content, busy state, `story.facts.length + N > MAX_FACTS`, or a final
   UTF-8 `JSON.stringify({ facts })` body larger than `MAX_JSON_BODY_BYTES`; say how many
   fact slots remain or that the selected card text is too large for one import request.
5. State: `Greetings, example dialogue, card instructions, creator metadata, art, and
   embedded lorebooks are ignored.`
6. Submit one `{ facts }` batch through the existing `onCreate` callback and FactsPanel
   `mutate` helper. On success close the preview, return focus to `Import card`, and let
   App's existing facts-only merge update the story. On failure keep edits visible.
7. Cancel returns focus without saving. Preserve existing fact editor/search behavior.

Use semantic labels/fieldset/legend, native checkboxes, visible focus, and existing
button/surface typography. Do not render the avatar or raw HTML. Keep both new/changed
TSX files below 500 lines.

There is no browser-test stack. Pure parsing/mapping and HTTP atomicity carry automated
coverage; the next step supplies the required real UI/user gate.

**Verify**: `npm run typecheck`, `npm test`, and `npm run build` exit 0.

### Step 5: Document the trust boundary, then run the user gate

Create `docs/character-card-import.md` with frontmatter:

```yaml
---
summary: Supported SillyTavern character-card import formats and field mapping
read_when:
  - changing story fact import or limits
  - changing supported character-card formats
  - changing how card fields enter prompts
---
```

Document V1/V2 PNG/JSON support, exact imported/ignored fields, macro normalization,
snapshot/no-sync behavior, size/fact/context limits, and why instruction/lorebook fields
are excluded. Update README's opening claim (1667 now has a card importer but
still no card runtime), add Facts-panel import instructions, and add an Unreleased
CHANGELOG entry.

Before final closeout, Chris must user-test in the running app:

1. Import one real Chub/CharacterHub V2 PNG into a story with existing prose/facts.
2. Confirm name/description/personality preview correctly; Scenario starts unchecked.
3. Edit a field, import, and confirm only `Character` facts appear; existing facts and
   prose remain unchanged.
4. Search the new facts and run one dry-run Continue to confirm normal prompt flow.
5. Retry the same file and cancel; import an ordinary PNG and confirm the error is
   useful and nothing is saved.
6. Check the Facts panel at wide and narrow widths in both light and dark themes.

Keep the plan status `IN PROGRESS` until that user test is acknowledged. Then run the
full automated gate.

**Verify**: `npm test && npm run typecheck && npm run build && npm audit --audit-level=high && git diff --check` exits 0; `git status --short` shows only scoped files.

## Test plan

- `test/character-card.test.ts`: all byte/JSON parser boundaries, schema normalization,
  macro behavior, ignored-field security boundary, deterministic packing, size limits,
  Unicode-safe splitting, mixed `ccv3`/fallback PNG behavior, and exact UTF-8 request
  sizing for escaped newlines and wide characters.
- `test/continue.test.ts`: collection POST batch success plus all-or-nothing failures;
  reuse its existing real server and CRUD structure.
- Existing `test/story-facts.test.ts`: unchanged; full suite proves imported facts use
  the same canonical formatter and prompt overflow behavior as hand-written facts.
- Manual: one authentic Chub V2 card, ordinary PNG rejection, cancel/retry, responsive
  Facts-panel inspection, and one dry-run generation.

## Done criteria

- [x] V1 and V2 core JSON import from direct JSON and V2 `chara` PNG passes tests.
- [x] Only name, selected description/personality, and opt-in scenario reach facts.
- [x] Instruction, greeting, metadata, extension, art, and lorebook fields never do.
- [x] Every imported fact is tagged `Character`, no fact exceeds 4,000 characters,
      Unicode is intact, and no selected source prose is silently truncated.
- [x] Batch creation is one locked, all-or-nothing save and preserves source order.
- [x] Whole-file and decoded-payload limits are checked before amplification.
- [x] The exact UTF-8 batch body is checked against the server's shared 1 MB JSON limit
      before save is enabled; newline escaping and wide text cannot cause a surprise 413.
- [x] Existing manual fact CRUD and every prior test remain green.
- [x] No source file exceeds 500 lines because of this change; `server/index.ts` and
      `web/src/App.tsx` are untouched.
- [x] README, dedicated doc, and Unreleased changelog describe shipped behavior.
- [ ] Chris completes and acknowledges the real-card UI test.
- [x] Full gate and `git diff --check` exit 0; no dependency or storage-schema change.
- [ ] `plans/README.md` marks Plan 006 DONE only after all prior boxes hold.

## STOP conditions

Stop and report instead of improvising if:

- Target `main` lacks the flat `StoryFact` model, collection `factRoute`, or
  navigation-safe facts-only merge described above.
- A real Chub V2 PNG uses a packaging method other than the supported uncompressed
  `chara` `tEXt` payload. Capture only its chunk names/shape (no private card prose)
  and re-scope format support before broadening the parser.
- Correct parsing requires a new dependency, native image decoding, browser-only APIs
  in shared code, or edits to `server/index.ts`/`web/src/App.tsx`.
- Mapping selected core prose cannot fit within `MAX_FACTS`/`MAX_FACT_TEXT_CHARS`
  without truncation.
- The batch endpoint cannot remain backward-compatible with existing single-create
  callers and error behavior.
- Any ignored prompt/control/lorebook field appears in a produced fact.
- A step's focused verification still fails after two reasonable correction attempts.

## Maintenance notes and deferred triggers

- Reviewers should scrutinize PNG bounds before every slice/allocation, Base64 decoded
  size before decode, schema discrimination, ignored-field tests, Unicode-safe splits,
  and mutation-before-validation mistakes.
- If Chub changes its default download to V3/CHARX, plan a separate parser extension
  from its current primary specification and retain the same allowlisted core fields.
- Add WebP only after collecting a real supported-card sample and documenting its
  metadata container; a misleading `.png` extension is not enough.
- Add source provenance/dedupe only when users need repeatable updates. This MVP is an
  explicit editable snapshot; re-import is allowed to create another snapshot.
- Add avatars only after 1667 has a deliberate character/image surface. Do not
  let an import convenience create that product model accidentally.
- Revisit disabled/relevance-selected facts if typical imported characters cause
  context refusals. Do not silently omit imported facts in this feature.

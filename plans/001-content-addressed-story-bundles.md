# Plan 001: Move stories to self-contained content-addressed bundles

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 6559144..HEAD -- README.md package.json tsconfig.json server/stories.ts server/story-format.ts server/story-objects.ts test/story-format.test.ts test/story-store.test.ts plans/README.md`
> Then run the same path list with `git diff --stat --` to detect uncommitted work.
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `6559144`, 2026-07-14

## Why this matters

1667 rewrites an entire story JSON file after every edit. Every saved
version contains another complete text, and a branch copies its complete
prefix. A single long part edited repeatedly therefore amplifies disk writes
and storage even though most paragraphs did not change. Move persistence
behind the existing `StoryStore` API to Git-like immutable chunks: unchanged
paragraphs and branch prefixes share storage, while the browser and API keep
receiving the same `Story` shape.

This is a user-data migration. The implementation must favor recoverability
over cleverness: dual-read the old format, retain the exact old file, write new
objects before publishing their manifest, and never use a delta chain that
makes one damaged revision depend on every earlier revision.

## Current state

- `shared/types.ts` is the public/wire model. Keep it unchanged in this plan.
  It stores every version as a complete string:

  ```ts
  // shared/types.ts:1-17
  export interface StoryPart {
    id: string;
    instruction: string;
    text: string;
    model: string;
    createdAt: string;
    versions?: string[];
    activeVersion?: number;
    genId?: string;
  }
  ```

- `server/stories.ts` is the only persistence boundary. `server/index.ts` and
  `server/import-cli.ts` construct `StoryStore`; all create, import, edit,
  generate, rewrite, version-select, branch, export, and delete flows call its
  existing methods.
- Listing currently reads and hydrates every complete story merely to produce
  sidebar metadata:

  ```ts
  // server/stories.ts:40-59
  const entries = await readdir(this.dir);
  const loaded = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => this.load(entry.slice(0, -".json".length)))
  );
  // ...
  words: story.parts.reduce((sum, part) => sum + countWords(part.text), 0)
  ```

- `server/stories.ts:72-74` branches by copying every retained part and
  `[...part.versions]`, then saves another whole-story file.

- Loading and saving parse/stringify the entire file. The unique temporary
  file plus rename protects the final JSON from a torn write, and that safety
  property must remain:

  ```ts
  // server/stories.ts:102-126
  raw = await readFile(this.filePath(id), "utf8");
  return JSON.parse(raw) as Story;
  // ...
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(story, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  ```

- `StoryStore.withLock()` serializes higher-level read/modify/write work in one
  process. Some direct routes still call `load()` and `save()` without it, so
  object cleanup also needs an internal per-story I/O queue; otherwise a load
  could read an old manifest while a save removes the objects it references.
- `README.md:3,46` promises no database and one plain JSON file per story.
  Preserve the no-database/local-files intent, but update the one-file claim.
- `README.md` gained prompt-editing documentation in `6559144`; preserve it while
  replacing only the obsolete one-file storage description.
- No test suite exists. Verified baseline at the planned commit:
  `npm audit --audit-level=high` reports zero vulnerabilities and
  `npm run build` exits 0 on Node `v24.12.0` / npm `11.12.1`.
- Commit history shows the invariants that must survive: versions are capped at
  10 (`509492e`), a cut branch must discard the cut part's stale versions
  (`52d502c`), and story mutation races are serialized (`a9dcd2c`).

## Target storage contract

Each v2 story is a self-contained directory. Content files are immutable;
branches hard-link inherited objects when the filesystem permits it and copy
them otherwise.

```text
data/stories/
  <story-id>.json                         # legacy v1, until lazy migration
  <story-id>/                             # v2 story bundle
    manifest.json
    chunks/<first-2>/<sha256>.txt
    revisions/<first-2>/<sha256>.json
    legacy/v1.json                        # exact pre-migration v1 bytes
```

Use server-only disk types; do not leak them into `shared/types.ts`:

```ts
interface StoryManifestV2 {
  format: "1667-story";
  schemaVersion: 2;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  origin?: StoryOrigin;
  activeWordCount: number;
  parts: StoredPartV2[];
}

interface StoredPartV2 {
  id: string;
  instruction: string;
  model: string;
  createdAt: string;
  genId?: string;
  revisionIds: string[];       // oldest first; always at least one
  activeRevision: number;      // valid index into revisionIds
}

interface TextRevisionV1 {
  format: "1667-text-revision";
  schemaVersion: 1;
  chunks: string[];            // ordered SHA-256 chunk IDs
  utf16Length: number;         // validates exact JS-string reconstruction
}
```

Hash and serialization rules are part of the format, not implementation
details:

- A chunk ID is lowercase SHA-256 of its exact UTF-8 bytes. Never add a newline
  to a chunk file.
- A revision ID is lowercase SHA-256 of canonical compact JSON with properties
  ordered exactly as in `TextRevisionV1`: `format`, `schemaVersion`, `chunks`,
  `utf16Length`. Revision files contain those exact bytes.
- Object paths may only be derived from a validated `/^[a-f0-9]{64}$/` hash.
- Verify every object's bytes against its file-name hash when hydrating a story.
  A missing, malformed, or mismatched object is corruption, not a 404.
- A no-history runtime part encodes `[part.text]` at active index 0. On hydrate,
  one revision becomes `text` with `versions`/`activeVersion` omitted; multiple
  revisions become the existing complete-string wire fields. Before saving a
  versioned runtime part, require a non-empty versions array, a valid active
  index, and `part.text === part.versions[part.activeVersion]`; fail instead of
  silently choosing one.

Chunking must preserve exact text while keeping boundaries stable after a local
edit:

1. Empty text has zero chunks; its revision still exists.
2. Split on paragraph separators (two or more logical newlines, allowing spaces
   or tabs on blank lines). Retain the full separator at the end of the prior
   chunk. Never normalize CRLF, blank lines, leading/trailing spaces, or Unicode.
3. A paragraph of at most 64 KiB UTF-8 is one chunk. For an oversized paragraph,
   split into exact sentence/line spans while retaining their whitespace. If a
   single span still exceeds 64 KiB, split at the last whitespace that fits; as
   a final fallback split on a Unicode code-point boundary.
4. Assert for every input that `chunks.join("") === input`. A paragraph edit
   must change that paragraph's chunk ID without shifting later paragraph IDs.

Write/migration ordering:

1. Serialize I/O for one story inside `StoryStore`, separately from the public
   higher-level `withLock()` queue. `load`, `save`, migration, per-story cleanup,
   and `remove` participate in this I/O queue.
2. Existing v2 save: write missing chunk/revision objects via unique temp files
   and same-directory rename; flush file data and object directories; revalidate every
   referenced object; then atomically replace and flush `manifest.json`. Queue bounded,
   coalesced removal of unreferenced objects only after that durable commit.
3. New v2 story: build a complete sibling temporary bundle, then rename the
   directory to `<story-id>/`.
4. Legacy migration: leave `<story-id>.json` untouched while building a complete
   sibling temporary bundle that includes its byte-for-byte copy at
   `legacy/v1.json`. Verify the staged bundle hydrates, rename and flush it into
   place, then unlink the root v1 file. A crash may leave v1 only, v2 only, or both; `load` prefers a
   valid v2 bundle, and `list` de-duplicates the pair.
   Flush the staged bundle and stories directory before durably unlinking v1.
5. A failed write may leave only temp/orphan immutable objects. It must never
   publish a manifest with a missing object. Reap recognized sibling staging or
   deletion tombstones at startup; clean object orphans on the next successful save.
6. Per-story cleanup marks every revision in the committed manifest and every
   chunk in those revisions, then removes only known hash-shaped files in that
   bundle. It never touches `legacy/v1.json` or unknown files. Hard links make
   branch deletion/cleanup safe: unlinking one directory entry does not remove
   another story's link.

Compatibility rules:

- `StoryStore` method signatures and API response types do not change.
- `load` checks `<id>/manifest.json` first, then legacy `<id>.json` only when no
  published bundle exists. Unknown schema versions fail clearly.
- `list` reads only v2 manifests and cached `activeWordCount`; legacy stories use
  the old full-load/count path until migrated.
- `save` always writes v2, so an existing story migrates on its next mutation.
  Merely starting the app or opening a legacy story performs no write.
- Branching a legacy story first performs a storage-only migration that preserves
  its `updatedAt`, then creates the branch so inherited objects can be hard-linked.
- A cut branch retains the current behavior: the cut part gets one new truncated
  revision and inherits none of the source part's longer alternatives.
- Export/import, generation context, version cap/order, origin metadata, and the
  browser wire model remain unchanged.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm install` | exit 0; package-lock remains valid |
| Focused tests | `node --import tsx --test --test-name-pattern='story (format|store)' test/*.test.ts` | exit 0; matching tests pass |
| All tests | `npm test` | exit 0; all tests pass |
| Typecheck | `npm run typecheck` | exit 0; no errors |
| Production build | `npm run build` | exit 0; Vite build completes |
| Dependency audit | `npm audit --audit-level=high` | exit 0; no high/critical findings |
| Patch hygiene | `git diff --check` | exit 0; no output |

## Scope

**In scope** (the only files the executor should modify):

- `server/story-format.ts` (create) — disk schemas, validation, hashing, exact chunking.
- `server/story-objects.ts` (create) — atomic immutable-object I/O, hard-link/copy reuse, per-bundle cleanup.
- `server/story-lifecycle.ts` (create) — staging publication, tombstone deletion, and crash recovery.
- `server/story-codec.ts` (create) — bounded manifest/object graph encoding and hydration.
- `server/story-snapshot.ts` (create) — manifest-guarded reuse of verified revision identities.
- `server/stories.ts` — dual-format `StoryStore`, lazy migration, fast listing, bundle deletion; keep domain helpers.
- `test/story-format.test.ts` (create) — pure format/chunk tests.
- `test/story-store.test.ts` (create) — temporary-directory integration/migration tests.
- `package.json` — add the Node test command.
- `tsconfig.json` — typecheck `test/`.
- `README.md` — v2 layout, migration/backup, backup/copy guidance.
- `CHANGELOG.md` — required merge acknowledgment and storage summary.
- `plans/README.md` — status only when complete.

Keep each TypeScript file below roughly 500 lines. If either new storage module
would exceed that, STOP and propose a named split before adding an unplanned file.

**Out of scope** (do not touch):

- `shared/types.ts`, `server/index.ts`, `server/import-cli.ts`, and `web/`; the storage adapter must preserve their contract.
- Context compaction, summaries, embeddings, prompt selection, or model behavior. Revision hashes are only a future cache key.
- Lazy-loading API versions; this plan still hydrates every retained version.
- More than `MAX_VERSIONS`, automatic history pruning policy changes, or UI changes.
- Compression, encryption, cloud sync, a database, a global object pool, or unrelated-story deduplication.
- Multi-process locking. Current safety is process-local; do not invent a lock-file protocol here.
- Removing migrated `legacy/v1.json` backups automatically.

## Git workflow

- Work on a new branch only with operator consent; otherwise remain on the current branch.
- Use small Conventional Commits. Suitable examples:
  `test: add story storage characterization coverage`,
  `feat: store stories as content-addressed bundles`, and
  `docs: document story bundle migration`.
- Use `committer` and list only intended paths. Do not amend, push, or open a PR
  unless the operator explicitly requests it.
- Before each commit, inspect `git status --short` and
  `git --no-pager diff --color=never` so unrelated user work is not staged.

## Steps

### Step 1: Establish the format and test harness

1. Add `package.json` script:

   ```json
   "test": "node --import tsx --test test/*.test.ts"
   ```

   Add `"test"` to `tsconfig.json`'s `include` array. Do not add a dependency;
   the repo already has `tsx`, and Node 24 has `node:test`.
2. Create `server/story-format.ts` with the exact v2 manifest/revision types,
   constants, hash validation, canonical revision serialization, minimal strict
   parsers/type guards, runtime-version invariant checks, and the chunker defined
   in "Target storage contract".
3. Keep legacy parsing separate from v2 parsing. Validate at least object shape,
   expected story ID, required strings/arrays, origin shape, and version invariants.
   An explicit unknown `format`/`schemaVersion` must not fall back to legacy.
4. Create `test/story-format.test.ts` with table tests for empty text, one paragraph,
   mixed `\n`/`\r\n`, whitespace-only blank lines, leading/trailing whitespace,
   non-BMP Unicode, an oversized single paragraph, and a pathological long token.
   Every case asserts exact reconstruction and each chunk's 64 KiB cap. Add a
   local-edit test proving chunks before and after an edited middle paragraph keep
   their IDs. Add parser rejection tests for invalid hashes, empty revision lists,
   mismatched active indices, and unknown schema versions.

**Verify**: `node --import tsx --test --test-name-pattern='story format' test/*.test.ts` → exit 0; all new
format tests pass. Then `npm run typecheck` → exit 0.

### Step 2: Implement immutable object storage

1. Create `server/story-objects.ts`. Its public surface should be small and typed:
   initialize a bundle, store/hydrate a text revision, import inherited objects
   from another bundle, list live references, and sweep unreachable known objects.
2. For every object write: compute bytes and hash first; retain and revalidate no-follow
   handles for the bundle, kind, and shard directories; validate/reuse an existing
   matching regular object; otherwise write a unique temp file in the destination
   shard and publish it with a no-replace hard link. On `EEXIST`, verify the winner
   and discard the temp file. Never follow a symlink or overwrite bytes whose content
   does not match their name.
3. Hydration must verify the revision hash, schema, every chunk hash, exact concatenation
   length, and UTF-8 decoding. Cache duplicate chunk/revision reads within one story
   load so ten related versions do not reread the same file ten times.
4. When creating a branch bundle, try `link(source, destination)` for every inherited
   hash. Treat unsupported hard links, `EXDEV`, or a source object disappearing as a
   copy/write fallback using the already-hydrated text. Any other error propagates.
   Object files remain immutable forever; updates always publish new hashes.
5. Implement per-bundle mark-and-sweep, but do not call it until Step 4. It may delete
   only valid hash-shaped files under that bundle's `chunks/` and `revisions/` trees.
   A missing/malformed live revision aborts the sweep without deleting anything.

Add object-store integration cases to `test/story-store.test.ts`: identical text
stored twice in one bundle creates one object per hash; parallel attempts leave
valid complete objects; tampering/missing objects fails with a corruption error;
unknown files survive cleanup; symlinked object roots, shards, and canonical object
entries fail closed without reading or deleting their external targets.

**Verify**: `node --import tsx --test --test-name-pattern='story store' test/*.test.ts` → exit 0; object tests
pass. Then `npm run typecheck` → exit 0.

### Step 3: Add dual-read and crash-safe lazy migration

1. Refactor `StoryStore` in `server/stories.ts` to own a private per-story I/O queue
   in addition to the existing higher-level mutation queue. Do not change
   `withLock()` semantics. Route `load`, `save`, storage-only migration, and `remove`
   through the I/O queue; use private `*Unlocked` helpers internally to avoid
   recursive queue deadlocks.
2. Split path helpers into validated legacy-file, bundle, manifest, and sibling-temp
   paths. Catch only filesystem `ENOENT` as "Story not found". JSON/schema/hash/read
   failures must remain real errors so `server/index.ts` logs them and returns its
   generic 500 rather than lying with a 404.
3. Implement v2 hydration to the existing `Story`/`StoryPart` runtime shape. Preserve
   all metadata, origin, revision order, active selection, and `genId`. Do not expose
   manifest fields such as `activeWordCount` over the API.
   Retain a manifest-fingerprinted, in-memory revision snapshot so an unchanged story
   can reuse already verified identities; discard it whenever the live manifest differs.
4. Implement v2 encoding. Keep `save()`'s current behavior of assigning a fresh
   `updatedAt` before persistence. Compute `activeWordCount` with the existing
   `countWords()` semantics over active `part.text` only.
5. New stories/imports build and publish a complete temporary bundle. A save of a
   legacy story builds the same bundle plus exact `legacy/v1.json`, verifies it
   through the v2 reader, publishes the directory atomically, and only then removes
   `<id>.json`. On failure, remove only the unpublished temp bundle; the original
   v1 file remains authoritative.
6. If both a valid bundle and root v1 file exist after an interrupted final cleanup,
   prefer v2 and remove the duplicate root file only after verifying it equals the
   bundle backup. Never silently replace a differing file.

Add integration tests using `mkdtemp()` and synthetic fixtures; never read or mutate
the developer's real `data/` directory. Cover:

- Legacy load is read-only and returns the current runtime shape.
- First mutation migrates; `legacy/v1.json` is byte-identical to the fixture.
- Migration round-trips title/timestamps/origin, empty and Unicode text, CRLF and
  trailing whitespace, `genId`, multiple versions, and a non-newest active version.
- A second save remains v2 and does not alter the backup.
- Unknown schema, malformed manifest, missing object, and hash mismatch report
  corruption, not 404.
- New story and imported-story-shaped fixtures write v2 directly.
- Repeated concurrent load/save operations never observe missing live objects.

**Verify**: `npm test` → exit 0; all format, object, legacy, migration, and round-trip
tests pass. Then `npm run typecheck` → exit 0.

### Step 4: Make listing, branching, cleanup, and deletion storage-aware

1. Rewrite `list()` with `readdir(..., { withFileTypes: true })`. For valid-ID v2
   directories read `manifest.json` only and return its title, timestamp,
   `parts.length`, `activeWordCount`, and origin presence. Continue loading legacy
   `.json` files fully. De-duplicate an interrupted v1/v2 pair in favor of valid v2,
   preserve newest-first sorting, and keep the current warn-and-skip behavior for an
   unreadable story.
2. Before branching a legacy source, migrate it without changing `updatedAt`. For a
   whole-part branch, reuse all inherited revision/chunk objects via hard links/copy
   fallback. For a cut part, keep prior parts' objects but encode only its trimmed
   active prefix and clear its revision history exactly as current code does.
3. After a v2 manifest commits, queue a coalesced per-story cleanup job; do not hold the
   request open for a complete object-tree scan. The job re-enters that story's I/O queue,
   rereads the latest manifest, and uses bounded workers. It fails closed if any live
   revision cannot be validated. Cleanup failure is warned and retried after a later
   successful save rather than making the caller retry an already committed mutation.
4. `remove()` first rejects divergent legacy duplicates, then atomically renames a
   bundle to a recognized deletion tombstone before best-effort recursive reaping.
   Hard-linked branch inodes remain until the last story link is removed.
5. At startup, clean only this app's exact sibling staging/tombstone names. Never
   recursively remove an unexpected directory or unknown user file.

Add integration tests for:

- V2 list succeeds and returns cached words without reading chunk bodies (make a
  referenced chunk unreadable/missing after init; list still works, load fails).
- Mixed legacy/v2 listing and interrupted duplicate de-duplication.
- Editing one paragraph of a massive one-part story reuses every unchanged chunk;
  appending a paragraph reuses the complete prefix except the prior final chunk whose
  retained paragraph separator changes.
- More than ten successive `supersede()`/save cycles retain only live objects for
  the current capped revisions; dropped revision/chunk files are gone.
- Whole-part branch has the same runtime content and shares inherited objects. On
  filesystems exposing inode/link counts, assert hard-link sharing; always assert
  the copy fallback remains independently loadable.
- Cut branch has no stale alternative that can restore text beyond the cut.
- Deleting the source leaves its branch loadable; deleting the last story removes
  that bundle's object entries.
- Existing `selectVersion()` and `supersede()` order/cap behavior remains unchanged.

**Verify**: `npm test` → exit 0; all tests pass, including the massive-part and
branch/delete regressions. Then `npm run build` → exit 0.

### Step 5: Document the new ownership and run the full gate

Update `README.md`:

- Replace "one story = one JSON file" with "one story = one self-contained folder."
- Show the v2 bundle layout and explain that manifests/revisions/chunks are plain local
  files; there is still no database.
- Explain lazy migration, the retained `legacy/v1.json`, and that opening a story does
  not migrate it.
- Tell users to back up/copy the whole story folder (or all of `data/stories/`), not an
  isolated manifest. A copied branch remains complete even if hard links become copies.
- Mark chunk/revision files immutable implementation objects: use 1667 or Markdown
  export to edit prose; direct edits invalidate their content hashes.
- State the expected trade-off: unrelated stories are not deduplicated, full regenerations
  with wholly different prose still consume real space, and the ten-version cap remains.

Run all commands below and inspect the final diff for accidental wire/UI changes:

```sh
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
git diff --check
git status --short
```

**Verify**: the first five commands exit 0; status contains only the in-scope files.
`git diff -- shared/types.ts server/index.ts server/import-cli.ts web` prints nothing.

## Test plan

- Framework: Node 24 `node:test`/`node:assert`, through the installed `tsx` loader.
- Cover exact format behavior plus v1/v2 filesystem migration, atomic publish, corruption, reuse/cleanup, listing, branching, deletion, and in-process concurrency.
- Build synthetic `mkdtemp()` fixtures, including a generated multi-megabyte one-part story; commit no large fixture. Clean only those directories with `t.after()`.
- No snapshots: assert runtime stories, exact bytes, live reference sets, and named errors.

## Done criteria

- [x] Legacy `<id>.json` stories load without writing and migrate only on mutation/branch.
- [x] Every migration retains byte-exact `legacy/v1.json`; failure leaves root v1 authoritative.
- [x] New saves publish self-contained v2 bundles and never a manifest with missing objects.
- [x] Runtime/API behavior is unchanged; `shared/types.ts`, `server/index.ts`, `server/import-cli.ts`, and `web/` have no diff.
- [x] A massive-part paragraph edit reuses unaffected chunks; cleanup retains only reachable objects.
- [x] A branch shares immutable files where possible, survives source deletion, and has a correct copy fallback.
- [x] V2 sidebar listing reads manifests/cached word counts without hydrating prose.
- [x] Missing/corrupt objects and unsupported schemas surface as corruption, never 404.
- [x] `npm test`, typecheck, build, audit, and `git diff --check` all exit 0.
- [x] No TypeScript source file added by this plan exceeds roughly 500 lines.
- [x] Only intended storage/docs files are included, and `plans/README.md` marks Plan 001 `DONE`.

## STOP conditions

Stop and report back; do not improvise if:

- In-scope current-state code differs materially from the excerpts after the drift check.
- Real legacy format behavior cannot be represented by `Story` plus its documented version
  invariant, or a fixture requires silently dropping/reordering text or metadata.
- The implementation appears to require a public `Story`/API/UI change.
- Atomic sibling-directory rename is unavailable on a supported storage location, or a
  failure-path test can expose a published v2 manifest before all objects exist.
- Correct cleanup requires supporting multiple processes mutating the same story directory.
  That needs a separate cross-process locking design; do not add an ad-hoc lock file.
- A required change falls outside the Scope list, or a planned TypeScript module would need
  to exceed roughly 500 lines without an agreed split.
- A verification command fails twice after one focused correction.
- An unexpected file/directory collision exists at `data/stories/<id>/`; never delete or
  overwrite it merely because its name resembles a story ID.

## Maintenance notes

- Revision IDs are future summary cache keys; keep derived summaries separate from immutable prose.
- Disk duplication improves now; all-version HTTP/memory payloads remain for a later lazy-fetch plan.
- `legacy/v1.json` is a one-time safety cost; any prune command must be explicit and separately planned.
- Hard links are immutable by contract. Reviewer: reject any in-place object write.
- Reviewer focus: crash order, duplicate v1/v2, `ENOENT`, I/O serialization, exact text, branch deletion.
- Wholly different regenerations consume real space; the ten-version cap stays the honest bound.

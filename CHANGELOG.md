# Changelog

This file records notable changes to 1667. Product terms use the definitions in
[Technical terms](docs/technical-terms.md).

## Unreleased

- **Local story changes commit with one atomic write.** A take switch, a text
  edit, a tag change, a fact change, or a chapter-break change now commits
  through one atomic publish of the story manifest. Before, each of these
  changes also wrote a caller intent, a receipt pair, and a ledger record pair,
  each with its own disk barrier. Those records protect paid model calls, and
  model-backed work keeps all of them. A crash during a local change can lose
  that one change, and only that change. It cannot damage the story, and the
  next start loads the story cleanly. On the tour vault, a take switch dropped
  from about 25 ms to about 14 ms.
- **`u` now takes back an added or removed chapter break only.** It also
  reversed a take switch, and it said so on each take switch. Two keys did one
  job: `←` and `→` already walk the takes of one part. Worse, a key named undo
  that answers a navigation key implies that it can answer a destructive one. It
  cannot: `d` prunes takes and their children, and nothing brings them back. `u`
  now reaches an added or removed chapter break, which includes the summary of a
  removed break. It does not reach a chapter rename, a summary edit, or any
  prose. The take-switch message no longer names it. Thanks @10fra for the
  report.
- **A fresh install now opens with facts.** The tour carries five facts about
  the instrument. "A Door in the Hedge" carries four facts about its own world.
  The facts overlay no longer opens empty at the point where the tour tells you
  to look in it. The starter vault writes the facts in the same change that
  writes the prose, so a first run does not pay a second write for each story.
- **Settings status text now sits above the footer.** The revision line, the
  unsaved-draft notice, and the pending-restart notice moved below the fields,
  beside the check result. The read-only migration banner stays above the
  fields, because it changes what each field below it means. The notice area
  keeps a constant height, so a pending restart no longer moves the fields or
  the rows above them. Thanks @10fra for the placement review.
- **A toast now always uses the footer line.** Before, a toast printed under the
  focused story part while the view followed focus, and in the footer after you
  scrolled away. A message about the application no longer enters the
  manuscript, and it no longer moves with the focus. Thanks @10fra for the
  placement review.
- **1667 no longer announces a clean startup recovery.** The message `startup
  recovery complete · state reloaded` reported an internal step at each start.
  1667 still reloads state at each start. It now reports the recovery only with
  a warning, or when the reload opens a different story. Thanks @10fra for the
  report.
- **Bookmarks are now tags.** A tag is a name and a status on the end of one
  story line. The old name told you that the mark kept a reading position. It
  does not. It names one version of the story, and the reading position is the
  story line you are on. Press `t` to tag a line. The `b` key no longer tags.
  Each tag has a status: Canon, Alt, Draft, Discarded, or Summary. Stories on
  disk do not change, and no migration is necessary. The HTTP API protocol goes
  from 5 to 6, because the story payload, the tag routes and the request body
  changed. A client and a backend from different builds must be updated
  together: an older client is now refused when it connects, instead of
  connecting and then failing to read a story. Thanks @10fra for the
  terminology review.
- **A displaced Canon line becomes Alt.** Only one story line can be Canon. When
  you make a second line Canon, the first line becomes Alt and keeps its name,
  its colour, and its date. Before, the first line lost its status. It then
  looked the same as a line with no tag. Thanks @10fra for the report.
- **1667 withholds its Windows x64 package.** The
  Windows machine tier installs a protected DACL for the current user and
  SYSTEM. Native tests reject reparse points. The launcher does not pin
  `@1667-ai/windows-x64`. npm fails an optional dependency softly. Thus, a
  launcher that named an unpublished package would install without an error.
  It would then fail at each launch. npm does not permit a replacement of a
  published version. A Windows user who runs the launcher gets the source build
  route. Routine CI does not build this target.
- **Routine CI now builds three release targets.** CI builds macOS arm64, Linux
  arm64, and Linux x64. CI does not build macOS x64 or Windows x64. These two
  targets caused failures on `main`, and their release work is not active.
  Thanks @10fra for the CI coverage decision.
- **Migrated StoryTavern bundles open in 1667.** 1667 accepts the predecessor
  manifest and text-revision identifiers without changing content hashes. New
  story writes use 1667 identifiers. Thanks @10fra for the migration report.
- **Unexpected backend failures now have private local diagnostics.** 1667
  writes bounded machine-tier logs, returns safe persisted references across
  HTTP and embedded-worker boundaries, and can mirror new entries with
  `--print-logs`. Thanks @10fra for the failure-reporting design.
- **Public documentation now describes the current repository.** The README
  states the public status and exact CI coverage. The release guide specifies
  six release packages and five release targets. Obsolete plan documents are
  removed. Thanks @10fra for the documentation audit.
- **Repository documentation shows build status and uses a defined language
  standard.** The README shows CI and standalone-build status for `main`.
  `AGENTS.md` requires ASD-STE100 for technical documentation and README files.
  Thanks @10fra for defining the standard.
- **Generation does not block local writer actions.** Provider work uses short
  durable phases. The final phase applies an operation-specific result to the
  current story. Concurrent edits remain unchanged. Linux tests cover Stop
  saves, deleted sources, manual names, and provider termination. Thanks
  @10fra for the CI failure analysis.
- **Stories use project-root storage.** 1667 searches parent directories for a
  `.1667/` project. `1667 init` creates a project. `1667 --global` opens one
  machine-wide project. `--data` selects a project root and accepts a relative
  path. An interactive start can create an absent project.
- **Provider secrets use the machine tier.** Project settings contain an
  opaque secret identifier. Each machine supplies its own secret. A project
  with a legacy `secrets.json` file fails closed and identifies the machine
  tier.
- **`1667 export` writes the selected story line to the project root.** Chapter
  titles use `##` headings. A name collision adds a suffix. `--force` permits
  replacement. 1667 does not read an exported file.
- **Project locks control concurrent writers.** A server selects a free port
  and writes `.1667/run.json`. A bare `1667 --url` uses this record. Lock
  contention identifies the owner process. The operating system releases a
  lock after a process failure.
- **`1667 init --adopt` moves legacy data into a project.** It first moves
  provider secrets to the machine tier. It refuses the operation before any
  move when it cannot adopt the complete source.
- **Project storage accepts ordinary file systems that enforce locks.** This
  change removes `--initialize-new`, `--offline-exclusive`, and the fixed
  `127.0.0.1:7373` listener. It also removes the old file-system allowlist,
  absolute `--data` requirement, and project-tier privacy scan. Strict privacy
  checks apply to the machine tier.
- **The key reference explains each visible key.** The reference groups keys
  by task. It uses available terminal columns and supports arrow-key scroll.
  Thanks @10fra for the new reference design.
- **The TUI shows the build identity.** The status bar shows the identity. The
  key reference also shows it when a narrow terminal hides the status bar.
- **1667 has an independent repository.** The terminal application and its
  embedded runtime moved out of the previous repository.

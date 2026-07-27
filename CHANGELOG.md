# Changelog

This file records notable changes to 1667. Product terms use the definitions in
the [README](README.md#technical-terms).

## Unreleased

- **1667 now supports Windows x64 release candidates.** The Windows machine
  tier installs a protected DACL for the current user and SYSTEM. Native tests
  reject reparse points. CI builds the executable and runs it through the npm
  launcher package.
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

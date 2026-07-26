# Changelog

All notable changes to 1667 will be documented in this file.

## Unreleased

- **Generation stays out of the writer's way.** Provider work now runs between
  short durable phases, then applies an operation-specific result to the
  current story without losing intervening edits. Linux race coverage includes
  Stop saves, deleted sources, manual renames, and provider teardown. Thanks
  @10fra for tracing the CI-only failures and driving the recovery work.
- **Stories are anchored to the folder you start 1667 in.** `1667` walks up for a
  `.1667/` project the way git walks up for `.git`; `1667 init` creates one, and
  `1667 --global` keeps a single machine-wide library instead. `--data` now names
  a project root and accepts relative paths. Starting outside any project asks
  once, and refuses in one line when nobody can answer.
- **Provider secrets moved to a machine tier** beside the HTTP auth records, so a
  project directory can be committed or synced while each machine supplies its
  own key. A project holding a stray `secrets.json` now fails closed and says
  where to move it.
- **`1667 export` writes the selected branch to the project root**, with chapters
  as `##` headings, a suffix for collisions, and `--force` to overwrite. 1667
  never reads a file it exported.
- **Concurrency is per project.** Servers bind a free port and publish
  `.1667/run.json`; `1667 --url` with no value attaches to it. Lock contention
  names the process holding the project, and a crash needs no cleanup.
- **`1667 init --adopt` migrates a pre-0.2 data directory** into this folder's
  project, moving provider secrets to the machine tier first and refusing before
  it moves anything if the source cannot be adopted whole.
- Removed the `--initialize-new` and `--offline-exclusive` flags, the fixed
  `127.0.0.1:7373` listener and its initialization guard, the packaged
  absolute-path requirement for `--data`, and the filesystem allowlist,
  ancestor-permission walk, and Darwin ACL scan that refused ordinary folders.
  A locking-capability probe replaces the allowlist, so iCloud, exFAT, and SMB
  work exactly when they work. Strict privacy checks now apply to the machine
  tier, which 1667 creates itself. 1,800 lines net removed. See
  [ADR 007](docs/adr/007-project-anchored-storage.md).
- Extracted the 1667 terminal application and its embedded runtime into an
  independent repository.

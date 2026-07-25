# Changelog

All notable changes to 1667 will be documented in this file.

## Unreleased

- **Stories are anchored to the folder you start 1667 in.** `1667` walks up for a
  `.1667/` project the way git walks up for `.git`; `1667 init` creates one, and
  `1667 --global` keeps a single machine-wide library instead. `--data` now names
  a project root and accepts relative paths. Starting outside any project asks
  once, and refuses in one line when nobody can answer.
- **Provider secrets moved to a machine tier** beside the HTTP auth records, so a
  project directory can be committed or synced while each machine supplies its
  own key. A project holding a stray `secrets.json` now fails closed and says
  where to move it.
- Removed the `--initialize-new` and `--offline-exclusive` flags, the fixed
  `127.0.0.1:7373` initialization guard, the packaged absolute-path requirement
  for `--data`, and the filesystem allowlist, ancestor-permission walk, and
  Darwin ACL scan that refused ordinary folders. Strict privacy checks now apply
  to the machine tier, which 1667 creates itself. See
  [ADR 007](docs/adr/007-project-anchored-storage.md).
- Extracted the 1667 terminal application and its embedded runtime into an
  independent repository.

# Contributing to 1667

Thanks for wanting to work on 1667.

## Every change starts with an issue

**Open an issue before you open a pull request.** A pull request that does not
reference an issue will not be merged, including small ones.

This is not bureaucracy for its own sake. An issue is where the *why* gets
agreed before anyone spends time on the *how*, and it is the only durable record
of intent once the diff is old. If the change is obvious, the issue can be three
sentences.

Reference it in the pull request body so GitHub links the two:

```text
Closes #123
```

If you have already written the code, open the issue anyway and link it. The
order matters less than the trail existing.

## Supported environments

1667 supports **macOS and Linux**, on arm64 and x64.

Windows is not a supported environment and no Windows build is published. The
runtime fails closed there rather than misbehaving. Please do not open pull
requests that add Windows support without an issue agreeing the approach first;
the blocker is a native DACL and reparse-safe adapter, not a missing branch.

## Requirements

- Bun 1.3.14 or newer
- Node.js 22
- Docker, to run the Linux gates

Use npm at the repository root and Bun in `tui/`. The TUI worker runs the shared
modules in `server/`, so you need both dependency trees.

```sh
npm install
cd tui && bun install
```

## Run the gates before you push

CI runs every gate on each shipped target. A pull request is not mergeable until
those gates pass on macOS arm64, Linux arm64, and Linux x64. macOS x64 is the
exception: it runs on every push to `main` rather than on pull requests, because
it is roughly ten times slower than the other targets and its runner class is
contended enough to flake. Nothing tests macOS x64 before merge, so treat a
change with target-specific risk there as needing a watch on `main` afterwards.

Running the same gates locally first is faster than waiting on a round trip, and
it is the only way to see the Linux-only suites before you push:

```sh
scripts/ci-local.sh
```

That runs every shipped target: `darwin-arm64` natively, and `linux-x64` and
`linux-arm64` in Docker. Linux has to run in a container even on a Linux host is
not the reason — it is that roughly thirty provider tests are gated on
`ownedLoopbackHttpSupportedOn`, which is Linux-only, so they skip silently on
macOS and never run otherwise.

A full green run records the commit it passed. To have pushes refused unless
that commit passed, opt into the hook with
`git config core.hooksPath .githooks`. `--only <target>` is for iterating and
deliberately does not record a pass.

## Architecture decisions are binding

The architecture decision records live in a separate
[1667-ai/architecture](https://github.com/1667-ai/architecture) repository. They
are normative: they describe invariants this code is required to hold, and
around fifty comments in `server/` and `shared/` cite them by name — `ADR006`,
`ADR007` — for rationale deliberately not repeated at the call site.

Read the relevant record before changing admission, storage, mutation
coordination, releases, or prompt caching. Each has a `read_when` list in its
frontmatter saying when it applies to you.

That repository is currently private. If you hit a comment citing an ADR you
cannot read, say so in the issue and ask for the relevant invariant — do not
guess at it from the surrounding code.

If your change conflicts with an ADR, that is a real finding worth raising in
the issue. Sometimes the ADR is what needs to change — but that is a decision to
make deliberately and record, not to route around in a diff.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat|fix|refactor|build|ci|chore|docs|style|perf|test
```

Write the body for someone who is reading it in a year with no memory of the
conversation: what was wrong, and why this is the fix.

## Tests

Fix a bug, add a regression test. Prefer a test that would have failed before
your change and passes after.

Tests that depend on a platform should inject it rather than reading
`process.platform`, so they run everywhere. `test/windows-platform-contract.test.ts`
is the pattern: it passes `platform: "win32"` explicitly and therefore runs on
macOS and Linux too.

## Pull requests

- Link the issue (`Closes #123`)
- Say what you ran, and paste the `scripts/ci-local.sh` summary
- Keep unrelated changes out; a second issue is cheap
- Note explicitly anything you could not verify

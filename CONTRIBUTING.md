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

1667 supports macOS arm64, macOS x64, Linux arm64, Linux x64, and Windows x64.

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

Pull request CI runs the gates on macOS arm64, Linux arm64, and Linux x64. A
pull request is not mergeable until those gates pass. A push to `main` also
runs the gates on macOS x64. CI does not test Windows x64.

Running the same gates locally first is faster than waiting on a round trip, and
it is the only way to see the Linux-only suites before you push:

```sh
scripts/ci-local.sh
```

On macOS arm64, this script runs `darwin-arm64` natively. It runs `linux-x64`
and `linux-arm64` in Docker. It does not run `darwin-x64` or `windows-x64`.
GitHub CI runs `darwin-x64` after a push to `main`. GitHub CI does not run
`windows-x64`.

On Windows x64, run the root gates and the TUI gates directly. Run
`bun run build:standalone` to test the Windows package candidate.

A full green run records the commit it passed. To have pushes refused unless
that commit passed, opt into the hook with
`git config core.hooksPath .githooks`. `--only <target>` is for iterating and
deliberately does not record a pass.

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

Tests that depend on a platform should inject it when possible. Native security
contract tests can read `process.platform`.
`test/windows-platform-contract.test.ts` runs only on Windows.

## Pull requests

- Link the issue (`Closes #123`)
- Say what you ran, and paste the `scripts/ci-local.sh` summary
- Keep unrelated changes out; a second issue is cheap
- Note explicitly anything you could not verify

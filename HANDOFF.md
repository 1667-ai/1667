# 1667 release work — handoff

You are picking up release engineering for `1667-ai/1667`. This file is the whole context; you
should not need to read a prior conversation.

Delete this file when the work it describes is done.

---

## Read these first, in this order

1. **`~/source/architecture/docs/adr/008-hosted-publication-and-installation.md`** — the governing
   design for publication. Also `005-trusted-releases-and-upgrades.md` and `009-install-script.md`.
2. GitHub issue **#25** — the release tracking issue.
3. `docs/RELEASING.md` in this repo.

### The rule that catches everyone

**The architecture repository is PRIVATE. Never cite it from this repo.** No ADR number, no
filename, no link, not the phrase "architecture decision record" — not in code, comments, docs,
tests, commit messages, PR bodies or issues. A citation is both a dead link for outside readers
and a leak of internal structure. State the substance of a decision inline instead.

Read them freely at `~/source/architecture`. Two pre-existing violations remain and are worth
cleaning up: `tui/README.md` and `tui/scripts/build-standalone.ts` around line 214.

---

## Where things stand

### Shipped

| Issue | What |
| --- | --- |
| #22 | `LICENSE`, `NOTICE` and a `license` field in every release package, pinned to reviewed digests |
| #48 | Deterministic SPDX 2.3 SBOM generator |
| #60 | Release evidence collector — git, tag signature against a protected signer policy |
| #61 | `windows-x64` held from publication while remaining a build target |
| #73 | `windows-x64` off the pull-request CI gate |
| #81 | GitHub pre-release workflow — **live on `main` as "Release (GitHub)"** |

The GitHub release is dispatchable now: Actions → Release (GitHub) → Run workflow, `main`,
version `0.1.0-rc.1`. It may not have been run yet — check whether a `v0.1.0-rc.1` release exists.

### Open work, in dependency order

| Issue | What | Blocks |
| --- | --- | --- |
| **#97** | `release-stage-packages.ts` and `release-pack.ts` — last two producer modules | everything npm |
| — | `release-npm.yml`, the five-job publication workflow | the OIDC verification |
| **#82** | The `tagSignature` coupling — **must be fixed before the first npm publish** | npm publish |
| #83 | Deferred release-tooling cleanups, none urgent | — |
| — | Host compatibility: baseline x64 build target, launcher floor checks | a correct npm release |

**#82 is the one not to skip.** `ReleaseSourceEvidence` types `tagSignature` as the literal
`"verified"`, and SBOM generation requires an identity set, so any producer that wants an SBOM must
assert a signature was verified whether or not one was. The preferred fix narrows the SBOM's input
to what it actually consumes — an SBOM is a bill of materials, not an authorisation record.
Accepted for the GitHub pre-release; not acceptable for npm, where evidence documents are the
point and a published version cannot be replaced.

**Host compatibility** is described in #25 and has no issue of its own yet. Builds request no Bun
target, so x64 binaries embed the runner's AVX2 runtime while the npm manifest admits every x64
host: older machines install successfully and die with `Illegal instruction`. Testing on the runner
that produced the binary cannot detect this. Baseline narrows it; the launcher still needs floor
checks for SSE4.2, macOS 13+ and glibc 2.17+, because `os`/`cpu`/`libc` carry no version.

---

## Infrastructure state — already done, do not redo

- **Tag rulesets**: `refs/tags/v*` immutable and creation restricted to repository admins;
  `refs/tags/released/v*` immutable but creatable by the workflow. Verified: `v*` does not match
  `released/v*`, so the completion tag is creatable. This matters — see the completion-tag scheme
  below.
- **`release-policy` branch**: orphan root commit, one `allowed-signers` file, PR required, direct
  push rejected. The evidence collector reads it via
  `git show refs/remotes/origin/release-policy:allowed-signers`.
- **`publish` environment**: reviewer `10fra`, prevent-self-review **on**, admin bypass off, `main`
  only. **Known deadlock**: with a single reviewer and self-review prevented, the dispatcher cannot
  approve, so nobody can. Needs a second reviewer, or self-review re-enabled. Raise it before the
  first npm publish.
- **npm Trusted Publishing**: configured for the five matrix packages against workflow filename
  **`release-npm.yml`** — use exactly that name, or infra must reconfigure all five.
- **`mfa=publish`**: NOT set on the five matrix names, deliberately. Reported as set on the three
  non-matrix names (`1667-cli`, `@1667-ai/windows-x64`, `@1667-ai/windows-arm64`) but never
  verified — the npm CLI has no read command for it.
- **Still outstanding**: a throwaway OIDC publish proving Trusted Publishing works, before deciding
  `mfa=publish` on the five. Doing it in the wrong order risks discovering mid-release that MFA
  blocks OIDC, with some packages published and some refused — unfixable, since npm will not
  replace a version.

---

## Decisions already ratified — do not relitigate

- **Monotonic release record = a second tag.** `released/v<version>` is created only after a
  successful publish. Its absence means the release never completed, so a rerun may resume; its
  presence means done. Candidate exclusion is structural rather than computed.
- **Pre-publication immutability = an externally enforced setup invariant.** The workflow never
  asserts it. Checking requires repository Administration read, which no workflow token can hold,
  and an admin-scoped credential in the publish job would be more dangerous than the check is
  worth.
- **`0.1.0` is reserved for npm.** The GitHub pre-release is `0.1.0-rc.1`.
- **No install script, and no `curl … | sh`.** A script cannot establish its own authenticity, and
  piping into a shell makes verification impossible by construction. Do not add one, link one, or
  imply one is coming.
- **`windows-x64` is held from publication** and currently not built in CI at all. Its hold reason
  says so; if CI is restored, that string must be updated in **both**
  `shared/release-targets.ts` and `release/npm/launcher.mjs` — a test compares them byte-for-byte.
- **`darwin-x64` is published**, and builds on pushes to `main` but not on pull requests. It is
  slow and flaky there, and this is a writing tool whose users skew toward older hardware.

---

## Conventions

- **Every PR must close an issue.** A workflow enforces it by grepping the PR body for a closing
  keyword. Open an issue first, even for small changes.
- Conventional Commits: `feat|fix|refactor|build|ci|chore|docs|style|perf|test`.
- Auto-merge and automatic branch updates are enabled. Arm auto-merge and let it land.
- Branch protection requires branches to be **up to date** before merging. This is doing real work
  — leave it on. It has already caught a change that was green in isolation and broken against a
  newer base.

---

## Hard-won gotchas

These each cost real time. None are obvious from the code.

**Fetch before you branch.** The local checkout has been 99 commits behind `origin/main` while
`git status` reported "up to date", because the remote-tracking ref itself was stale. An entire
implementation was written against pre-migration code and thrown away. Two later branches were cut
before a merge landed and needed repair. `git fetch origin && git rev-list --count HEAD..origin/main`
before starting anything.

**The root tsconfig does not cover `tui/`.** A green `npm run typecheck` proves nothing about the
TUI. Run all four gates when a change reaches `tui/`:

```sh
npm run typecheck
npx tsc --noEmit -p tui/tsconfig.json
npm test
cd tui && bun test
```

Also: `tsx` strips types without checking them, so tests can pass while typecheck fails.

**`git verify-tag` prints "Good signature" for a key that is NOT in the allowed-signers file.**
Only the exit code and a trailing `No principal matched.` reveal the refusal. `stderr.includes("Good")`
— the natural implementation — accepts any well-formed signature from any key. Verified against
git 2.43.0.

**Mutation-test every new gate, and check it fails the *right* test.** A mutation that breaks
everything is as uninformative as one that breaks nothing. Three times a mutation was wrong in this
work: too blunt (broke six unrelated tests), too weak (intercepted by a pre-existing check before
reaching the new gate), and accidentally stronger than intended.

**Fixtures that pin dates must pin every date.** A certificate fixture used a validity window
relative to *now* while the fixture pinned commit dates. Git verifies a tag signature at the tag's
timestamp, so the test passed the day it was written and failed the next morning with nothing
changed — reporting `no valid principals found`, which says nothing about time.

**Ask where a document goes, not just whether it is true.** The release workflow once uploaded an
evidence document as a workflow artifact. Every claim in it was contained and harmless in memory;
as a downloadable file it was a forged credential sufficient for the npm publication gate. "Is this
claim true?" is the weaker question.

**CI is flaky across the packaged matrix.** `packaged-darwin-x64` and `packaged-windows-x64` fail on
load-sensitive budgets and a tokenizer smoke that hangs on a fixed 90s timeout. Neither is a
required check. Before assuming a red is a flake, read the failure — one turned out to be a real
bug and one a real time bomb.

---

## Working style that paid off

Every module here needed a second pass, and every second pass found something the test suite could
not: a digest check comparing a value with itself, purls no scanner would match, a verifier chosen
through `PATH` rather than pinned, an SBOM routed by publication when it should follow staging, a
null-returning starter that fails only on the platform being held, and an OIDC signing job running
untrusted install scripts.

The pattern that found them: implement, run the gates yourself, then **two independent reviews** —
`/autoreview` (use `--engine claude`; Codex is unavailable here) and the
`thermo-nuclear-code-quality-review` subagent — then apply findings and mutation-test each new gate.
Verify agent claims by running things rather than reading reports.

---

## Immediate next step

Start #97. Branch from an up-to-date `main` — `stageReleaseArchive` in
`scripts/release-github-assets.ts` already assembles the file set the npm stager needs, and there is
a comment there anticipating this reuse. Do not write a second assembler.

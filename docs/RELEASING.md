---
summary: Local release-package production, preflight, and trust boundary
read_when:
  - preparing or inspecting 1667 release packages
  - changing release identity, package layout, SBOMs, or artifact manifests
  - proposing hosted publication
---

# Release packages for 1667

This repository contains a hosted npm publication workflow. A safety interlock
disables publication. SBOM generation rejects signed-tag authorization fields.
Host compatibility and registry controls must be complete before maintainers
remove the interlock.

The repository supports local release package production and preflight. It
publishes native archives as a GitHub pre-release.

Maintainers reserved the package names. Do not publish packages. Do not move
registry tags. Do not describe a candidate as an official release.

Publication also requires an explicit maintainer decision. The protected
environment must approve the publish job.

## Technical terms

This document uses these Technical Names:

| Term | Meaning |
| --- | --- |
| release target | One supported operating system and processor architecture |
| held target | A release target that is built and verified but not published |
| release package | One npm tarball in the release matrix |
| launcher package | The JavaScript package named `@1667-ai/cli` |
| platform package | A package that contains one native executable |
| candidate | A possible release package that has not received publication approval |
| build identity | Version, source, time, protocol, and target data in a native executable |
| source evidence | Trusted source, tag, version, and time data |
| release plan | The strict JSON input for release preflight |
| artifact manifest | The canonical JSON output from release preflight |
| publication attempt ref | An immutable ref that records one npm write attempt |
| SBOM | The SPDX Software Bill of Materials in each release package |
| preflight | Local validation of release packages and their evidence |

## Publication boundary

Preflight validates package evidence. Preflight does not authorize
publication.

The preflight tool does not:

- Invoke Git
- Build a native executable
- Build an npm tarball
- Extract a tarball
- Sign a file
- Access the network
- Publish a package

## Held targets

A held target is built, identified, smoke-tested and staged like any other
release target. It is not published. `heldFromPublication` in
`shared/release-targets.ts` carries the reason a target is held, and every
publication decision in this repository derives from that one field: the
launcher's `optionalDependencies`, the package matrix, the release plan length,
the pack templates, the launcher's bill of materials, and the upgrade path.
Clearing that field is the whole of releasing a held target.

Staging decisions are a different question and do not read that field. A held
target still gets a build identity, a package manifest, a `build-manifest.json`
and its own `sbom.spdx.json`, because it is still staged, packed and validated
locally. Withholding any of those would stop exercising the layout the target
will publish under, which is the one thing a hold has to keep proving.

npm requires this separation. An optional dependency that resolves to nothing
fails softly, so a launcher that pinned an unpublished platform package would
install cleanly on that platform and then fail at every launch. npm does not
allow a published version to be replaced, so correcting it needs a new launcher
release. The launcher therefore never names a held target's package, and refuses
that target by name: its platform is supported and its executable is built, and
only the package is withheld.

`windows-x64` is currently held.

## Release package matrix

The release matrix contains exactly five release packages:

| Release target | Package name | `buildIdentity` |
| --- | --- | --- |
| Launcher | `@1667-ai/cli` | `null` |
| macOS arm64 | `@1667-ai/darwin-arm64` | Trusted native identity |
| macOS x64 | `@1667-ai/darwin-x64` | Trusted native identity |
| Linux arm64 | `@1667-ai/linux-arm64` | Trusted native identity |
| Linux x64 | `@1667-ai/linux-x64` | Trusted native identity |

The matrix contains one launcher package and four platform packages.

Routine CI does not build `windows-x64`. Its package,
`@1667-ai/windows-x64`, is not in this matrix, is not in the launcher's optional
dependencies, is not packed by the release pack step, and is not published.
Run the Windows native tests and package smoke before Windows release work
resumes.

All release packages declare the canonical Git repository. The Linux platform
packages declare `libc: ["glibc"]`. The launcher package and the macOS platform
packages do not declare `libc`.

## Package contents

Each of the five release packages contains these files:

- `package.json`, which declares `"license": "Apache-2.0"`
- The executable for the package, which is `bin/1667.js` in the launcher
  package, or the native executable in a platform package
- `build-manifest.json`
- `sbom.spdx.json`
- `LICENSE`
- `NOTICE`

The pack step copies `LICENSE` and `NOTICE` from the repository root. Do not
change these two files for one package. All five packages must contain the same
bytes.

Preflight pins both files to reviewed digests held in
`scripts/release-package-manifests.ts`, and rejects any package whose `LICENSE`
or `NOTICE` entry does not match. Comparing the five packages with each other
would only prove they agree, which staging the same wrong or truncated file five
times also satisfies. Editing either file therefore requires updating the pinned
digests in the same commit; a test compares the pins against the repository
files, so a stale pin fails the build.

The Apache License, Version 2.0 makes this content necessary. Section 4(a)
requires a copy of the licence for each recipient of the work. Section 4(d)
requires the `NOTICE` content in each distribution. An npm tarball is a
distribution. A package that declares no licence also shows as `UNLICENSED` in
the registry. npm cannot replace a version after publication. Therefore each
package must contain this content before publication.

## Required trusted inputs

Collect these inputs before preflight:

1. Use a clean source commit.
2. Create an annotated `v<SemVer>` tag that targets the source commit.
3. Run trusted signature verification with `git verify-tag <tag>`.
4. Select one millisecond-precision UTC build timestamp for all targets.
5. Use the same version in the root package, TUI package, and root lockfile.
6. Run `--version --json` on each of the four published native executables.
7. Pack the launcher package and the four published platform packages.

A held target's executable is built and smoke-tested, but the release plan has
one entry per release package, so its identity has no slot in the plan.

Each release package must contain `build-manifest.json`, `sbom.spdx.json`,
`LICENSE`, and `NOTICE`. Each platform package must also contain its native
executable.

The release plan uses `tagSignature: "verified"` for step 3. Each native
`buildIdentity` records the result from step 6. Preflight trusts both fields.

Preflight checks agreement between the claims and package contents. Preflight
also binds the claims to the tarball digests.

## Stage and pack release packages

Put each native executable in this directory structure:

```text
<builds>/<release-target>/<executable>
```

Stage the five published release packages:

```sh
npm run release:stage -- \
  <version> <source-commit> <build-timestamp> <builds> <staging>
```

The stage command writes one directory for each published release package. It
uses the same content assembler as the GitHub archive producer. It adds the
package manifest to each directory.

The stage command sets each file modification time to the release build
timestamp. It also sets each directory modification time to that timestamp.
This action makes repeated pack operations reproducible for the same inputs.
The stage command moves the staging directory into place only after all five
packages pass validation.

Pack the five directories:

```sh
npm run release:pack -- <version> <staging> <tarballs>
```

Run the pack command through npm. The command uses the exact Node executable
and npm CLI that started the npm script. The command refuses relative tool
paths.

The pack command disables lifecycle scripts. It validates each output tarball
against the release package policy. It writes the tarball path, SHA-256, and
size to standard output as canonical JSON.
The pack command moves the tarball directory into place only after all five
tarballs pass validation.

The batch commands exclude each held target. Use `stageReleasePackage` and
`packReleasePackage` to keep a held target package under native verification.
Do not add a held target to the publication batch.

## Run preflight

Run this command:

```sh
node --import tsx scripts/release-preflight.ts /absolute/path/to/plan.json \
  > /absolute/path/to/release-artifact-manifest.json
```

Run the command from the repository root. The tool resolves relative tarball
paths from the directory that contains `plan.json`.

The tool writes the canonical artifact manifest to standard output. The output
does not have a trailing newline.

The tool writes this SHA-256 record to standard error:

```text
release-manifest-sha256 <64 lowercase hex characters>
```

The SHA-256 value covers the exact standard-output bytes.

## Release plan

The release plan must use strict JSON. The `artifacts` array must contain
exactly one entry per release package, and therefore exactly five entries.

This excerpt shows the source evidence and one launcher entry. The excerpt is
not a complete release plan.

```json
{
  "schemaVersion": 1,
  "sourceEvidence": {
    "schemaVersion": 1,
    "productVersion": "1.2.3",
    "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
    "sourceDirty": false,
    "tagName": "v1.2.3",
    "tagObjectType": "annotated",
    "tagSignature": "verified",
    "tagTargetCommit": "0123456789abcdef0123456789abcdef01234567",
    "buildTimestamp": "2026-07-23T10:20:30.000Z",
    "packageVersions": {
      "root": "1.2.3",
      "tui": "1.2.3",
      "rootLock": "1.2.3",
      "rootLockPackage": "1.2.3"
    }
  },
  "artifacts": [
    {
      "tarballPath": "1667-ai-cli-1.2.3.tgz",
      "buildIdentity": null
    }
  ]
}
```

Use `buildIdentity: null` only for the launcher package. Each platform entry
must contain the trusted build identity from its native executable.

Preflight rejects missing, duplicate, extra, or unsupported packages. It also
rejects package identities that do not agree with the source evidence.

## Hosted npm publication

`.github/workflows/release-npm.yml` is the hosted npm publication workflow. npm
Trusted Publishing trusts this exact workflow path for the five release
packages.

The workflow accepts a manual dispatch from the default branch. The input is
one version without a leading `v`. The signed `v<version>` tag must target the
dispatch commit.

The workflow has these jobs:

1. `build` builds and observes the four published native executables.
2. `launcher` stages and packs the five release packages.
3. `preflight` verifies the package set and retains the result.
4. `publish` publishes the four platform packages before the launcher package.
5. `release` verifies publication and publishes the GitHub pre-release.

The workflow uses one non-cancelling lock for all npm releases. A failed job can
use the retained inputs from the same workflow run. The registry check accepts
an existing version only when its digest and provenance are correct.
It binds the provenance certificate to this repository, workflow, and ref.

The publish job creates a publication attempt ref before each npm write. The ref
binds the package target and tarball digest to the release commit. A retry does
not immediately repeat a write that has a publication attempt ref. It first
waits for the first write to become visible. If the wait expires, the job tries
the same immutable version again. npm rejects an existing version without a
replacement. The job then continues the visibility check.

A `released/v<version>_quarantined` ref blocks publication for that version.
The ref is immutable. The publish job checks this ref before it reads npm
metadata.

The workflow publishes with the npm `next` tag. It waits for the platform
packages before it publishes the launcher package. It creates
`released/v<version>` only after npm and GitHub publication are complete.
The final registry check requires `next` to name this version for all five
packages.
The workflow fully verifies each package before it writes the next package.

The workflow does not accept an npm token. The jobs with OIDC authority disable
dependency lifecycle scripts. Each job verifies retained inputs before it uses
them.

The `preflight`, `publish`, and `release` jobs run the publication readiness
check before they create signed-tag evidence. The check currently stops
publication. The SBOM boundary is complete. The remaining prepublication
controls must be complete before maintainers enable publication.

## Local gates

Run the root gates from the repository root:

```sh
npm run build
npm test
```

Run the TUI gates from `tui/`:

```sh
bun run typecheck
bun test
bun bench/perf.ts
bun run build:standalone
```

`bun run build:standalone` compiles and runs one native executable. By default,
the executable contains a development build identity.

Supply the target-specific release build identity for a release candidate:

```sh
AI_1667_BUILD_IDENTITY_JSON='<trusted release identity JSON>' \
  bun run build:standalone
```

Use an identity that agrees with the source evidence. Run the release-candidate
build on each release target:

- `darwin-arm64`
- `darwin-x64`
- `linux-arm64`
- `linux-x64`
- `windows-x64`

All five candidates verify:

- Embedded build identity
- Protection from host `bunfig.toml` and `.env` files
- Demo frame output
- Command-line value validation
- Read-only project diagnostics
- Cold embedded frame output
- Prompt-tokenizer vectors
- Executable relocation
- Stable machine-wide project storage
- Safe use of existing project roots

The macOS candidates verify that supervised server mode refuses the unsupported
platform. The Windows candidate verifies the same refusal. The Linux candidates
also verify supervised child replacement, parent-death containment,
default-port publication, and lock guidance.

The Windows candidate also verifies the protected machine-tier DACL. It rejects
reparse points. It stages the exact npm package layout, packs it, validates both
tarballs against release package policy, and installs them. Because
`windows-x64` is held, it then verifies that the installed launcher refuses the
target by naming the hold, and executes the installed executable directly.
Clearing the hold restores the launcher run without another change to the
smoke.

## GitHub pre-release of native archives

`.github/workflows/release-github.yml` publishes one archive per published
release target. A maintainer dispatches it from the default branch and supplies
the version. The workflow refuses every other ref, and refuses a dirty
checkout.

`shared/release-targets.ts` decides which targets are published, in the single
`heldFromPublication` field each target carries. `windows-x64` is held from
publication today, and routine CI does not build it either, so its hold reason
says plainly that it is unverified and the release notes tell a reader who
builds it from source to treat that build as untested. A held target returns to
the published set — matrix, notes table, held-target paragraph and archive set
alike — when that one field is cleared. No release script keeps a target list of
its own.

The dispatched version must match the root package, the TUI package, and the
lockfile. The `check` command refuses any other value, in the `prepare` job.

Exactly three strings cross a job boundary: the version, the source commit, and
one build timestamp. The `prepare` job publishes them as job outputs, and every
later job rebuilds its release identity in memory from them. That is why every
archive in a run carries the same `build-manifest.json` identity.

The workflow never writes a source evidence document and never uploads one. A
`ReleaseSourceEvidence` value types `tagObjectType` as `"annotated"` and
`tagSignature` as `"verified"`, so any copy of it asserts a verified signed tag
that this workflow neither obtains nor checks — and the tag does not exist until
the release job creates it. Preflight accepts that same document as the
signed-tag evidence for npm publication, which cannot be withdrawn, so a
downloadable copy would be a ready-made credential for that gate. The signature
claim stays in memory: no file the release ships carries `tagSignature` or
`tagObjectType`. `tagName` does ship, in the SPDX package comment, where it
names the tag the release creates at the source commit.

SBOM generation does not consume `ReleaseSourceEvidence`. It consumes an exact
`ReleaseSbomSource` record. This record contains the product version, source
commit, build timestamp, and tag name. The SBOM input rejects additional
fields. SBOM generation cannot accept a signed-tag authorization claim.

Each archive is named `1667_<version>_<target>.tar.gz`. It contains one
directory with the same name. Underscores separate the three fields because a
prerelease version and a target both contain hyphens: `1667_0.1.0-rc.1_linux-x64`
states where the version ends and `1667-0.1.0-rc.1-linux-x64` does not. That
directory contains the native executable,
`LICENSE`, `NOTICE`, `build-manifest.json`, and `sbom.spdx.json`. A downloaded
archive is a distribution, so Apache License section 4(a) and section 4(d)
apply to it exactly as they apply to an npm tarball. Both files travel inside
the archive, at the same reviewed digests preflight pins.

`scripts/release-github-assets.ts` holds the file set, the staging command, and
the checksum format. `scripts/release-source-facts.ts` holds the three source
facts and turns them into release identities. `scripts/release-archive.ts` holds
the archive names and the checksum file name. `scripts/release-github-notes.ts`
holds the release notes. `test/release-github-assets.test.ts` covers all four,
including the absence of any uploaded evidence document. The workflow contains
no file list and no target list.

Staging refuses to assemble an archive that lacks `LICENSE` or `NOTICE`. The
release workflow runs `node --import tsx`, which strips types without checking
them, so the tuple type and the tests are not in the release path; that check
is, and it names the missing file and the target.

`checksums.txt` lists the SHA-256 of every uploaded asset except itself.

The workflow attests every uploaded file with
`actions/attest-build-provenance`, using `id-token: write` and
`attestations: write` in that job alone. A reader verifies one archive with
`gh attestation verify <file> --repo 1667-ai/1667`.

This path does not verify a tag signature, and the release notes claim none.
The attestation is the evidence a GitHub pre-release offers. npm publication
still requires the trusted inputs above.

## Retain release evidence

Inspect the canonical artifact manifest. Retain the artifact manifest and its
SHA-256 value.

Retain the tag-verification evidence. Retain the native build-identity
observations.

A successful preflight is necessary package evidence. It is not publication
authorization.

A successful preflight does not authorize publication on its own.

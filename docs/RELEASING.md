---
summary: Local release-package production, preflight, and trust boundary
read_when:
  - preparing or inspecting 1667 release packages
  - changing release identity, package layout, SBOMs, or artifact manifests
  - proposing hosted publication
---

# Release packages for 1667

This repository contains a hosted npm publication workflow. The
prepublication registry controls are complete. SBOM generation rejects tag
authorization fields.

This product has no user yet. A release tag needs no signature now. The
signature requirement will return before this product has a user. This
document says so plainly at each place a signature was required before.

The repository supports local release package production and preflight. It
publishes native archives as a GitHub release. A prerelease version publishes
a prerelease. Every other version publishes a release.

Maintainers reserved the package names. Publish release packages only through
the hosted workflow. Do not publish held targets. Do not move registry tags
outside a controlled operation. Do not describe a candidate as an official
release.

Publication also requires an explicit maintainer decision.

## Technical terms

This document uses these Technical Names:

| Term | Meaning |
| --- | --- |
| release target | One supported operating system and processor architecture |
| held target | A release target that publication batches exclude |
| release package | One npm tarball in the release matrix |
| launcher package | The JavaScript package named `@1667-ai/cli` |
| platform package | A package that contains one native executable |
| candidate | A possible release package that has not received publication approval |
| Installer | A Shell Installer or a PowerShell Installer |
| Shell Installer | A channel-specific release script that installs one native executable |
| PowerShell Installer | A Windows release script that installs one native executable |
| Managed Installation | An installation that an Installer creates and registers |
| Ownership Record | The durable file that grants 1667 authority to replace one executable |
| Release Archive | The target-specific native archive in an immutable GitHub release |
| POSIX ustar | The archive format that the release workflows use |
| build identity | Version, source, time, protocol, and target data in a native executable |
| source evidence | Trusted source, tag, version, and time data |
| release plan | The strict JSON input for release preflight |
| artifact manifest | The canonical JSON output from release preflight |
| publication attempt ref | An immutable ref that records one npm write attempt |
| SBOM | The SPDX Software Bill of Materials in each release package |
| preflight | Local validation of release packages and their evidence |
| Bun baseline runtime | The Bun runtime for x64 processors that support SSE4.2 |

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

A held target stays in the release policy. Publication batches exclude it.
`heldFromPublication` in `shared/release-targets.ts` contains the reason for the
hold. This field controls the launcher's `optionalDependencies`, the release
plan, the pack templates, the launcher's bill of materials, and the upgrade
path.

A maintainer can build and smoke-test a held target. Local release tools can
identify, stage, and pack it for verification. Batch commands do not do this
work. The hosted npm workflow also has an explicit runner matrix for published
targets. Add and verify its native build job before you clear a hold.

npm requires this separation. An optional dependency that resolves to nothing
fails softly, so a launcher that pinned an unpublished platform package would
install cleanly on that platform and then fail at every launch. npm does not
allow a published version to be replaced, so correcting it needs a new launcher
release. The launcher therefore never names a held target's package. It refuses
that target by name. Its platform is supported, and a developer can build its
executable from source. The package is withheld.

No release target is currently held.

## Release package matrix

The release matrix contains exactly six release packages:

| Release target | Package name | `buildIdentity` |
| --- | --- | --- |
| Launcher | `@1667-ai/cli` | `null` |
| macOS arm64 | `@1667-ai/darwin-arm64` | Trusted native identity |
| macOS x64 | `@1667-ai/darwin-x64` | Trusted native identity |
| Linux arm64 | `@1667-ai/linux-arm64` | Trusted native identity |
| Linux x64 | `@1667-ai/linux-x64` | Trusted native identity |
| Windows x64 | `@1667-ai/windows-x64` | Trusted native identity |

The matrix contains one launcher package and five platform packages.

Routine CI builds and tests `windows-x64`. It runs the PowerShell Installer
end-to-end tests. It also runs the Windows package smoke through the launcher.

All release packages declare the canonical Git repository. The Linux platform
packages declare `libc: ["glibc"]`. The launcher package and the macOS platform
packages do not declare `libc`.

## Host compatibility

The Intel macOS and Intel Linux executables use the Bun baseline runtime.
This runtime requires an x64 CPU with SSE4.2.
The macOS executables require macOS 13.0 or newer.
The Linux executables require glibc 2.17 or newer.

The launcher checks these requirements before it reads package files.
The launcher does not start the native executable when a check fails.
It gives an error that identifies the failed requirement.
It also fails when it cannot verify a required host fact.

Linux HTTP mode requires Linux kernel 6.8 or newer.
The data filesystem must support durable Linux file handles.
The HTTP server checks this requirement when it starts.

## Package contents

Each of the six release packages contains these files:

- `package.json`, which declares `"license": "Apache-2.0"`
- The executable for the package, which is `bin/1667.js` in the launcher
  package, or the native executable in a platform package
- `build-manifest.json`
- `sbom.spdx.json`
- `LICENSE`
- `NOTICE`

The pack step copies `LICENSE` and `NOTICE` from the repository root. Do not
change these two files for one package. All six packages must contain the same
bytes.

Preflight pins both files to reviewed digests held in
`scripts/release-package-manifests.ts`, and rejects any package whose `LICENSE`
or `NOTICE` entry does not match. Comparing the six packages with each other
would only prove they agree, which staging the same wrong or truncated file six
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
2. Create a `v<SemVer>` tag that targets the source commit. The tag can be
   annotated or lightweight. An annotated tag must point directly at the
   source commit.
3. Select one millisecond-precision UTC build timestamp for all targets.
4. Use the same version in the root package, TUI package, and root lockfile.
5. Run `--version --json` on each of the five published native executables.
6. Pack the launcher package and the five published platform packages.

If you verify a held target, its identity has no slot in the release plan. The
release plan has one entry per release package.

Each release package must contain `build-manifest.json`, `sbom.spdx.json`,
`LICENSE`, and `NOTICE`. Each platform package must also contain its native
executable.

`scripts/release-evidence.ts` collects the tag's real shape. It records
`tagObjectType` as `"annotated"` or `"lightweight"`. It records `tagSignature`
as `"unsigned"`. It rejects an annotated tag that contains signature armor.
It resolves the tag object once. It refuses the release if the tag moves during
collection. It verifies no signature. This product has no user yet, so a
release tag needs no signature. The signature requirement will return before
this product has a user.

`scripts/release-evidence.ts` still checks these facts about the source:

- The source commit is reachable from the protected default branch.
- The tag targets the source commit.
- The root package, TUI package, and root lockfile agree on one version.
- The tag name matches that version.

The `tag: v* immutable` ruleset must be active. It blocks tag updates and tag
deletions. It has no bypass actor. It does not block tag creation. The workflow
pins the ruleset ID and revision. A ruleset change stops the release.

The `publish` job resolves the remote release tag before it creates a draft
release. The tag must target the dispatch commit. The job verifies the draft
title, notes, channel, and assets. It reuses a matching draft. It refuses a
draft that does not match. It publishes the draft and verifies the immutable
release. It then writes to npm. It resolves the locked tag before each npm
write. It creates the completion record last.

The release plan carries the collected `tagObjectType` and `tagSignature`
values. Each native `buildIdentity` records the result from step 5. Preflight
trusts all these fields.

Preflight checks agreement between the claims and package contents. Preflight
also binds the claims to the tarball digests.

## Stage and pack release packages

Put each native executable in this directory structure:

```text
<builds>/<release-target>/<executable>
```

Stage the six published release packages:

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
The stage command moves the staging directory into place only after all six
packages pass validation.

Pack the six directories:

```sh
npm run release:pack -- <version> <staging> <tarballs>
```

Run the pack command through npm. The command uses the exact Node executable
and npm CLI that started the npm script. The command refuses relative tool
paths.

The pack command disables lifecycle scripts. It validates each output tarball
against the release package policy. It writes the tarball path, SHA-256, and
size to standard output as canonical JSON.
The pack command moves the tarball directory into place only after all six
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
exactly one entry per release package, and therefore exactly six entries.

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
    "tagObjectType": "lightweight",
    "tagSignature": "unsigned",
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

`tagObjectType` also accepts `"annotated"`. The current collector accepts an
annotated tag only when the tag contains no signature armor. `tagSignature`
accepts only `"unsigned"`. No current component verifies a tag signature.

Preflight rejects missing, duplicate, extra, or unsupported packages. It also
rejects package identities that do not agree with the source evidence.

## Hosted npm publication

`.github/workflows/release-npm.yml` is the hosted npm publication workflow. npm
Trusted Publishing trusts this exact workflow path for the six release
packages.

The workflow accepts a manual dispatch on the `v<version>` tag. The tag needs no
signature: this product has no user yet, and the signature requirement will
return before it has one. The input is one version without a leading `v`. The
dispatch ref must be `refs/tags/v<version>`. The workflow refuses every other
ref.

Dispatch the workflow with this command:

```sh
gh workflow run release-npm.yml --ref "v<version>" -f version=<version>
```

The dispatch records the tag commit as the release source commit. The tag
ruleset prevents a later change to that tag. The workflow resolves the tag
before it creates the draft. It checks the tag before it writes to npm. It
checks the tag before and after it makes the release immutable. The workflow
refuses a release commit that the default branch cannot reach. The completion
record also binds to that commit.

The workflow has five jobs:

1. `authorize` verifies the dispatcher before it starts release work.
2. `build` builds and observes the five published native executables.
3. `launcher` stages and packs the six release packages.
4. `preflight` verifies the package set and retains the result.
5. `publish` completes the publication.

The `publish` job completes these phases:

1. It creates and verifies the GitHub release draft.
2. It makes the GitHub release immutable.
3. It publishes the five platform packages before the launcher package.
4. It records completion.

A failed job can use the retained inputs from the same workflow run. The
registry check accepts an existing version only when its digest and provenance
are correct.
It binds the provenance certificate to this repository, workflow, and ref.
The `release-publication` Actions artifact supports the preflight handoff.
The immutable GitHub release retains the tarballs, native observations, and
artifact manifest. Promotion does not depend on the Actions artifact retention
period.

The publish job creates a publication attempt ref before each npm write. The ref
binds the package target and tarball digest to the release commit. A retry does
not immediately repeat a write that has a publication attempt ref. It first
waits for the first write to become visible. If the wait expires, the job tries
the same immutable version again. npm rejects an existing version without a
replacement. The job then continues the visibility check.

The workflow publishes with the npm tag the version selects. A prerelease
publishes to `beta`. Every other version publishes to `latest`. npm performs its
Trusted Publishing exchange inside `npm publish` and nowhere else, so a dist-tag
cannot move afterwards, and the version therefore decides the channel.

The workflow waits for the platform packages before it publishes the launcher
package. It creates
`released/v<version>` only after npm and GitHub publication are complete.
The final registry check requires that same tag to name this version for all six
packages.
The workflow fully verifies each package before it writes the next package.

The workflow does not accept an npm token. The jobs with OIDC authority disable
dependency lifecycle scripts. Each job verifies retained inputs before it uses
them.

The `preflight` and `publish` jobs run the publication readiness check before
they collect the tag's evidence. The check permits publication because the
prepublication controls are complete.

A release reaches users when the workflow finishes. There is no promotion step.
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
Intel macOS and Intel Linux builds select the Bun baseline runtime.
Arm64 builds use the native Bun runtime.

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
tarballs against release package policy, and installs them. It then executes
the installed package through the launcher.

## Managed installation and upgrades

The Installers and `1667 upgrade` follow ADR 010.

The release produces channel-specific Installers:

- `install-beta.sh` for every valid release version
- `install-stable.sh` only for a non-prerelease SemVer
- `install-beta.ps1` for every valid release version
- `install-stable.ps1` only for a non-prerelease SemVer

Each script embeds these values:

- one exact version;
- one exact channel;
- one GitHub repository;
- one immutable release tag URL base;
- each applicable Release Archive name;
- each applicable Release Archive SHA-256 digest.

The script never resolves the latest GitHub release. The script never reads npm
tags.

`scripts/release-install-script.ts` renders the scripts from those digests. The
release workflow calls that generator. It does not keep a second target list or
a second script template.

The release workflow writes each Release Archive in POSIX ustar format. It
disables macOS metadata copies. Each Installer bounds the compressed archive.
The Shell Installer also bounds the complete decompressed archive. Each
Installer validates the Release Archive layout. Each Installer rejects links,
special files, duplicate paths, and unknown paths. The Shell Installer extracts
`1667`. The PowerShell Installer extracts `1667.exe`.

The canonical hosted path is `.github/workflows/release-npm.yml`:

1. The matrix build jobs build and observe each native executable.
2. The launcher job stages Release Archives from those same executable bytes.
3. The launcher job renders the Shell and PowerShell Installers from the archive
   digests.
4. The `publish` job creates and verifies the GitHub release draft.
5. The `publish` job makes the release immutable before npm publication.

The launcher job does not rebuild native executables. The `publish` job does
not rebuild them either.

A Managed Installation writes `.1667-install.json` next to the executable. Only
a valid Ownership Record grants installation authority. npm, source, and copied
installations stay read-only to `1667 upgrade`.

`1667 upgrade` downloads the Platform Package from the canonical npm registry.
It verifies the SHA-512 integrity value. It extracts the Candidate. It probes
the build identity. It uses a recoverable transaction to replace the
executable. The transaction stays in the Install Root.

`1667 upgrade --rollback` works offline.

Windows does not replace the running `1667.exe` file. On Windows, `1667 upgrade`
verifies the available release and shows the applicable PowerShell Installer
command. The command downloads `install-stable.ps1` from the exact, immutable
`v<version>` GitHub release that the plan selected; it does not re-resolve the
moving homepage route. Exit 1667 before you run that command. Run the same
command again for an upgrade. The PowerShell Installer keeps the Installation
ID. Windows does not support `1667 upgrade --rollback`.

Background update checks stay notify-only. They never install a Candidate.

The homepage must serve bytes that match one attested channel Installer for the
promoted release.

Do not advertise an Installer command before the homepage serves that route.
`https://1667.ai/install.ps1` stays absent until a promotion sets
`powershellInstallerSha256`. Complete the release and the promotion first. Then
advertise the PowerShell Installer command.

## End-to-end release gate

Verify both Installers and the applicable upgrade path before you change the
homepage install commands.

Run this command:

```sh
npm run release:verify-install-upgrade -- --from-version <semver> [--from-channel beta|stable]
```

The `--from-version` argument is required. The `--from-channel` argument
defaults to `beta`.

The command verifies a stable release. It compares the Installer on the
homepage, which is always the stable Installer, against the Installer asset of
the release, and it asserts the stable channel in every step. The command
refuses a prerelease checkout and tells you why. Run the command for the stable
release that follows the prerelease.

The command needs `curl`, `gh`, `npm`, and `bun`.

Install both dependency sets first. Step 10 runs the source entry with `bun`,
and that entry imports from `tui/node_modules`. `npm ci` does not create that
directory.

```sh
npm ci
cd tui && bun install --frozen-lockfile && cd ..
```

The command does all of its work in a temporary directory below
`~/.cache/1667-tests`. It removes that directory when it stops.

The command does these checks:

1. It uses `curl` to download the homepage script and the canonical GitHub
   installer script. It verifies byte equality, shell syntax, and the GitHub
   attestation.
2. It executes the verified homepage bytes in a private prefix. It verifies the
   current release identity and the Ownership Record.
3. It verifies the up-to-date result from `1667 upgrade --check` and
   `1667 upgrade`.
4. It executes the verified homepage bytes in the same prefix again. It
   verifies that the script refuses the existing executable.
5. It executes `1667 upgrade --rollback` without a previous executable. It
   verifies the error result and the active executable.
6. It downloads and verifies the previous installer script. It executes the
   verified bytes. It verifies the previous release identity and the Ownership
   Record.
7. It copies the previous executable without the Ownership Record. It verifies
   that `1667 upgrade` does not replace the copy.
8. It upgrades the previous Managed Installation. It verifies upgrade,
   rollback, re-upgrade, no-op, and channel-change results. The beta channel can
   hold a release that is more recent than the stable channel. The command first
   asks the beta channel what it offers. It then verifies the applied result
   against that answer.
9. It installs `@1667-ai/cli` in the temporary directory. It executes the check
   and apply paths. It verifies that the npm installation stays externally
   managed.
10. It executes the check and apply paths from the source checkout. It verifies
    that the source installation stays externally managed.

On Windows x64, run this command:

```powershell
node --import tsx --import ./test/setup.ts --test test/release-install-powershell.test.ts
```

The test downloads `install.ps1` through a loopback HTTP server. It pipes the
downloaded script to PowerShell. It verifies these cases:

1. A fresh installation succeeds.
2. The same installation command succeeds again.
3. A running `1667.exe` blocks replacement and gives the retry instruction.
4. The same installation command upgrades the executable after 1667 exits.
5. The Installer keeps the `installationId` value during an upgrade.
6. The Installer does not replace an unmanaged executable.
7. The Installer rejects an incorrect SHA-256 digest.
8. A new attempt succeeds in a root where an attempt failed before.
9. The Installer refuses a root that holds a file it does not own.
10. The Installer rejects an incorrect build identity.

## Native archives

`.github/workflows/release-npm.yml` builds one Release Archive per published
release target, alongside the npm packages. `shared/release-targets.ts` decides
which targets it publishes. The `heldFromPublication` field contains this
decision. The current release publishes `windows-x64`. Routine CI builds and
tests this target.

The workflow uses three source facts to stage each archive. The facts are the
version, the source commit, and the build timestamp. They make no tag
authorization claim. Only `scripts/release-evidence.ts` creates
`ReleaseSourceEvidence`.

SBOM generation does not consume `ReleaseSourceEvidence`. It consumes an exact
`ReleaseSbomSource` record. This record contains the product version, source
commit, build timestamp, and tag name. The SBOM input rejects additional
fields. SBOM generation cannot accept a tag authorization claim.

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
the checksum format. `scripts/release-source-facts.ts` holds the source facts
and turns them into release identities. `scripts/release-archive.ts` holds the
archive names and the checksum file name. `test/release-github-assets.test.ts`
covers all three.

Staging refuses to assemble an archive that lacks `LICENSE` or `NOTICE`. The
release workflow runs `node --import tsx`, which strips types without checking
them, so the tuple type and the tests are not in the release path; that check
is, and it names the missing file and the target.

`checksums.txt` lists the SHA-256 of every uploaded asset except itself.

The workflow attests every uploaded file with
`actions/attest-build-provenance`, using `id-token: write` and
`attestations: write` only in the jobs that mint an attestation. A reader
verifies one archive with `gh attestation verify <file> --repo 1667-ai/1667`.

## Retain release evidence

Retain the artifact manifest, its SHA-256 value, the tag's evidence, and the
native build-identity observations.

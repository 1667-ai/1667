---
summary: Local release-package preflight and its trust boundary
read_when:
  - preparing or inspecting 1667 release packages
  - changing release identity, package layout, SBOMs, or artifact manifests
  - proposing hosted publication
---

# Release preflight for 1667

This repository does not support hosted publication. It supports local release
preflight only.

Maintainers reserved the package names. Do not publish packages. Do not move
registry tags. Do not describe a candidate as an official release.

Publication still requires a separate publication ADR. Maintainers must
approve that ADR. The repository must implement that ADR before publication.

## Technical terms

This document uses these Technical Names:

| Term | Meaning |
| --- | --- |
| release target | One supported operating system and processor architecture |
| release package | One npm tarball in the release matrix |
| launcher package | The JavaScript package named `@1667-ai/cli` |
| platform package | A package that contains one native executable |
| candidate | A possible release package that has not received publication approval |
| build identity | Version, source, time, protocol, and target data in a native executable |
| source evidence | Trusted source, tag, version, and time data |
| release plan | The strict JSON input for release preflight |
| artifact manifest | The canonical JSON output from release preflight |
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

## Release package matrix

The release matrix contains exactly five release packages:

| Release target | Package name | `buildIdentity` |
| --- | --- | --- |
| Launcher | `@1667-ai/cli` | `null` |
| macOS arm64 | `@1667-ai/darwin-arm64` | Trusted native identity |
| macOS x64 | `@1667-ai/darwin-x64` | Trusted native identity |
| Linux arm64 | `@1667-ai/linux-arm64` | Trusted native identity |
| Linux x64 | `@1667-ai/linux-x64` | Trusted native identity |

The matrix contains one launcher package and four platform packages. The
release matrix does not contain a Windows package.

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
6. Run `--version --json` on each of the four native executables.
7. Pack the launcher package and the four platform packages.

Each release package must contain `build-manifest.json`, `sbom.spdx.json`,
`LICENSE`, and `NOTICE`. Each platform package must also contain its native
executable.

The release plan uses `tagSignature: "verified"` for step 3. Each native
`buildIdentity` records the result from step 6. Preflight trusts both fields.

Preflight checks agreement between the claims and package contents. Preflight
also binds the claims to the tarball digests.

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
exactly five entries.

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

All four candidates verify:

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
platform. The Linux candidates also verify supervised child replacement,
parent-death containment, default-port publication, and lock guidance.

Windows is not a release target. Repository tests verify the Windows
fail-closed contracts separately.

## Retain release evidence

Inspect the canonical artifact manifest. Retain the artifact manifest and its
SHA-256 value.

Retain the tag-verification evidence. Retain the native build-identity
observations.

A successful preflight is necessary package evidence. It is not publication
authorization.

See [ADR 005](https://github.com/1667-ai/architecture/blob/main/docs/adr/005-trusted-releases-and-upgrades.md)
for the normative release policy.

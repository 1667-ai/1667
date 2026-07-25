---
summary: Local ADR-005 release-package preflight and its trust boundary
read_when:
  - preparing or inspecting 1667 release packages
  - changing release identity, package layout, SBOMs, or artifact manifests
  - proposing hosted publication
---

# Releasing 1667

Hosted publication is not enabled. ADR 005 implements local identity and
package-policy preflight only. Do not reserve names, publish packages, move
registry tags, or describe an artifact as an official release until a separate
publication ADR is accepted and implemented.

## Required trusted inputs

Before preflight, collect:

1. A clean source commit and matching annotated `v<SemVer>` tag.
2. A successful trusted local `git verify-tag <tag>` result.
3. One millisecond-precision UTC build timestamp shared by all targets.
4. Matching root, TUI, and lockfile versions.
5. A trusted `--version --json` observation from each native executable.
6. Exactly six already-packed tarballs: launcher plus five platform packages.

The plan's `tagSignature: "verified"` and native `buildIdentity` fields are
claims representing steps 2 and 5. The tool checks their internal agreement
and binds them to tarball digests; it does not invoke Git, build, execute, sign,
or publish.

## Preflight

```sh
node --import tsx scripts/release-preflight.ts /absolute/path/to/plan.json \
  > /absolute/path/to/release-artifact-manifest.json
```

The canonical artifact manifest is written to stdout without a trailing
newline. Its SHA-256 is calculated over those exact stdout bytes and written to
stderr as:

```text
release-manifest-sha256 <64 lowercase hex characters>
```

The plan is strict JSON. This shape excerpt is not runnable until `artifacts`
contains the required launcher plus five native entries:

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
      "tarballPath": "1667-1.2.3.tgz",
      "buildIdentity": null
    }
  ]
}
```

`artifacts` must contain exactly six entries. The launcher identity is `null`;
each native entry contains its trusted observed build identity.

## Local gate

Before handing package evidence to any future publication system:

```sh
npm run typecheck
npm test
cd tui
bun run typecheck
bun test
bun run build:standalone
```

Also inspect the canonical manifest and independently retain the tag-verification
and native-identity evidence. Passing local preflight is necessary package
evidence, not publication authorization.

The standalone command is a native execution gate, not only a compiler check.
Run it on `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and
`windows-x64`. Each candidate must prove its embedded identity, read-only
diagnostic, demo render, and prompt-tokenizer vectors. The macOS and Linux
candidates must also prove explicit absent-target publication, cold embedded
render, and install relocation against the unchanged account data target.
Linux additionally proves supervised child replacement and parent-death
containment. macOS proves lock-aware serve fails closed. Windows proves that
embedded storage and HTTP authority fail closed until their native DACL and
reparse-safe adapters are complete.

See [ADR 005](adr/005-trusted-releases-and-upgrades.md) for the exact matrix,
bounds, and deferred decisions.

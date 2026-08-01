---
summary: Shared controls for manual npm release operations
read_when:
  - promoting an npm release
  - quarantining an npm release
---

# npm release operation controls

Apply these controls to each manual npm promotion or quarantine.

## Technical terms

This document uses these Technical Names:

| Term | Meaning |
| --- | --- |
| release package | One npm package in the five-package release matrix |
| launcher package | The JavaScript package named `@1667-ai/cli` |
| platform package | A package that contains one native executable |
| promotion | The operation that moves a selected release tag to a verified version |
| quarantine | The operation that removes a release version from npm tags |
| publication run | The successful `Release (npm)` workflow run for one version |
| operation lease | The exclusive GitHub workflow run for one manual npm operation |
| open marker | The deletable Git ref that identifies the current operation lease |

## Package order

`scripts/release-npm-operations.ts` reads the canonical release policy.
It gives the complete package order for each operation.

Promotion changes the platform packages before it changes the launcher package.
This order makes all platform packages available before a new launcher selects
them.

Quarantine changes the launcher package before it changes the platform
packages.
This order stops new launcher installations before it changes the platform
packages.

## Authentication

Use interactive npm authentication for each tag or deprecation change.
Run one procedure in one Bash session.
Enable strict shell behavior:

```sh
set -euo pipefail
```

Set the npm registry:

```sh
NPM_REGISTRY=https://registry.npmjs.org/
```

Run `npm login --registry="$NPM_REGISTRY"` before an operation.
Complete the WebAuthn or two-factor authentication request.
Do not put a password or a one-time password in an environment variable.
Do not put a password or a one-time password on a command line.

Remove ambient publication credentials:

```sh
unset NODE_AUTH_TOKEN NPM_TOKEN NPM_AUTH_TOKEN NPM_CONFIG_OTP NPM_OTP OTP
unset NPM_CONFIG__AUTH NPM_CONFIG__AUTHTOKEN NPM_CONFIG__PASSWORD
npm whoami --registry="$NPM_REGISTRY"
```

The commands read the npm login from the user configuration.
The tag helper refuses ambient npm `_auth`, `_authToken`, and `_password`
configuration variables.
The tag helper removes GitHub tokens from each npm child process.

Use only the tag helper for these operations.
Do not run `npm dist-tag` or `npm deprecate` directly.
Do not change a release package from another shell during an operation.
The helper uses the authenticated npm access list for each release package.
It permits `1667.ai` as the only principal with read-write access.
It permits other principals to have read-only access.
It does not use public maintainer metadata as authorization.
It verifies the pinned Node and npm tool digests before each access check.

npm 11 reads the current tag before an `npm dist-tag rm` command.
It then sends an unconditional delete request.
The npm registry does not give this command a compare-and-swap condition.
The operation lease and the sole-writer rule prevent a concurrent tag change.
The helper reads the package again immediately before each npm write.
It verifies the access lists for all six packages immediately before each write.
It verifies the immutable writer after it verifies the access lists.
It then starts the npm child without another operation.
It stops before `npm dist-tag rm` when the tag no longer names `VERSION`.

## Operation lease

Set `OPERATION` to `promotion` or `quarantine`.
Set `VERSION` and `SOURCE_COMMIT`.
Use the acquisition procedure in
[npm operation lease recovery](./npm-operation-lease-recovery.md#acquire-an-operation-lease).
Use both journal paths from that procedure for the tag command.
Do not edit GitHub release notes during a quarantine operation.
The operation lease is the sole writer for the quarantine notice.

The open marker is in `refs/tags/npm-operations-open/`.
Only a repository administrator can create or delete an open marker.
No actor can update an open marker.
The open marker keeps the live-state read small.
Completed immutable operation evidence does not increase this read.
The lease creates the open marker before it creates the immutable `active`
marker.
The lease validates the immutable `terminal` marker before it deletes the open
marker.
The holder keeps the shared lock until the open marker is absent.

The hosted publication token reads only the open-marker namespace.
It cannot read the administrator bypass list in a repository ruleset.
Run `npm run release:operation-controls` with an administrator token before the
first publication.
Run the command again after a repository control change.
The `assert-clear` lease command also requires an administrator token.

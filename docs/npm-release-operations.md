---
summary: npm promotion and quarantine procedures
read_when:
  - promoting an npm release from next to latest
  - quarantining an npm release
---

# npm release operations

This document gives the procedures for npm promotion and quarantine.
Run these procedures from a trusted maintainer computer.

## Shared controls

Read [npm release operation controls](./npm-release-operation-controls.md).
Apply those controls before you use either procedure.
Use the acquisition procedure in
[npm operation lease recovery](./npm-operation-lease-recovery.md#acquire-an-operation-lease).
That procedure creates `OPERATION_JOURNAL` and `PROCESS_JOURNAL`.

## Promotion

Promotion moves `latest`, `stable`, or `beta` to one version.
It does not remove `next`.

### Prepare trusted tooling and the release source

Start with a new checkout of the protected default branch.
Set the version without a leading `v`.
Fetch the protected branch, signer policy, release tag, and completion refs:

```sh
export GITHUB_REPOSITORY=1667-ai/1667
export GH_TOKEN="$(gh auth token)"
VERSION=0.1.0
git fetch --no-tags origin \
  '+refs/heads/main:refs/remotes/origin/main' \
  '+refs/heads/release-policy:refs/remotes/origin/release-policy' \
  "refs/tags/v$VERSION:refs/tags/v$VERSION"
git fetch origin '+refs/tags/released/*:refs/tags/released/*'
test "$(git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)"
test -z "$(git status --porcelain)"
SOURCE_COMMIT="$(git rev-parse "v$VERSION^{commit}")"
```

Create a detached checkout for release-source inspection:

```sh
RELEASE_SOURCE_PARENT="$(realpath "$(mktemp -d)")"
RELEASE_SOURCE="$RELEASE_SOURCE_PARENT/source"
git worktree add --detach "$RELEASE_SOURCE" "v$VERSION"
test "$(git -C "$RELEASE_SOURCE" rev-parse HEAD)" = "$SOURCE_COMMIT"
test "$(git rev-parse "refs/tags/released/v$VERSION^{commit}")" \
  = "$SOURCE_COMMIT"
```

Do not execute a script from `RELEASE_SOURCE`.
Use the protected `main` checkout for all operational tools.

Use Node `22.22.0` and npm `11.12.1`.
These versions are the versions in the publication workflow:

```sh
test "$(node --version)" = "v22.22.0"
test "$(npm --version)" = "11.12.1"
npm ci --ignore-scripts --registry="$NPM_REGISTRY"
```

### Get the durable publication inputs

Create a new temporary directory:

```sh
OPERATIONS_DIR="$(realpath "$(mktemp -d)")"
ASSETS_DIR="$OPERATIONS_DIR/release-assets"
mkdir -p "$ASSETS_DIR"
```

Check the immutable GitHub prerelease:

```sh
RELEASE_STATE="$(
  gh release view "v$VERSION" --repo 1667-ai/1667 \
    --json tagName,isDraft,isImmutable,isPrerelease \
    --jq '[.tagName,.isDraft,.isImmutable,.isPrerelease] | @tsv'
)"
EXPECTED_STATE="$(printf 'v%s\tfalse\ttrue\ttrue' "$VERSION")"
test "$RELEASE_STATE" = "$EXPECTED_STATE"
```

Download and verify its exact asset set:

```sh
gh release download "v$VERSION" --repo 1667-ai/1667 \
  --dir "$ASSETS_DIR"
node --import tsx scripts/release-npm-github.ts \
  verify-assets "$VERSION" "1667-ai/1667" "$ASSETS_DIR"
```

Create the verifier layout:

```sh
mkdir -p \
  "$OPERATIONS_DIR/publication/tarballs" \
  "$OPERATIONS_DIR/publication/observations"
cp "$ASSETS_DIR"/*.tgz \
  "$OPERATIONS_DIR/publication/tarballs/"
cp \
  "$ASSETS_DIR/darwin-arm64.json" \
  "$ASSETS_DIR/darwin-x64.json" \
  "$ASSETS_DIR/linux-arm64.json" \
  "$ASSETS_DIR/linux-x64.json" \
  "$OPERATIONS_DIR/publication/observations/"
cp "$ASSETS_DIR/artifact-manifest.json" \
  "$OPERATIONS_DIR/publication/"
```

Check that the retained manifest names the requested version and commit:

```sh
node --input-type=module - "$OPERATIONS_DIR/publication/artifact-manifest.json" \
  "$VERSION" "$SOURCE_COMMIT" <<'NODE'
import { readFileSync } from "node:fs";
const [file, version, commit] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(file, "utf8"));
if (manifest.productVersion !== version || manifest.sourceCommit !== commit) {
  throw new Error("Retained release identity does not match the request");
}
process.stdout.write(`${manifest.buildTimestamp}\n`);
NODE
```

Copy the reported build timestamp.
Set `BUILD_TIMESTAMP` to that exact value.

### Verify all release packages

Rebuild the source evidence and release plan:

```sh
BUILD_TIMESTAMP=2026-07-28T12:00:00.000Z
node --import tsx scripts/release-evidence.ts \
  --repository "$RELEASE_SOURCE" \
  --tag "v$VERSION" --build-timestamp "$BUILD_TIMESTAMP" \
  > "$OPERATIONS_DIR/source-evidence.json"
node --import tsx scripts/release-npm-plan.ts \
  "$OPERATIONS_DIR/source-evidence.json" \
  "$OPERATIONS_DIR/publication/tarballs" \
  "$OPERATIONS_DIR/publication/observations" \
  "$OPERATIONS_DIR/plan.json"
```

Run the same registry verification that the publication workflow uses:

```sh
GITHUB_REF=refs/heads/main GITHUB_SHA="$SOURCE_COMMIT" \
npm run release:publish -- verify \
  "$OPERATIONS_DIR/plan.json" \
  "$OPERATIONS_DIR/publication/artifact-manifest.json" \
  "$OPERATIONS_DIR/publication/tarballs"
```

This command verifies all five exact versions.
It verifies each tarball digest and package identity.
It verifies npm provenance for the workflow, source ref, and source commit.
It verifies that no release package is deprecated.
It verifies that `next` names `VERSION` for all five release packages.

Do not continue when this command fails.

### Acquire the promotion lease

Set the operation:

```sh
OPERATION=promotion
```

Use the operation lease procedure.
The holder waits for any publication run to finish.
Do not continue until the local claim succeeds.

### Move the npm tags

Set the destination tag to `latest`, `stable`, or `beta`:

```sh
PROMOTION_TAG=stable
STABLE_ACKNOWLEDGMENT=()
```

Use a separate confirmation before a `stable` promotion:

```sh
if test "$PROMOTION_TAG" = stable; then
  printf 'Move stable to %s? Type stable: ' "$VERSION"
  read -r confirmation
  test "$confirmation" = stable
  STABLE_ACKNOWLEDGMENT=(--acknowledge-stable)
fi
```

Run the promotion command:

```sh
npm run release:tags -- promote "$VERSION" "$PROMOTION_TAG" \
  "$OPERATION_JOURNAL" "$PROCESS_JOURNAL" \
  "$LEASE_RUN_ID" "$LEASE_RUN_ATTEMPT" "$SOURCE_COMMIT" \
  "${STABLE_ACKNOWLEDGMENT[@]}"
gh run watch "$LEASE_RUN_ID" --repo "$GITHUB_REPOSITORY" --exit-status
```

The command reads the package order from the canonical release policy.
It verifies all five package states before its first write.
It verifies authenticated read-write access on all five package names.
It permits only `1667.ai` to have read-write access.
It moves the four platform destination tags before it moves the launcher tag.
It verifies each write before it starts the next write.
It keeps `next` on `VERSION`.
It skips a destination tag that already names `VERSION`.
It creates a process-local writer secret after it starts both journals.
It does not put the writer secret in an environment variable.
It verifies the writer before each npm process starts.
It records the exact npm child PID, nonce, tool digests, and arguments.
It permits the npm child only after it syncs that process record.
It keeps one PID from permission through the final npm request.
It appends and syncs one JSON record before and after each write.
The last record reports completion or failure.
The command acknowledges the journal outcome before it terminates the lease.
The command adds an immutable terminal marker to the operation lease.

Stop if the command fails.
Keep the evidence file with the release operation record.

## Quarantine

Quarantine removes every npm tag that names the quarantined version.
It does not delete a package version.

### Prepare trusted tooling and claim the lease

Start with a new checkout of the protected default branch.
Set the version and source commit:

```sh
export GH_HOST=github.com
export GH_PROMPT_DISABLED=1
export GITHUB_REPOSITORY=1667-ai/1667
export GH_TOKEN="$(gh auth token)"
VERSION=0.1.0
SUPERSEDING_VERSION=0.1.1
INCIDENT_REFERENCE=https://github.com/1667-ai/1667/issues/123
OPERATIONS_DIR="$(realpath "$(mktemp -d)")"
```

Fetch the protected branch, signer policy, and release tag:

```sh
git fetch --no-tags origin \
  '+refs/heads/main:refs/remotes/origin/main' \
  '+refs/heads/release-policy:refs/remotes/origin/release-policy' \
  "refs/tags/v$VERSION:refs/tags/v$VERSION"
test "$(git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)"
test -z "$(git status --porcelain)"
SOURCE_COMMIT="$(git rev-parse "v$VERSION^{commit}")"
RELEASE_SOURCE_PARENT="$(realpath "$(mktemp -d)")"
RELEASE_SOURCE="$RELEASE_SOURCE_PARENT/source"
git worktree add --detach "$RELEASE_SOURCE" "v$VERSION"
test "$(git -C "$RELEASE_SOURCE" rev-parse HEAD)" = "$SOURCE_COMMIT"
```

Do not execute a script from `RELEASE_SOURCE`.
Use the protected `main` checkout for all operational tools.

Install the reviewed toolchain dependencies:

```sh
test "$(node --version)" = "v22.22.0"
test "$(npm --version)" = "11.12.1"
npm ci --ignore-scripts --registry="$NPM_REGISTRY"
```

Verify the release source with the protected signer policy:

```sh
node --import tsx scripts/release-tag-authorization.ts \
  --repository "$RELEASE_SOURCE" \
  --tag "v$VERSION" \
  > "$OPERATIONS_DIR/quarantine-source-authorization.json"
```

Set the operation:

```sh
OPERATION=quarantine
QUARANTINE_REF="refs/tags/released/v${VERSION}_quarantined"
```

### Stop active npm operations

Do not dispatch another manual operation until the quarantine claim succeeds.
Run the stop command:

```sh
npm run release:operation -- stop-active
```

The command scans all pages of publication runs first.
It cancels all nonterminal publication runs.
It uses bounded polling until all publication runs are terminal.
It then scans and cancels all nonterminal manual operation runs.
It uses bounded polling until all manual operation runs are terminal.

The command then reads the exact open operation.
It revokes an active writer only after the holder is terminal.
It then verifies that the exact holder stays terminal.
It waits ten minutes before it records abandonment.
It cleans only a validated open marker.
It repeats the state inspection after a recovery race.
It verifies the repository controls and the clear state at completion.

The npm child has an independent five-minute time limit.
The ten-minute interval proves that a permitted npm child is not live.
Do not continue when the command fails.

### Acquire the quarantine lease

Use the operation lease procedure.
Do not continue until the local claim succeeds.

### Bind the quarantine ref to the lease

Create or verify the ref through the protected operation client:

```sh
node --import tsx scripts/release-npm-operation-lease-cli.ts \
  quarantine-marker \
  "$LEASE_RUN_ID" "$LEASE_RUN_ATTEMPT" \
  "$OPERATION" "$VERSION" "$SOURCE_COMMIT"
```

The command requires the exact quarantine claim.
It creates the immutable ref at `SOURCE_COMMIT`.
It verifies an existing ref at `SOURCE_COMMIT`.
It stops when an existing ref targets a different commit.
The ref blocks a publication retry for this version.

The shared lock stops publication and promotion during ref creation.
The quarantine ref blocks new runs after ref creation.
The terminal-state check stops a run that passed an earlier check from racing
the npm tag changes.

### Remove npm tags and deprecate the version

The writer authorization verifies the quarantine ref again.

Run the quarantine command:

```sh
npm run release:tags -- quarantine "$VERSION" \
  "$INCIDENT_REFERENCE" "$SUPERSEDING_VERSION" "$OPERATION_JOURNAL" \
  "$PROCESS_JOURNAL" "$LEASE_RUN_ID" "$LEASE_RUN_ATTEMPT" "$SOURCE_COMMIT"
```

The command reads the package order from the canonical release policy.
It requires an immutable completion ref for `SUPERSEDING_VERSION`.
It stops when a quarantine ref exists for `SUPERSEDING_VERSION`.
It verifies that all five packages for `SUPERSEDING_VERSION` exist.
It verifies that none of those packages is deprecated.
It verifies all five package states before its first write.
It verifies authenticated read-write access on all five package names.
It permits only `1667.ai` to have read-write access.
It removes every launcher tag that names `VERSION`.
It then removes every platform tag that names `VERSION`.
It preserves tags that name another version.
It verifies each write before it starts the next write.
It deprecates the launcher before it deprecates the platform packages.
The deprecation message names the incident and `SUPERSEDING_VERSION`.
It waits ten minutes when an exact version is absent in the first observation.
It accepts absence only when the second observation is also absent.
The command does not send an npm write for an absent version.
It creates a process-local writer secret after it starts both journals.
It does not put the writer secret in an environment variable.
It verifies the writer before each npm process starts.
It records the exact npm child PID, nonce, tool digests, and arguments.
It permits the npm child only after it syncs that process record.
It keeps one PID from permission through the final npm request.
It appends and syncs one JSON record before and after each write.
The last record reports completion or failure.
The command acknowledges the journal outcome.
It keeps the operation lease active until the public notice is complete.

Stop when the command fails.
Keep the launcher tags away from the quarantined version during recovery.
Do not move a tag to another version until you verify that version.
Keep the evidence file with the incident record.

Set the public notice evidence path:

```sh
QUARANTINE_NOTE_RECORD="$OPERATION_STATE_DIRECTORY/quarantine-note.jsonl"
```

Add and verify the notice on the immutable GitHub prerelease:

```sh
npm run release:quarantine-note -- "$VERSION" \
  "$OPERATION_JOURNAL" "$QUARANTINE_NOTE_RECORD" \
  "$LEASE_RUN_ID" "$LEASE_RUN_ATTEMPT" "$SOURCE_COMMIT"
gh run watch "$LEASE_RUN_ID" --repo "$GITHUB_REPOSITORY" --exit-status
```

The command reads the incident reference and superseding version from the
completed operation journal.
It verifies the successful writer acknowledgment before it changes the notes.
It verifies the completion ref and quarantine ref for the superseding version.
It verifies all five superseding package versions again.
It stops when a superseding package is absent or deprecated.
It changes only the release notes.
It verifies that the release assets and immutable identity do not change.
An interrupted publication can stop before it creates a GitHub prerelease.
In this case, the command verifies that the prerelease is absent two times.
It also verifies the immutable quarantine ref.
It records that the prerelease is absent.
The npm deprecation message is the public notice for each published package.
It writes and syncs create-only started and complete evidence records.
It then adds the immutable complete marker.
Retry this command when it stops before the complete marker.

Use [npm operation lease recovery](./npm-operation-lease-recovery.md) when an
operation holder has no terminal marker.

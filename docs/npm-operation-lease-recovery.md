---
summary: Recovery procedure for an npm operation lease
read_when:
  - acquiring an npm operation lease
  - recovering an npm operation lease
---

# npm operation lease recovery

This document gives the lease acquisition and recovery commands.
Run these commands from a trusted maintainer computer.

The npm operation orchestrator is a Technical Name.
It controls the lease state transitions.

## Acquire an operation lease

Use the protected `main` checkout.
Install the reviewed dependencies.
Set `OPERATION`, `VERSION`, and `SOURCE_COMMIT`.
Set the GitHub authority:

```sh
export GITHUB_REPOSITORY=1667-ai/1667
export GH_TOKEN="$(gh auth token)"
```

Run the acquisition command:

```sh
eval "$(
  node --import tsx scripts/release-npm-operation-orchestration-cli.ts \
    acquire "$OPERATION" "$VERSION" "$SOURCE_COMMIT"
)"
```

The command verifies the protected `main` checkout.
It verifies the repository controls before dispatch.
It creates the durable state root with mode `0700`.
It dispatches one holder with a unique request ID.
It uses bounded polling to find the exact holder.
It scans all workflow run pages.
It waits for the exact `hold` job.
It accepts only an `in_progress` job with no conclusion.
It rejects a rerun attempt.
It creates the claim during the holder watchdog interval.
It verifies the workflow source again after the claim.
It creates the operation state directory with mode `0700`.

The command sets these shell variables:

- `LEASE_RUN_ID`
- `LEASE_RUN_ATTEMPT`
- `OPERATION_STATE_DIRECTORY`
- `OPERATION_JOURNAL`
- `PROCESS_JOURNAL`
- `RECONCILIATION_RECORD`

The command exports `NPM_OPERATION_CLAIM_SECRET`.
The authority stays in the current shell.
Do not write the authority to a file.
Retain the operation state directory with the release record.

## Recover an operation

Use the protected `main` checkout.
Use Node `22.22.0` and npm `11.12.1`.
Install the reviewed dependencies:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
```

Set the lease variables from the durable operation record.
Set `OPERATION_STATE_DIRECTORY` to the retained state directory.
Export `NPM_OPERATION_CLAIM_SECRET` only when this shell still has the exact
claim authority.
Set the GitHub authority.

Run the recovery command:

```sh
npm run release:operation -- recover \
  "$LEASE_RUN_ID" "$LEASE_RUN_ATTEMPT" "$OPERATION" \
  "$VERSION" "$SOURCE_COMMIT" "$OPERATION_STATE_DIRECTORY"
```

The command verifies the protected `main` checkout.
It verifies the repository controls.
It verifies the exact holder before cancellation.
It cancels the holder before it revokes a writer.
It uses bounded polling until the holder is terminal.
It cleans only the exact validated open marker.

The command accepts these journal states:

- `absent`
- `process-only`
- `present`

It rejects an operation journal without a process journal.
It rejects malformed files and symbolic links.

For `absent` and `process-only`, the command proves that no writer exists.
It proves the journal state again after ten minutes.
It proves process quiescence two times for `process-only`.
It then records abandonment.

For `present`, the command proves process quiescence.
It repeats the proof after ten minutes.
It reconciles the journal with the public npm registry.
It writes a create-only reconciliation record with mode `0600`.
It rejects a changed reconciliation record after a recovery restart.

The reconciliation verdict is `complete`, `retry-required`, or
`safe-to-abandon`.
The command completes a successful operation only with the exact claim
authority and a successful writer acknowledgment.
The command completes a quarantine only after it records the public notice.
The command records abandonment for all other results.

The immutable revocation time controls the minimum settlement interval.
Thus, a restart can repeat the command safely.
Do not create a writer authority during recovery.
Do not replace a lost claim authority.
Start a new idempotent operation after abandonment.

## Compromised release artifacts

Quarantine the complete five-package version matrix.
Do not replace one release asset.
Do not reuse the version or its signed tag.

Use the current npm unpublish policy to check eligibility.
Use unpublish only for the complete compromised version matrix.
Do not unpublish one platform package.

An immutable GitHub release does not permit asset replacement.
Delete a complete release only as part of an approved incident response.
Publish the incident reference and the superseding version.

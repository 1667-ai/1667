import assert from "node:assert/strict";
import test from "node:test";
import {
  requireNpmOperationReleaseAuthorization,
  type NpmOperationAuthorizationRef
} from "../scripts/release-npm-operation-authorization.js";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";

const VERSION = "9.9.9";
const SOURCE_COMMIT = "a".repeat(40);
const DIGEST = "b".repeat(64);

function commitRef(ref: string): NpmOperationAuthorizationRef {
  return { ref, object: { type: "commit", sha: SOURCE_COMMIT } };
}

function releaseRefs(): NpmOperationAuthorizationRef[] {
  const base = `refs/tags/released/v${VERSION}`;
  return [
    commitRef(base),
    commitRef(`${base}_attempt_launcher_${DIGEST}`),
    ...PUBLISHED_ARTIFACT_TARGETS.map((target) =>
      commitRef(`${base}_attempt_${target}_${DIGEST}`))
  ];
}

/**
 * The publication ledger writes one attempt ref per published package. This
 * module has to accept every one of them: an attempt ref it calls malformed
 * blocks promotion and quarantine for that whole version. A literal target
 * list here rejected the first release that published windows-x64, so the set
 * has to follow release policy.
 */
test("operation authorization accepts an attempt ref for every published target", () => {
  assert.doesNotThrow(() => requireNpmOperationReleaseAuthorization(
    { operation: "promotion", version: VERSION, sourceCommit: SOURCE_COMMIT },
    releaseRefs()
  ));
});

test("operation authorization still refuses a ref it cannot account for", () => {
  const base = `refs/tags/released/v${VERSION}`;
  for (const suffix of [
    `_attempt_not-a-target_${DIGEST}`,
    "_attempt_linux-x64_not-a-digest",
    "_attempt_linux-x64",
    "_unexpected"
  ]) {
    assert.throws(
      () => requireNpmOperationReleaseAuthorization(
        { operation: "promotion", version: VERSION, sourceCommit: SOURCE_COMMIT },
        [...releaseRefs(), commitRef(`${base}${suffix}`)]
      ),
      /is malformed/u,
      `${suffix} should be refused`
    );
  }
});

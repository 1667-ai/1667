import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_ARTIFACT_TARGETS } from "../shared/build-identity.js";
import {
  assertReleasePackageVersions,
  createReleaseIdentitySet,
  type ReleasePackageVersions
} from "../scripts/release-identity.js";

const evidence = {
  schemaVersion: 1,
  productVersion: "1.2.3-beta.1",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  sourceDirty: false,
  tagName: "v1.2.3-beta.1",
  tagObjectType: "annotated",
  tagSignature: "unsigned",
  tagTargetCommit: "0123456789abcdef0123456789abcdef01234567",
  buildTimestamp: "2026-07-23T10:20:30.000Z",
  packageVersions: {
    root: "1.2.3-beta.1",
    tui: "1.2.3-beta.1",
    rootLock: "1.2.3-beta.1",
    rootLockPackage: "1.2.3-beta.1"
  }
} as const;

for (const field of [
  "root",
  "tui",
  "rootLock",
  "rootLockPackage"
] satisfies readonly (keyof ReleasePackageVersions)[]) {
  test(`release package version gate rejects ${field} drift`, () => {
    assert.throws(
      () => assertReleasePackageVersions(evidence.productVersion, {
        ...evidence.packageVersions,
        [field]: "1.2.4"
      }),
      new RegExp(`Release ${field} version does not match`, "u")
    );
  });
}

test("unsigned annotated tag evidence produces one immutable release identity per target", () => {
  const release = createReleaseIdentitySet(evidence);
  assert.deepEqual(
    release.identities.map((identity) => identity.artifactTarget),
    BUILT_ARTIFACT_TARGETS
  );
  for (const identity of release.identities) {
    assert.equal(identity.buildKind, "release");
    assert.equal(identity.sourceDirty, false);
    assert.equal(identity.productVersion, evidence.productVersion);
    assert.equal(identity.sourceCommit, evidence.sourceCommit);
    assert.equal(identity.buildTimestamp, evidence.buildTimestamp);
    assert.ok(Object.isFrozen(identity));
  }
  assert.ok(Object.isFrozen(release.identities));
  assert.equal("evidence" in release, false);
  assert.deepEqual(release.source, evidence);
  assert.ok(Object.isFrozen(release.source.packageVersions));
});

test("an unsigned lightweight tag produces a release identity too", () => {
  // There is no user of this product yet. The signing-key requirement returns
  // before there is one. Preflight must accept an unsigned lightweight tag
  // deliberately.
  const release = createReleaseIdentitySet({
    ...evidence,
    tagObjectType: "lightweight",
    tagSignature: "unsigned"
  });
  assert.deepEqual(
    release.identities.map((identity) => identity.artifactTarget),
    BUILT_ARTIFACT_TARGETS
  );
  assert.equal(release.source.tagObjectType, "lightweight");
  assert.equal(release.source.tagSignature, "unsigned");
});

test("release identity rejects mutable, detached, or version-skewed inputs", () => {
  const invalid: unknown[] = [
    { ...evidence, sourceDirty: true },
    // "commit" is git's own raw object-type name, not this document's
    // descriptive value — the accepted values are "annotated"/"lightweight".
    { ...evidence, tagObjectType: "commit" },
    { ...evidence, tagSignature: "unverified" },
    { ...evidence, tagSignature: "verified" },
    { ...evidence, tagName: "1.2.3-beta.1" },
    {
      ...evidence,
      tagTargetCommit: "fedcba9876543210fedcba9876543210fedcba98"
    },
    {
      ...evidence,
      packageVersions: { ...evidence.packageVersions, tui: "1.2.4" }
    },
    { ...evidence, productVersion: "01.2.3", tagName: "v01.2.3" },
    { ...evidence, buildTimestamp: "2026-07-23T10:20:30Z" },
    { ...evidence, future: true }
  ];
  for (const value of invalid) assert.throws(() => createReleaseIdentitySet(value));
});

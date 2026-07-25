import assert from "node:assert/strict";
import test from "node:test";
import { PACKAGED_ARTIFACT_TARGETS } from "../shared/build-identity.js";
import { createReleaseIdentitySet } from "../scripts/release-identity.js";
import { createReleasePackageTemplates } from "../scripts/release-package-templates.js";
import { validateReleasePackageMatrix } from "../scripts/release-package-policy.js";

const identities = createReleaseIdentitySet({
  schemaVersion: 1,
  productVersion: "3.0.0",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  sourceDirty: false,
  tagName: "v3.0.0",
  tagObjectType: "annotated",
  tagSignature: "verified",
  tagTargetCommit: "0123456789abcdef0123456789abcdef01234567",
  buildTimestamp: "2026-07-23T10:20:30.000Z",
  packageVersions: {
    root: "3.0.0",
    tui: "3.0.0",
    rootLock: "3.0.0",
    rootLockPackage: "3.0.0"
  }
});

test("release package templates are script-free and satisfy the exact matrix policy", () => {
  const templates = createReleasePackageTemplates(identities);
  const all = [templates.launcher, ...templates.platforms];
  const matrix = validateReleasePackageMatrix(
    all.map((template) => template.packageManifest),
    identities
  );
  assert.deepEqual(
    matrix.platforms.map((manifest) => manifest.target),
    PACKAGED_ARTIFACT_TARGETS
  );
  for (const template of all) {
    assert.equal(Object.hasOwn(template.packageManifest, "scripts"), false);
    assert.equal(Object.hasOwn(template.packageManifest, "dependencies"), false);
    assert.equal(template.buildManifest.productVersion, "3.0.0");
    assert.equal(
      template.buildManifest.sourceCommit,
      "0123456789abcdef0123456789abcdef01234567"
    );
    assert.ok(Object.isFrozen(template.packageManifest));
    assert.ok(Object.isFrozen(template.buildManifest));
  }
});

test("platform templates bind every sidecar to its embedded release identity", () => {
  const templates = createReleasePackageTemplates(identities);
  for (const [index, template] of templates.platforms.entries()) {
    const identity = template.buildIdentity;
    assert.equal(template.kind, "platform");
    assert.equal(template.buildManifest.artifactTarget, identity.artifactTarget);
    assert.equal(template.buildManifest.productVersion, identity.productVersion);
    assert.equal(template.buildManifest.sourceCommit, identity.sourceCommit);
    assert.equal(template.buildManifest.buildTimestamp, identity.buildTimestamp);
    assert.equal(identity.artifactTarget, PACKAGED_ARTIFACT_TARGETS[index]);
  }
  assert.equal(templates.launcher.kind, "launcher");
  assert.equal(templates.launcher.buildIdentity, null);
  assert.equal(templates.launcher.buildManifest.artifactTarget, "launcher");
});

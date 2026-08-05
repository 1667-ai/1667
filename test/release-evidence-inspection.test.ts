import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleReleaseSourceEvidence,
  parseReleasePackageVersions,
  requireCanonicalTimestamp,
  type CommandOutcome,
  type ReleaseEvidenceObservations
} from "../scripts/release-evidence-inspection.js";

const VERSION = "9.8.7";
const TAG = `v${VERSION}`;
const TIMESTAMP = "2026-07-27T08:09:10.011Z";
const RELEASE_COMMIT = "1c9ac1d1f3a94ee1a0e0c4b2fa2d5f7b6c0e8d31";
const OTHER_COMMIT = "88b6a5e2c1d0f4a37e5b9c2d8f1a6b3c4d5e7f90";

function ok(stdout = "", stderr = ""): CommandOutcome {
  return Object.freeze({ exitCode: 0, stdout, stderr });
}

function failed(stderr: string): CommandOutcome {
  return Object.freeze({ exitCode: 1, stdout: "", stderr });
}

/**
 * One round of captured Git output that should be accepted, so each test names
 * only the observation it spoils. These are the refusals the split between
 * running Git and reading Git exists for: the fixture repositories in
 * `release-evidence.test.ts` prove the same ground truth, slowly.
 */
function observations(
  overrides: Partial<ReleaseEvidenceObservations> = {}
): ReleaseEvidenceObservations {
  const manifest = `${JSON.stringify({ version: VERSION })}\n`;
  return {
    tagName: TAG,
    buildTimestamp: TIMESTAMP,
    protectedRef: "refs/remotes/origin/main",
    headCommit: ok(`${RELEASE_COMMIT}\n`),
    workingTreeStatus: ok(""),
    tagObjectType: ok("tag\n"),
    tagObjectContents: ok("object release\n\nrelease tag\n"),
    tagTargetCommit: ok(`${RELEASE_COMMIT}\n`),
    protectedReachability: ok(""),
    rootManifest: ok(manifest),
    tuiManifest: ok(manifest),
    rootLock: ok(`${JSON.stringify({
      version: VERSION,
      packages: { "": { version: VERSION } }
    })}\n`),
    ...overrides
  };
}

test("assembled evidence round-trips the accepted observations", () => {
  const evidence = assembleReleaseSourceEvidence(observations());
  assert.equal(evidence.sourceCommit, RELEASE_COMMIT);
  assert.equal(evidence.tagTargetCommit, RELEASE_COMMIT);
  assert.equal(evidence.productVersion, VERSION);
  assert.equal(evidence.tagObjectType, "annotated");
  assert.equal(evidence.tagSignature, "unsigned");
  assert.equal(evidence.sourceDirty, false);
});

test("a lightweight tag is recorded as lightweight, still unsigned", () => {
  const evidence = assembleReleaseSourceEvidence(observations({ tagObjectType: ok("commit\n") }));
  assert.equal(evidence.tagObjectType, "lightweight");
  assert.equal(evidence.tagSignature, "unsigned");
});

test("assembled evidence refuses every structural defect from captured output alone", () => {
  const defects: readonly (readonly [RegExp, Partial<ReleaseEvidenceObservations>])[] = [
    [/Release source tree is dirty/, { workingTreeStatus: ok(" M README.md\n") }],
    [/Release source tree is dirty/, { workingTreeStatus: ok("?? secrets.env\n") }],
    [/is not a tag or commit object/, { tagObjectType: ok("blob\n") }],
    [/could not be resolved/, { tagObjectType: failed("fatal: Not a valid object name\n") }],
    [/contains a signature that this collector does not verify/, {
      tagObjectContents: ok("release tag\n-----BEGIN SSH SIGNATURE-----\n")
    }],
    [/object could not be read/, { tagObjectContents: failed("fatal: bad object\n") }],
    [/does not point at the release commit/, { tagTargetCommit: ok(`${OTHER_COMMIT}\n`) }],
    [/is not reachable from protected ref/, { protectedReachability: failed("") }],
    [/Release source commit is not a full object name/, { headCommit: ok("1c9ac1d\n") }],
    [/Release source commit could not be read/, { headCommit: failed("fatal: bad revision\n") }],
    [/does not match product version/, {
      rootManifest: ok(`${JSON.stringify({ version: "9.8.6" })}\n`),
      tuiManifest: ok(`${JSON.stringify({ version: "9.8.6" })}\n`),
      rootLock: ok(`${JSON.stringify({
        version: "9.8.6",
        packages: { "": { version: "9.8.6" } }
      })}\n`)
    }]
  ];
  for (const [expected, overrides] of defects) {
    assert.throws(() => assembleReleaseSourceEvidence(observations(overrides)), expected);
  }
});

test("a shape-valid but impossible build timestamp is refused, not thrown at", () => {
  // `2026-13-01…` satisfies the pattern and has no `Date`, so a check that goes
  // straight to `toISOString()` raises `RangeError: Invalid time value` instead
  // of the message that tells a maintainer what to fix.
  for (const impossible of ["2026-13-01T00:00:00.000Z", "2026-07-32T00:00:00.000Z"]) {
    assert.throws(
      () => requireCanonicalTimestamp(impossible),
      /must be a millisecond-precision UTC instant/
    );
    assert.throws(
      () => assembleReleaseSourceEvidence(observations({ buildTimestamp: impossible })),
      /must be a millisecond-precision UTC instant/
    );
  }
  assert.equal(requireCanonicalTimestamp(TIMESTAMP), TIMESTAMP);
  for (const wrongShape of ["2026-07-27T08:09:10Z", "2026-07-27T08:09:10.011+01:00", ""]) {
    assert.throws(() => requireCanonicalTimestamp(wrongShape));
  }
});

test("package version parsing reads all four versions and refuses skew", () => {
  const sources = (root: string, tui: string, lock: string, lockPackage: string) => ({
    rootManifest: JSON.stringify({ version: root }),
    tuiManifest: JSON.stringify({ version: tui }),
    rootLock: JSON.stringify({ version: lock, packages: { "": { version: lockPackage } } })
  });
  assert.deepEqual(
    { ...parseReleasePackageVersions(sources(VERSION, VERSION, VERSION, VERSION)) },
    { root: VERSION, tui: VERSION, rootLock: VERSION, rootLockPackage: VERSION }
  );
  for (const skewed of [
    sources("9.8.6", VERSION, VERSION, VERSION),
    sources(VERSION, "9.8.6", VERSION, VERSION),
    sources(VERSION, VERSION, "9.8.6", VERSION),
    sources(VERSION, VERSION, VERSION, "9.8.6")
  ]) {
    assert.throws(() => parseReleasePackageVersions(skewed), /versions disagree/);
  }
  assert.throws(
    () => parseReleasePackageVersions({
      rootManifest: JSON.stringify({ version: VERSION }),
      tuiManifest: JSON.stringify({ version: VERSION }),
      rootLock: JSON.stringify({ version: VERSION, packages: {} })
    }),
    /root package entry/
  );
});

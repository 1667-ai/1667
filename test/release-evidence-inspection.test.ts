import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleReleaseSourceEvidence,
  interpretTagSignature,
  parseAllowedSigners,
  parseReleasePackageVersions,
  requireCanonicalTimestamp,
  type CommandOutcome,
  type ReleaseEvidenceObservations
} from "../scripts/release-evidence-inspection.js";

const VERSION = "9.8.7";
const TAG = `v${VERSION}`;
const TIMESTAMP = "2026-07-27T08:09:10.011Z";
const FINGERPRINT = "SHA256:LtYSV9KYHYXvf8qGwf/HQDPsMehEsIQckR3N+wRB72k";
const SIGNER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPh5EVaactkk7C1l0i8RdnchTEUTXeKO1+NbHZu0chGR";
const RELEASE_COMMIT = "1c9ac1d1f3a94ee1a0e0c4b2fa2d5f7b6c0e8d31";
const OTHER_COMMIT = "88b6a5e2c1d0f4a37e5b9c2d8f1a6b3c4d5e7f90";

function ok(stdout = "", stderr = ""): CommandOutcome {
  return Object.freeze({ exitCode: 0, stdout, stderr });
}

function failed(stderr: string): CommandOutcome {
  return Object.freeze({ exitCode: 1, stdout: "", stderr });
}

function signedTagObject(commit = RELEASE_COMMIT): string {
  return `object ${commit}\ntype commit\ntag ${TAG}\n`
    + "tagger Release Bot <release@1667.test> 1785110400 +0000\n\n"
    + `${TAG}\n-----BEGIN SSH SIGNATURE-----\nAAAAB3NzaC1\n-----END SSH SIGNATURE-----\n`;
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
    signerPolicyRef: "refs/remotes/origin/release-policy",
    signerPolicyPath: "allowed-signers",
    protectedRef: "refs/remotes/origin/main",
    headCommit: ok(`${RELEASE_COMMIT}\n`),
    workingTreeStatus: ok(""),
    tagObjectType: ok("tag\n"),
    tagObject: ok(signedTagObject()),
    tagTargetCommit: ok(`${RELEASE_COMMIT}\n`),
    protectedReachability: ok(""),
    signerPolicy: ok(`release@1667.test ${SIGNER_KEY}\n`),
    tagVerification: ok(
      "",
      `Good "git" signature for release@1667.test with ED25519 key ${FINGERPRINT}\n`
    ),
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
  const document = assembleReleaseSourceEvidence(observations());
  assert.equal(document.evidence.sourceCommit, RELEASE_COMMIT);
  assert.equal(document.evidence.tagTargetCommit, RELEASE_COMMIT);
  assert.equal(document.evidence.productVersion, VERSION);
  assert.equal(document.evidence.tagSignature, "verified");
  assert.equal(document.evidence.sourceDirty, false);
  assert.equal(document.signature.principal, "release@1667.test");
  assert.equal(document.signature.keyFingerprint, FINGERPRINT);
});

test("assembled evidence refuses every structural defect from captured output alone", () => {
  const defects: readonly (readonly [RegExp, Partial<ReleaseEvidenceObservations>])[] = [
    [/Release source tree is dirty/, { workingTreeStatus: ok(" M README.md\n") }],
    [/Release source tree is dirty/, { workingTreeStatus: ok("?? secrets.env\n") }],
    [/is not an annotated tag object/, { tagObjectType: ok("commit\n") }],
    [/could not be resolved/, { tagObjectType: failed("fatal: Not a valid object name\n") }],
    [/carries no signature/, { tagObject: ok(`object ${RELEASE_COMMIT}\ntype commit\n\n${TAG}\n`) }],
    [/does not point at the release commit/, { tagTargetCommit: ok(`${OTHER_COMMIT}\n`) }],
    [/is not reachable from protected ref/, { protectedReachability: failed("") }],
    [/Release source commit is not a full object name/, { headCommit: ok("1c9ac1d\n") }],
    [/Release source commit could not be read/, { headCommit: failed("fatal: bad revision\n") }],
    [/could not be read/, { signerPolicy: failed("fatal: path does not exist\n") }],
    [/names no supported key type/, { signerPolicy: ok(`{ "name": "not a policy" }\n`) }],
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

test("allowed-signer parsing keeps principals and refuses unusable policies", () => {
  assert.deepEqual(
    parseAllowedSigners(`# comment\n\nrelease@1667.test,backup@1667.test ${SIGNER_KEY} note\n`, "policy")
      .map((signer) => [...signer.principals]),
    [["release@1667.test", "backup@1667.test"]]
  );
  assert.equal(
    parseAllowedSigners(`release@1667.test namespaces="git" ${SIGNER_KEY}\n`, "policy")[0]?.keyType,
    "ssh-ed25519"
  );
  // Forms `ssh-keygen` accepts and this parse must not trip over, since it is a
  // diagnostic and never the thing that decides who may sign.
  assert.equal(
    parseAllowedSigners(`*@1667.test cert-authority ${SIGNER_KEY}\n`, "policy")[0]?.keyType,
    "ssh-ed25519"
  );
  assert.equal(
    parseAllowedSigners(
      "release@1667.test ssh-ed25519-cert-v01@openssh.com "
      + "AAAAC3NzaC1lZDI1NTE5AAAAIPh5EVaactkk7C1l0i8RdnchTEUTXeKO1+NbHZu0chGR\n",
      "policy"
    )[0]?.keyType,
    "ssh-ed25519-cert-v01@openssh.com"
  );
  for (const invalid of [
    "",
    "# only a comment\n",
    "release@1667.test\n",
    "release@1667.test unknown-key-type AAAAC3NzaC1lZDI1NTE5AAAAIPh5EVaactkk7C1l0i8Rd\n",
    "release@1667.test ssh-ed25519 not+base64!\n",
    "release@1667.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPh5\0\n"
  ]) {
    assert.throws(() => parseAllowedSigners(invalid, "policy"));
  }
});

test("signature interpretation accepts only the matched-principal status line", () => {
  const outcome = (exitCode: number, stderr: string): CommandOutcome =>
    Object.freeze({ exitCode, stdout: "", stderr });
  const good = `Good "git" signature for release@1667.test with ED25519 key ${FINGERPRINT}\n`;
  assert.equal(interpretTagSignature(outcome(0, good), TAG).principal, "release@1667.test");

  // Whose principals the policy admits is `ssh-keygen`'s question, already
  // answered by the exit code above. A certificate-authority policy reports a
  // principal that appears nowhere in the file it was matched against, so a
  // re-check here could only refuse a release Git had accepted.
  assert.equal(
    interpretTagSignature(
      outcome(0, `Good "git" signature for someone@1667.test with ED25519-CERT key ${FINGERPRINT}\n`),
      TAG
    ).keyType,
    "ED25519-CERT"
  );

  // Git prints "Good ... signature" even when no principal matched, so a parser
  // that looked for the word "Good" would accept an unauthorised key.
  assert.throws(
    () => interpretTagSignature(
      outcome(0, `Good "git" signature with ED25519 key ${FINGERPRINT}\nNo principal matched.\n`),
      TAG
    ),
    /unrecognised status/
  );
  assert.throws(() => interpretTagSignature(outcome(1, good), TAG), /allowed signer/);
  for (const unfamiliar of [
    `${good}[GNUPG:] GOODSIG\n`,
    `[GNUPG:] GOODSIG 0123456789ABCDEF Release Bot\n`,
    "",
    `Good "git" signature for release@1667.test with ED25519 key SHA256:short\n`,
    `good "git" signature for release@1667.test with ED25519 key ${FINGERPRINT}\n`
  ]) {
    assert.throws(
      () => interpretTagSignature(outcome(0, unfamiliar), TAG),
      /unrecognised status/
    );
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

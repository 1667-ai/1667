import assert from "node:assert/strict";
import test from "node:test";
import {
  HTTP_API_PROTOCOL_VERSION,
  AI_1667_BUILD_IDENTITY,
  createPackagedBuildIdentity,
  createSourceBuildIdentity,
  formatBuildVersion,
  isBuildIdentity,
  parseBuildIdentity,
  sameBuildIdentity,
  type PackagedBuildIdentityInput
} from "../shared/build-identity.js";

const packagedInput = {
  productVersion: "1.2.3-beta.1+build.7",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  sourceDirty: false,
  buildTimestamp: "2026-07-22T08:30:00.000Z",
  artifactTarget: "linux-x64"
} satisfies PackagedBuildIdentityInput;
const packaged = createPackagedBuildIdentity(packagedInput);

test("source identity is explicit and cannot masquerade as a packaged build", () => {
  // Pinned on purpose, so the advertised version and the wire shape can only
  // move together. v9 added authenticated listener identity and project-scoped
  // HTTP retry identity. v10 added global search and hit pagination. v11 adds
  // Markdown reimport and naming chapter one. v12 adds NovelAI import. v13 adds
  // the Author's Note route. v14 adds required Fact activation metadata. An
  // older peer must fail at preflight.
  assert.equal(
    HTTP_API_PROTOCOL_VERSION,
    14,
    "Fact activation metadata requires HTTP API v14"
  );
  const source = createSourceBuildIdentity("1.2.3");
  assert.deepEqual(source, {
    schemaVersion: 1,
    product: "1667",
    productVersion: "1.2.3",
    buildKind: "development",
    apiProtocolVersion: HTTP_API_PROTOCOL_VERSION,
    minClientProtocolVersion: HTTP_API_PROTOCOL_VERSION,
    maxClientProtocolVersion: HTTP_API_PROTOCOL_VERSION,
    artifactTarget: "source",
    sourceCommit: null,
    sourceDirty: null,
    buildTimestamp: null
  });
  assert.match(formatBuildVersion(source), /1667 1\.2\.3 \(source\)/);
  assert.equal(AI_1667_BUILD_IDENTITY.artifactTarget, "source");
});

test("packaged identity round-trips as one strict build contract", () => {
  const parsed = parseBuildIdentity(JSON.parse(JSON.stringify(packaged)));
  assert.ok(sameBuildIdentity(parsed, packaged));
  assert.match(formatBuildVersion(parsed), /development; 0123456789ab; linux-x64/);
});

test("build identity accepts SemVer prerelease identifiers with numeric prefixes", () => {
  for (const productVersion of ["1.0.0-1a", "1.0.0-01a"]) {
    const identity = createPackagedBuildIdentity({ ...packagedInput, productVersion });
    assert.equal(identity.productVersion, productVersion);
  }
});

test("build identity rejects ambiguous provenance and schema drift", () => {
  const invalid = [
    { ...packaged, productVersion: "01.2.3" },
    { ...packaged, productVersion: "1.2.3-01" },
    { ...packaged, sourceCommit: "ABCDEF" },
    { ...packaged, buildTimestamp: "2026-07-22T08:30:00Z" },
    { ...packaged, artifactTarget: "windows-arm64" },
    { ...packaged, apiProtocolVersion: packaged.maxClientProtocolVersion + 1 },
    { ...packaged, extra: true },
    { ...packaged, buildKind: "release", sourceDirty: true },
    { ...createSourceBuildIdentity("1.2.3"), sourceCommit: packaged.sourceCommit }
  ];
  for (const candidate of invalid) {
    assert.equal(isBuildIdentity(candidate), false);
    assert.throws(() => parseBuildIdentity(candidate));
  }
});

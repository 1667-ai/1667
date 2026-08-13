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
  // the Author's Note route. v14 adds required Fact activation metadata. v15
  // adds the Author Brief route and the Author's Note depth field. v16 adds the
  // prompt token-count route. v17 adds the per-story phrase-bias and
  // banned-strings routes and makes `scope` required on every resolved
  // sampling-bias entry. v18 makes `nativeBannedStrings` required on a
  // "resolved" resolveSamplingBias response (KoboldCpp's native bannedStrings
  // transport, issue #311). v19 adds a take's thought: `effectiveProseReasoning`
  // on the settings view, and `reasoning` and `discardReasoning` on a
  // Generation Profile. A v18 client decodes both as closed records that know
  // none of those names. v20 adds the two story image routes and eleven image
  // failure codes: a v20 client takes a 404 on the stage route against a v19
  // server, and a v19 client collapses every image code it does not know to
  // `internal`, so it cannot tell a writer that a Draft Lease expired. v21
  // adds Aside routes, Aside failure codes, and the Markdown export fidelity
  // contract. An older peer must fail at preflight.
  assert.equal(
    HTTP_API_PROTOCOL_VERSION,
    21,
    "Aside routes, failure codes, and export fidelity require HTTP API v21"
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

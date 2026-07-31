import assert from "node:assert/strict";
import test from "node:test";
import { promoteGitHubRelease } from "../scripts/release-github-promotion.js";

const REPOSITORY = "1667-ai/1667";
const TOKEN = "ghp_test_token";
const VERSION = "1.2.3";

interface Call {
  readonly method: string;
  readonly pathname: string;
  readonly body: string | null;
}

function releaseJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    tag_name: `v${VERSION}`,
    draft: false,
    prerelease: true,
    ...overrides
  };
}

/** Serves the release endpoints and records every request. */
function githubStub(routes: {
  readonly byTag?: unknown;
  readonly byTagStatus?: number;
  readonly patched?: unknown;
  readonly patchStatus?: number;
  readonly latest?: unknown;
  readonly latestStatus?: number;
}) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      pathname: url.pathname,
      body: typeof init?.body === "string" ? init.body : null
    });
    const respond = (status: number, payload: unknown) =>
      new Response(status === 404 ? "" : JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" }
      });
    if (method === "PATCH") {
      return respond(routes.patchStatus ?? 200, routes.patched ?? releaseJson({ prerelease: false }));
    }
    if (url.pathname.endsWith("/releases/latest")) {
      return respond(routes.latestStatus ?? 200, routes.latest ?? releaseJson({ prerelease: false }));
    }
    return respond(routes.byTagStatus ?? 200, routes.byTag ?? releaseJson());
  };
  return { calls, fetchImpl };
}

function promote(stub: ReturnType<typeof githubStub>) {
  return promoteGitHubRelease({
    repository: REPOSITORY,
    token: TOKEN,
    version: VERSION,
    fetch: stub.fetchImpl
  });
}

test("promotion clears the pre-release flag and names the current release", async () => {
  const stub = githubStub({});
  const evidence = await promote(stub);
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    tag: "v1.2.3",
    releaseId: 42,
    prerelease: false,
    latest: true
  });
  // GitHub takes make_latest as a string, so a boolean would be ignored.
  const patch = stub.calls.find((call) => call.method === "PATCH");
  assert.ok(patch !== undefined, "promotion issued no update");
  assert.equal(patch.pathname, "/repos/1667-ai/1667/releases/42");
  assert.deepEqual(JSON.parse(patch.body ?? "{}"), { make_latest: "true", prerelease: false });
  // The designation is repository state, so it is confirmed against the
  // repository rather than the update response.
  assert.ok(
    stub.calls.some((call) => call.method === "GET" && call.pathname.endsWith("/releases/latest")),
    "promotion did not confirm the current release"
  );
});

test("promotion is repeatable on a release that is already current", async () => {
  const already = releaseJson({ prerelease: false });
  const stub = githubStub({ byTag: already, patched: already, latest: already });
  const evidence = await promote(stub);
  assert.equal(evidence.prerelease, false);
  assert.equal(evidence.latest, true);
});

test("promotion fails closed on every unusable release state", async () => {
  const cases: readonly (readonly [string, Parameters<typeof githubStub>[0], RegExp])[] = [
    ["absent release", { byTagStatus: 404 }, /does not exist/u],
    ["draft release", { byTag: releaseJson({ draft: true }) }, /is a draft/u],
    [
      "tag mismatch",
      { byTag: releaseJson({ tag_name: "v9.9.9" }) },
      /names tag v9\.9\.9/u
    ],
    [
      "update ignored the flag",
      { patched: releaseJson({ prerelease: true }) },
      /still a pre-release/u
    ],
    ["update rejected", { patchStatus: 422 }, /update returned 422/u],
    ["no current release", { latestStatus: 404 }, /names no release as the current release/u],
    [
      "another release is current",
      { latest: releaseJson({ tag_name: "v2.0.0", prerelease: false }) },
      /names v2\.0\.0 as the current release/u
    ]
  ];
  for (const [label, routes, expected] of cases) {
    await assert.rejects(promote(githubStub(routes)), expected, label);
  }
});

test("promotion refuses an invalid repository or version", async () => {
  const stub = githubStub({});
  await assert.rejects(
    promoteGitHubRelease({
      repository: "not-a-repo",
      token: TOKEN,
      version: VERSION,
      fetch: stub.fetchImpl
    }),
    /repository is invalid/u
  );
  await assert.rejects(
    promoteGitHubRelease({
      repository: REPOSITORY,
      token: TOKEN,
      version: "not-semver",
      fetch: stub.fetchImpl
    }),
    /version is not SemVer/u
  );
  assert.deepEqual(stub.calls, [], "validation contacted GitHub");
});

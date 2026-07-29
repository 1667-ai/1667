import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateQuarantinedGitHubRelease
} from "../scripts/release-npm-quarantine-github.js";

const VERSION = "1.2.3";
const INCIDENT = "https://github.com/1667-ai/1667/issues/111";
const SUPERSEDING = "1.2.4";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BASE = "https://api.github.test/repos/1667-ai/1667";

test("quarantine appends and verifies a preservation-safe release notice", async () => {
  const api = new FakeReleaseApi(release());
  const evidence = await annotateQuarantinedGitHubRelease(options(api));

  assert.deepEqual(api.requests.map((request) => {
    return [request.method, request.url];
  }), [
    ["GET", `${BASE}/releases/tags/v${VERSION}`],
    ["GET", `${BASE}/releases/tags/v${VERSION}`],
    ["PATCH", `${BASE}/releases/17`],
    ["GET", `${BASE}/releases/tags/v${VERSION}`]
  ]);
  assert.deepEqual(api.patchKeys, ["body"]);
  assert.ok(api.current !== null);
  const notes = api.current.body;
  assert.ok(notes !== null);
  assert.match(notes, /This release is quarantined\./u);
  assert.match(notes, /Use version `v1\.2\.4`\./u);
  assert.match(notes, new RegExp(INCIDENT.replaceAll("/", "\\/"), "u"));
  assert.equal(evidence.releaseId, 17);
  assert.equal(evidence.notice, "release-notes");
  assert.equal(evidence.tag, `v${VERSION}`);
  assert.match(evidence.notesSha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.assetsSha256, /^[0-9a-f]{64}$/u);
});

test("an exact existing quarantine notice is idempotent", async () => {
  const api = new FakeReleaseApi(release());
  await annotateQuarantinedGitHubRelease(options(api));
  api.requests.length = 0;
  api.patchKeys.length = 0;

  await annotateQuarantinedGitHubRelease(options(api));
  assert.deepEqual(api.requests.map((request) => request.method), ["GET", "GET"]);
  assert.deepEqual(api.patchKeys, []);
});

test("quarantine refuses a different existing notice", async () => {
  const api = new FakeReleaseApi(release({
    body: "notes\n\n<!-- 1667-quarantine:v1:1.2.3 -->\nwrong"
  }));
  await assert.rejects(
    annotateQuarantinedGitHubRelease(options(api)),
    /different quarantine notice/u
  );
  assert.deepEqual(api.patchKeys, []);
});

test("quarantine refuses a mutable or wrong release", async () => {
  for (const override of [
    { immutable: false },
    { draft: true },
    { prerelease: false },
    { tag_name: "v1.2.4" }
  ]) {
    await assert.rejects(
      annotateQuarantinedGitHubRelease(options(
        new FakeReleaseApi(release(override))
      )),
      /not the immutable prerelease/u
    );
  }
});

test("quarantine stops when the release changes before the patch", async () => {
  const api = new FakeReleaseApi(release());
  api.afterNextGet = (value) => ({ ...value, body: "concurrent notes" });
  await assert.rejects(
    annotateQuarantinedGitHubRelease(options(api)),
    /changed before the notes update/u
  );
  assert.deepEqual(api.patchKeys, []);
});

test("quarantine detects title or asset mutation after the patch", async () => {
  for (const mutate of [
    (value: ReleaseFixture) => ({ ...value, name: "changed" }),
    (value: ReleaseFixture) => ({
      ...value,
      assets: [{ ...value.assets[0]!, size: value.assets[0]!.size + 1 }]
    })
  ]) {
    const api = new FakeReleaseApi(release());
    api.afterPatch = mutate;
    await assert.rejects(
      annotateQuarantinedGitHubRelease(options(api)),
      /changed immutable release identity/u
    );
  }
});

test("quarantine updates only notes after a fresh read", async () => {
  const api = new FakeReleaseApi(release());
  await annotateQuarantinedGitHubRelease(options(api));
  assert.deepEqual(api.requests.map((request) => request.method), [
    "GET", "GET", "PATCH", "GET"
  ]);
  assert.deepEqual(api.patchKeys, ["body"]);
});

test("an absent prerelease uses the immutable quarantine ref", async () => {
  const api = new FakeReleaseApi(null);
  const evidence = await annotateQuarantinedGitHubRelease(options(api));

  assert.equal(evidence.notice, "release-absent");
  assert.equal(evidence.releaseId, null);
  assert.equal(evidence.notesSha256, null);
  assert.equal(evidence.assetsSha256, null);
  assert.equal(evidence.sourceCommit, COMMIT);
  assert.deepEqual(api.requests.map((request) => request.method), [
    "GET", "GET", "GET"
  ]);
});

test("an absent prerelease requires the exact quarantine ref", async () => {
  const api = new FakeReleaseApi(null);
  api.quarantineCommit = "f".repeat(40);
  await assert.rejects(
    annotateQuarantinedGitHubRelease(options(api)),
    /does not authorize an absent release/u
  );
});

test("an absent prerelease cannot appear during verification", async () => {
  const api = new FakeReleaseApi(null);
  api.releaseAfterFirstAbsence = release();
  await assert.rejects(
    annotateQuarantinedGitHubRelease(options(api)),
    /appeared during absence verification/u
  );
});

function options(api: FakeReleaseApi) {
  return {
    apiUrl: "https://api.github.test/",
    fetch: api.fetch,
    quarantine: {
      incidentReference: INCIDENT,
      supersedingVersion: SUPERSEDING
    },
    repository: "1667-ai/1667",
    sourceCommit: COMMIT,
    token: "token",
    version: VERSION
  };
}

interface ReleaseFixture {
  readonly id: number;
  readonly tag_name: string;
  readonly target_commitish: string;
  readonly name: string | null;
  readonly body: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly immutable: boolean;
  readonly assets: readonly ReleaseAssetFixture[];
}

interface ReleaseAssetFixture {
  readonly id: number;
  readonly name: string;
  readonly label: string | null;
  readonly state: string;
  readonly content_type: string;
  readonly size: number;
  readonly digest: string | null;
}

function release(overrides: Partial<ReleaseFixture> = {}): ReleaseFixture {
  return {
    id: 17,
    tag_name: `v${VERSION}`,
    target_commitish: "main",
    name: `1667 v${VERSION}`,
    body: "Original release notes.",
    draft: false,
    prerelease: true,
    immutable: true,
    assets: [{
      id: 31,
      name: "checksums.txt",
      label: null,
      state: "uploaded",
      content_type: "text/plain",
      size: 123,
      digest: `sha256:${"a".repeat(64)}`
    }],
    ...overrides
  };
}

class FakeReleaseApi {
  current: ReleaseFixture | null;
  quarantineCommit = COMMIT;
  releaseAfterFirstAbsence: ReleaseFixture | undefined;
  afterNextGet: ((value: ReleaseFixture) => ReleaseFixture) | undefined;
  afterPatch: ((value: ReleaseFixture) => ReleaseFixture) | undefined;
  readonly requests: Array<{ method: string; url: string }> = [];
  readonly patchKeys: string[] = [];

  constructor(initial: ReleaseFixture | null) {
    this.current = initial;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    this.requests.push({
      method,
      url
    });
    if (method === "GET" && url === `${BASE}/releases/tags/v${VERSION}`) {
      const response = this.current === null
        ? json({ message: "Not Found" }, 404)
        : json(this.current, 200);
      if (this.current === null && this.releaseAfterFirstAbsence !== undefined) {
        this.current = this.releaseAfterFirstAbsence;
        this.releaseAfterFirstAbsence = undefined;
      }
      const hook = this.afterNextGet;
      this.afterNextGet = undefined;
      if (hook !== undefined && this.current !== null) {
        this.current = hook(this.current);
      }
      return response;
    }
    if (method === "GET"
      && url === `${BASE}/git/matching-refs/tags/released/v${VERSION}_quarantined`) {
      return json([{
        ref: `refs/tags/released/v${VERSION}_quarantined`,
        object: { type: "commit", sha: this.quarantineCommit }
      }], 200);
    }
    assert.equal(method, "PATCH");
    assert.equal(url, `${BASE}/releases/17`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    this.patchKeys.push(...Object.keys(body).sort());
    if (typeof body.body !== "string") throw new Error("patch body is not a string");
    assert.ok(this.current !== null);
    this.current = { ...this.current, body: body.body };
    if (this.afterPatch !== undefined) this.current = this.afterPatch(this.current);
    return json(this.current, 200);
  };
}

function json(value: unknown, status: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  return new Response(JSON.stringify(value), { headers, status });
}

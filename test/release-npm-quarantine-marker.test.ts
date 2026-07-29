import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubNpmOperationLease,
  type NpmOperationLeaseRequest
} from "../scripts/release-npm-operation-lease.js";
import { FakeGitHub } from "./release-npm-operation-lease-fixture.js";

const REPOSITORY = "1667-ai/1667";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLAIM = "a".repeat(64);
const WRITER = "b".repeat(64);
const REQUEST: NpmOperationLeaseRequest = Object.freeze({
  repository: REPOSITORY,
  runId: "123456789",
  runAttempt: "1",
  operation: "quarantine",
  version: "1.2.3",
  sourceCommit: COMMIT
});
const QUARANTINE_REF = `refs/tags/released/v${REQUEST.version}_quarantined`;

test("partial release claim creates its marker before writer authorization", async () => {
  const api = new FakeGitHub(REQUEST);
  const client = leaseClient(api);
  await client.claim(REQUEST, CLAIM);
  assert.equal(api.has("claimed"), true);
  assert.equal(api.hasAbsoluteRef(QUARANTINE_REF), false);
  await assert.rejects(
    client.acquireWriter(REQUEST, CLAIM, WRITER),
    /has no quarantine marker/u
  );
  assert.equal(api.has("writer"), false);

  await client.createQuarantineMarker(REQUEST, CLAIM);
  assert.deepEqual(api.absoluteRef(QUARANTINE_REF).object, {
    type: "commit",
    sha: COMMIT
  });
  await client.acquireWriter(REQUEST, CLAIM, WRITER);
  await client.verifyWriter(REQUEST, WRITER);
});

test("quarantine marker requires the exact quarantine claim", async () => {
  const api = new FakeGitHub(REQUEST);
  const client = leaseClient(api);
  await client.claim(REQUEST, CLAIM);
  await assert.rejects(
    client.createQuarantineMarker(REQUEST, "c".repeat(64)),
    /secret does not match/u
  );
  assert.equal(api.hasAbsoluteRef(QUARANTINE_REF), false);

  const promotion = Object.freeze({
    ...REQUEST,
    operation: "promotion" as const
  });
  const promotionApi = new FakeGitHub(promotion);
  promotionApi.addCompletionAuthorization(promotion);
  promotionApi.addClaim(promotion, CLAIM);
  await assert.rejects(
    leaseClient(promotionApi).createQuarantineMarker(promotion, CLAIM),
    /requires a quarantine claim/u
  );
});

test("concurrent quarantine marker retries converge on the exact ref", async () => {
  const api = new FakeGitHub(REQUEST);
  const client = leaseClient(api);
  await client.claim(REQUEST, CLAIM);
  await Promise.all([
    client.createQuarantineMarker(REQUEST, CLAIM),
    client.createQuarantineMarker(REQUEST, CLAIM)
  ]);
  assert.equal(api.refsNamed(QUARANTINE_REF).length, 1);
  assert.equal(api.absoluteRef(QUARANTINE_REF).object.sha, COMMIT);
});

test("quarantine claim rejects wrong and malformed existing release refs", async () => {
  const base = `refs/tags/released/v${REQUEST.version}`;
  for (const [ref, sha, message] of [
    [`${base}_attempt_launcher_${"d".repeat(64)}`, "f".repeat(40), /different/u],
    [`${base}_unexpected`, COMMIT, /malformed/u]
  ] as const) {
    const api = new FakeGitHub(REQUEST);
    api.addAbsoluteRef(ref, "commit", sha);
    await assert.rejects(leaseClient(api).claim(REQUEST, CLAIM), message);
    assert.equal(api.has("active"), false);
  }
});

test("quarantine claim rechecks release refs before it records the claim", async () => {
  const api = new FakeGitHub(REQUEST);
  api.afterActiveCreate(() => {
    api.addAbsoluteRef(
      `refs/tags/released/v${REQUEST.version}_unexpected`,
      "commit",
      COMMIT
    );
  });
  await assert.rejects(
    leaseClient(api).claim(REQUEST, CLAIM),
    /malformed/u
  );
  assert.equal(api.has("active"), true);
  assert.equal(api.has("claimed"), false);
});

test("promotion claim still requires a complete nonquarantined release", async () => {
  const request = Object.freeze({
    ...REQUEST,
    operation: "promotion" as const
  });
  const missing = new FakeGitHub(request);
  await assert.rejects(
    leaseClient(missing).claim(request, CLAIM),
    /is not complete/u
  );
  assert.equal(missing.has("active"), false);

  const completed = new FakeGitHub(request);
  completed.addCompletionAuthorization(request);
  await leaseClient(completed).claim(request, CLAIM);
  assert.equal(completed.has("claimed"), true);

  const quarantined = new FakeGitHub(request);
  quarantined.addCompletionAuthorization(request);
  quarantined.addAbsoluteRef(
    `refs/tags/released/v${request.version}_quarantined`,
    "commit",
    COMMIT
  );
  await assert.rejects(
    leaseClient(quarantined).claim(request, CLAIM),
    /is quarantined/u
  );
});

test("claim revocation race stops quarantine marker creation", async () => {
  const api = new FakeGitHub(REQUEST);
  const client = leaseClient(api);
  await client.claim(REQUEST, CLAIM);
  api.afterNextTagRead(() => api.addRevoking(REQUEST));
  await assert.rejects(
    client.createQuarantineMarker(REQUEST, CLAIM),
    /final proof became terminal/u
  );
  assert.equal(api.hasAbsoluteRef(QUARANTINE_REF), false);
});

test("quarantine marker verifies an existing race at the source commit", async () => {
  const api = new FakeGitHub(REQUEST);
  const client = leaseClient(api);
  await client.claim(REQUEST, CLAIM);
  api.beforeRefCreate(QUARANTINE_REF, () => {
    api.addAbsoluteRef(QUARANTINE_REF, "commit", "f".repeat(40));
  });
  await assert.rejects(
    client.createQuarantineMarker(REQUEST, CLAIM),
    /different source commit/u
  );
  assert.equal(api.absoluteRef(QUARANTINE_REF).object.sha, "f".repeat(40));
});

test("quarantine marker checks existing release refs before creation", async () => {
  const api = new FakeGitHub(REQUEST);
  const client = leaseClient(api);
  await client.claim(REQUEST, CLAIM);
  api.addAbsoluteRef(
    `refs/tags/released/v${REQUEST.version}_unexpected`,
    "commit",
    COMMIT
  );
  await assert.rejects(
    client.createQuarantineMarker(REQUEST, CLAIM),
    /malformed/u
  );
  assert.equal(api.hasAbsoluteRef(QUARANTINE_REF), false);
});

test("quarantine marker rechecks the exact claim after ref creation", async () => {
  const api = new FakeGitHub(REQUEST);
  const client = leaseClient(api);
  await client.claim(REQUEST, CLAIM);
  api.afterRefCreate(QUARANTINE_REF, () => api.addRevoking(REQUEST));
  await assert.rejects(
    client.createQuarantineMarker(REQUEST, CLAIM),
    /final proof became terminal/u
  );
  assert.equal(api.absoluteRef(QUARANTINE_REF).object.sha, COMMIT);
});

function leaseClient(api: FakeGitHub): GitHubNpmOperationLease {
  return new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    verifyControls: async () => {}
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubNpmOperationLease,
  type NpmOperationLeaseRequest
} from "../scripts/release-npm-operation-lease.js";
import {
  npmOperationLeaseRef
} from "../scripts/release-npm-operation-lease-state.js";
import { FakeGitHub } from "./release-npm-operation-lease-fixture.js";

const REPOSITORY = "1667-ai/1667";
const CLAIM = "a".repeat(64);
const WRITER = "b".repeat(64);
const REQUEST: NpmOperationLeaseRequest = Object.freeze({
  repository: REPOSITORY,
  runId: "123456789",
  runAttempt: "1",
  operation: "quarantine",
  version: "1.2.3",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567"
});

test("claim converges after GitHub stores the ref but drops the response", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  dropCreateResponse(api, "claimed");

  await client(api).claim(REQUEST, CLAIM);
  await client(api).verifyClaim(REQUEST, CLAIM);
});

test("writer converges after GitHub stores the ref but drops the response", async () => {
  const api = claimedApi();
  dropCreateResponse(api, "writer");

  await client(api).acquireWriter(REQUEST, CLAIM, WRITER);
  await client(api).verifyWriter(REQUEST, WRITER);
});

test("writer outcome converges after an ambiguous create response", async () => {
  const api = writerApi();
  dropCreateResponse(api, "writer-terminal");

  await client(api).acknowledgeWriter(REQUEST, WRITER, "success");
  assert.equal(await client(api).writerOutcome(REQUEST), "success");
});

test("terminal outcome converges after an ambiguous create response", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  dropCreateResponse(api, "terminal");

  await client(api).complete(REQUEST, CLAIM);
  assert.equal(api.terminalOutcome(), "complete");
});

test("quarantine marker converges after an ambiguous create response", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addClaim(REQUEST, CLAIM);
  dropRefCreateResponse(
    api,
    `refs/tags/released/v${REQUEST.version}_quarantined`
  );

  await client(api).createQuarantineMarker(REQUEST, CLAIM);
  assert.deepEqual(
    api.absoluteRef(`refs/tags/released/v${REQUEST.version}_quarantined`).object,
    { type: "commit", sha: REQUEST.sourceCommit }
  );
});

test("revoking marker converges after an ambiguous create response", async () => {
  const api = writerApi();
  dropCreateResponse(api, "revoking");

  await client(api).revoke(REQUEST);
  assert.equal(api.refsWith("revoking").length, 1);
  assert.equal(api.refsWith("revoked").length, 1);
});

test("revoked marker converges after an ambiguous create response", async () => {
  const api = writerApi();
  dropCreateResponse(api, "revoked");

  await client(api).revoke(REQUEST);
  assert.equal(api.refsWith("revoking").length, 1);
  assert.equal(api.refsWith("revoked").length, 1);
});

function claimedApi(): FakeGitHub {
  const api = new FakeGitHub(REQUEST);
  api.addClaim(REQUEST, CLAIM);
  api.addReleaseAuthorization(REQUEST);
  return api;
}

function writerApi(): FakeGitHub {
  const api = claimedApi();
  api.addWriter(REQUEST, WRITER);
  return api;
}

function dropCreateResponse(
  api: FakeGitHub,
  marker:
    | "claimed"
    | "writer"
    | "writer-terminal"
    | "revoking"
    | "revoked"
    | "terminal"
): void {
  dropRefCreateResponse(api, npmOperationLeaseRef(REQUEST, marker));
}

function dropRefCreateResponse(api: FakeGitHub, ref: string): void {
  api.afterRefCreate(ref, () => {
    throw new Error("simulated connection loss");
  });
}

function client(api: FakeGitHub): GitHubNpmOperationLease {
  return new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    pollIntervalMs: 1,
    maxPolls: 2,
    verifyControls: async () => {}
  });
}

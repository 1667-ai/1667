import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubNpmOperationLease,
  type NpmOperationLeaseRequest
} from "../scripts/release-npm-operation-lease.js";
import {
  npmOperationOpenRef,
  parseNpmOperationTerminalMessage
} from "../scripts/release-npm-operation-lease-state.js";
import { FakeGitHub } from "./release-npm-operation-lease-fixture.js";

const REPOSITORY = "1667-ai/1667";
const CLAIM = "a".repeat(64);
const WRITER = "b".repeat(64);
const REQUEST: NpmOperationLeaseRequest = Object.freeze({
  repository: REPOSITORY,
  runId: "123456789",
  runAttempt: "1",
  operation: "promotion",
  version: "1.2.3",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567"
});

test("successful recovery binds revocation and completes the lease", async () => {
  const api = recoveredApi();

  await client(api).complete(REQUEST, CLAIM);

  assert.deepEqual(
    parseNpmOperationTerminalMessage(api.tagFor("terminal").message),
    {
      outcome: "complete",
      revocationTagSha: api.ref("revoked").object.sha
    }
  );
  assert.equal(await client(api).startAndPoll(REQUEST), "complete");
});

test("successful recovery rejects malformed revocation evidence", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.addRevoking(REQUEST);
  api.addTag(REQUEST, "revoked", "{}");

  await assert.rejects(
    client(api).complete(REQUEST, CLAIM),
    /revocation/u
  );
  assert.equal(api.has("terminal"), false);
});

test("a recovered terminal must bind its immutable revocation", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.addTag(
    REQUEST,
    "terminal",
    '{"kind":"npm-operation-terminal","outcome":"complete"}'
  );
  api.removeAbsoluteRef(npmOperationOpenRef(REQUEST));

  await assert.rejects(
    client(api).startAndPoll(REQUEST),
    /revocationTagSha is invalid/u
  );
});

test("a terminal retry requires the exact source commit", async () => {
  const api = recoveredApi();
  await client(api).complete(REQUEST, CLAIM);
  await assert.rejects(
    client(api).complete({
      ...REQUEST,
      sourceCommit: "f".repeat(40)
    }, CLAIM),
    /targets a different source commit/u
  );
});

function recoveredApi(): FakeGitHub {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.addRevocation(REQUEST, "2026-07-29T00:00:00.000Z");
  return api;
}

function writerApi(): FakeGitHub {
  const api = new FakeGitHub(REQUEST);
  api.addClaim(REQUEST, CLAIM);
  api.addReleaseAuthorization(REQUEST);
  api.addWriter(REQUEST, WRITER);
  return api;
}

function client(api: FakeGitHub): GitHubNpmOperationLease {
  return new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    sleep: async () => {},
    pollIntervalMs: 1,
    maxPolls: 2,
    verifyControls: async () => {}
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubNpmOperationLease,
  type NpmOperationLeaseRequest
} from "../scripts/release-npm-operation-lease.js";
import {
  npmOperationLeaseRef,
  npmOperationOpenRef,
  NpmOperationRefNotYetVisibleError
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
const OPEN_REF = npmOperationOpenRef(REQUEST);

test("open-state inspection identifies the exact holder recovery path",
  async () => {
  assert.equal(await client(new FakeGitHub(REQUEST)).openState(), null);

  const preActive = new FakeGitHub(REQUEST);
  preActive.addOpen(REQUEST);
  assert.deepEqual(await client(preActive).openState(), {
    request: REQUEST,
    state: "pre-active"
  });

  const active = new FakeGitHub(REQUEST);
  active.addClaim(REQUEST, CLAIM);
  assert.deepEqual(await client(active).openState(), {
    request: REQUEST,
    state: "active"
  });
  active.changeWorkflow({ conclusion: "cancelled", status: "completed" });
  assert.deepEqual(await client(active).openState(), {
    request: REQUEST,
    state: "active"
  });

  const terminal = writerApi();
  terminal.addWriterTerminal(REQUEST, "success");
  terminal.addTerminal(REQUEST, "complete");
  terminal.addOpen(REQUEST);
  assert.deepEqual(await client(terminal).openState(), {
    request: REQUEST,
    state: "terminal"
  });
});

test("open-state inspection rejects a ref without its exact holder",
  async () => {
  const api = new FakeGitHub(REQUEST);
  api.addOpen(REQUEST);
  api.changeWorkflow({ status: "queued" });
  await assert.rejects(
    client(api).openState(),
    /holder workflow is not authorized/u
  );
});

test("claim opens the bounded projection before immutable evidence", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);

  await client(api).claim(REQUEST, CLAIM);

  const writes = api.events.filter((event) => event.startsWith("POST ref"));
  assert.deepEqual(writes, [
    "POST ref open",
    "POST ref active",
    "POST ref claimed"
  ]);
});

test("claim converges when the open-marker response is lost", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  api.afterRefCreate(OPEN_REF, () => {
    throw new Error("simulated connection loss");
  });

  await client(api).claim(REQUEST, CLAIM);
  await client(api).verifyClaim(REQUEST, CLAIM);
});

test("claim converges when the active-marker response is lost", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  api.afterRefCreate(npmOperationLeaseRef(REQUEST, "active"), () => {
    throw new Error("simulated connection loss");
  });

  await client(api).claim(REQUEST, CLAIM);
  await client(api).verifyClaim(REQUEST, CLAIM);
});

test("claim converges when the claimed ref has delayed visibility", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  const claimedRef = npmOperationLeaseRef(REQUEST, "claimed");
  api.delayRefVisibility(claimedRef, 1);

  await client(api).claim(REQUEST, CLAIM);
  await client(api).verifyClaim(REQUEST, CLAIM);
});

test("claim fails when the claimed ref has permanent absence", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  const claimedRef = npmOperationLeaseRef(REQUEST, "claimed");
  api.delayRefVisibility(claimedRef, 100);

  await assert.rejects(
    client(api).claim(REQUEST, CLAIM),
    (error: unknown) => {
      assert.ok(error instanceof NpmOperationRefNotYetVisibleError);
      assert.match(error.message, /npm operation lease has no claimed ref/u);
      return true;
    }
  );
});

test("claim fails immediately without retry on conflicting claimed ref", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  const OTHER_CLAIM = "f".repeat(64);
  const claimedRef = npmOperationLeaseRef(REQUEST, "claimed");
  let verificationStart = 0;

  api.beforeRefCreate(claimedRef, () => {
    verificationStart = api.urls.length;
    api.addClaim(REQUEST, OTHER_CLAIM);
  });

  await assert.rejects(
    client(api).claim(REQUEST, CLAIM),
    /npm operation lease claim secret does not match/u
  );
  assert.equal(
    api.urls.slice(verificationStart)
      .filter((url) => new URL(url).pathname.includes("/git/tags/")).length,
    1
  );
});

test("claim retry wait stops at the unclaimed deadline", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  const claimedRef = npmOperationLeaseRef(REQUEST, "claimed");
  api.delayRefVisibility(claimedRef, 100);
  let verifyCallCount = 0;
  let claimedCreated = false;
  const originalFetch = api.fetch.bind(api);
  const customFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const method = init?.method ?? "GET";
    const response = await originalFetch(input, init);
    if (claimedCreated
      && url.pathname.includes("/git/matching-refs/tags/npm-operations/")) {
      verifyCallCount += 1;
    }
    if (method === "POST"
      && url.pathname.endsWith("/git/refs")
      && JSON.parse(String(init?.body)).ref === claimedRef) {
      claimedCreated = true;
    }
    return response;
  };

  const lease = new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: customFetch,
    unclaimedTimeoutMs: 5_000,
    pollIntervalMs: 1,
    maxPolls: 3,
    verifyControls: async () => {}
  });

  await assert.rejects(
    lease.claim(REQUEST, CLAIM),
    /npm operation lease was not claimed before its deadline/u
  );
  assert.ok(verifyCallCount > 1);
  assert.ok(verifyCallCount < 21);
});

test("a repeated claim with the same secret is idempotent", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  const lease = client(api);

  await lease.claim(REQUEST, CLAIM);
  await lease.claim(REQUEST, CLAIM);
  assert.equal(api.refsWith("claimed").length, 1);
});

test("a foreign open marker blocks a claim", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  api.addOpen({ ...REQUEST, runId: "987654321" });

  await assert.rejects(
    client(api).claim(REQUEST, CLAIM),
    /Another npm operation is open/u
  );
  assert.equal(api.has("active"), false);
});

test("exact lease proof never reads completed immutable history", async () => {
  const api = new FakeGitHub(REQUEST);
  for (let index = 1; index <= 10_000; index += 1) {
    const request = { ...REQUEST, runId: String(index) };
    api.addCommit(request, "active");
    api.addOpaqueTag(request, "terminal");
  }
  api.addClaim(REQUEST, CLAIM);
  api.addReleaseAuthorization(REQUEST);

  await client(api).verifyClaim(REQUEST, CLAIM);
  assert.equal(api.urls.some((url) => {
    return url.endsWith("/git/matching-refs/tags/npm-operations/");
  }), false);
  assert.equal(api.urls.some((url) => {
    return url.includes(
      "/git/matching-refs/tags/npm-operations/run-123456789-attempt-1/"
    );
  }), true);
});

test("terminal evidence is valid before the open marker is deleted", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.beforeRefDelete(OPEN_REF, () => {
    assert.equal(api.terminalOutcome(), "complete");
  });

  await client(api).complete(REQUEST, CLAIM);
  assert.equal(api.hasAbsoluteRef(OPEN_REF), false);
});

test("a failed terminal proof keeps the open marker", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "failed");

  await assert.rejects(
    client(api).complete(REQUEST, CLAIM),
    /did not acknowledge success/u
  );
  assert.equal(api.hasAbsoluteRef(OPEN_REF), true);
  assert.equal(api.has("terminal"), false);
});

test("open-marker deletion converges after a dropped response", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.afterRefDelete(OPEN_REF, () => {
    throw new Error("simulated connection loss");
  });

  await client(api).complete(REQUEST, CLAIM);
  assert.equal(api.hasAbsoluteRef(OPEN_REF), false);
});

test("open-marker deletion fails closed when the ref remains", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.beforeRefDelete(OPEN_REF, () => {
    throw new Error("simulated connection loss");
  });

  await assert.rejects(
    client(api).complete(REQUEST, CLAIM),
    /request did not settle/u
  );
  assert.equal(api.hasAbsoluteRef(OPEN_REF), true);
});

test("the holder waits for open-marker cleanup after terminal proof", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.addTerminal(REQUEST, "complete");
  api.addOpen(REQUEST);
  let sleeps = 0;

  const terminal = await client(api, async () => {
    sleeps += 1;
    api.removeAbsoluteRef(OPEN_REF);
  }).startAndPoll(REQUEST);

  assert.equal(terminal, "complete");
  assert.equal(sleeps, 1);
});

test("cleanup removes a pre-active marker only after the holder ends", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addOpen(REQUEST);
  api.changeWorkflow({ conclusion: "cancelled", status: "completed" });

  await client(api).cleanupOpen(REQUEST);
  assert.equal(api.hasAbsoluteRef(OPEN_REF), false);
});

test("cleanup keeps a pre-active marker while its holder can write", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addOpen(REQUEST);

  await assert.rejects(
    client(api).cleanupOpen(REQUEST),
    /holder workflow is not terminal/u
  );
  assert.equal(api.hasAbsoluteRef(OPEN_REF), true);
});

test("cleanup removes a marker left after valid terminal evidence", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.addTerminal(REQUEST, "complete");
  api.addOpen(REQUEST);

  await client(api).cleanupOpen(REQUEST);
  assert.equal(api.hasAbsoluteRef(OPEN_REF), false);
});

test("cleanup keeps an open marker with malformed terminal evidence", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.addTag(REQUEST, "terminal", "{}");

  await assert.rejects(
    client(api).cleanupOpen(REQUEST),
    /is invalid/u
  );
  assert.equal(api.hasAbsoluteRef(OPEN_REF), true);
});

function writerApi(): FakeGitHub {
  const api = new FakeGitHub(REQUEST);
  api.addClaim(REQUEST, CLAIM);
  api.addReleaseAuthorization(REQUEST);
  api.addWriter(REQUEST, WRITER);
  return api;
}

function client(
  api: FakeGitHub,
  sleep: (milliseconds: number) => Promise<void> = async () => {}
): GitHubNpmOperationLease {
  return new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    sleep,
    pollIntervalMs: 1,
    maxPolls: 3,
    verifyControls: async () => {}
  });
}

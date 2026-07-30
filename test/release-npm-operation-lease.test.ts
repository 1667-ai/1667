import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubNpmOperationLease,
  type NpmOperationLeaseRequest
} from "../scripts/release-npm-operation-lease.js";
import {
  npmOperationClaimMessage,
  npmOperationRevocationMessage,
  npmOperationRevokingMessage,
  npmOperationSecretDigest,
  npmOperationTerminalMessage
} from "../scripts/release-npm-operation-lease-state.js";
import type { GitHubWorkflowRun } from
  "../scripts/release-github-workflow-client.js";
import { FakeGitHub } from "./release-npm-operation-lease-fixture.js";

const REPOSITORY = "1667-ai/1667";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLAIM_A = "a".repeat(64);
const CLAIM_B = "b".repeat(64);
const WRITER_A = "c".repeat(64);
const WRITER_B = "d".repeat(64);
const REQUEST: NpmOperationLeaseRequest = Object.freeze({
  repository: REPOSITORY,
  runId: "123456789",
  runAttempt: "1",
  operation: "quarantine",
  version: "1.2.3",
  sourceCommit: COMMIT
});

test("live holder authorization and fixed refs select one claimant", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  const client = leaseClient(api);
  const results = await Promise.allSettled([
    client.claim(REQUEST, CLAIM_A),
    client.claim(REQUEST, CLAIM_B)
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const winner = results[0]!.status === "fulfilled" ? CLAIM_A : CLAIM_B;
  const loser = winner === CLAIM_A ? CLAIM_B : CLAIM_A;
  assert.equal(api.ref("active").object.sha, COMMIT);
  assert.equal(
    api.tagFor("claimed").message,
    npmOperationClaimMessage(npmOperationSecretDigest(winner))
  );
  await client.verifyClaim(REQUEST, winner);
  await assert.rejects(client.verifyClaim(REQUEST, loser), /secret does not match/u);
});
test("claim refuses a holder canceled after active creation", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addReleaseAuthorization(REQUEST);
  api.cancelAfterActive();
  await assert.rejects(
    leaseClient(api).claim(REQUEST, CLAIM_A),
    /holder workflow is not authorized/u
  );
  assert.equal(api.has("active"), true);
  assert.equal(api.has("claimed"), false);
  assert.deepEqual(
    api.events.filter((event) => event.includes("workflow") || event.includes("active")),
    [
      "GET workflow",
      "GET workflow jobs",
      "GET workflow",
      "GET workflow jobs",
      "POST ref active",
      "GET workflow"
    ]
  );
});
test("claim rejects wrong holder status, source, path, and title", async () => {
  for (const change of [
    { status: "queued" },
    { head_sha: "f".repeat(40) },
    { head_branch: "release" },
    { path: ".github/workflows/other.yml" },
    { name: "Hold npm operation" },
    { display_title: "npm quarantine v9.9.9 (wrong)" },
    {
      display_title: `npm ${REQUEST.operation} v${REQUEST.version}`
        + " (request-test;"
        + ` source ${REQUEST.sourceCommit})`
    },
    {
      display_title: `npm ${REQUEST.operation} v${REQUEST.version}`
        + " (123e4567-e89b-42d3-a456-426614174000;"
        + ` source ${"f".repeat(40)})`
    }
  ] satisfies readonly Partial<GitHubWorkflowRun>[]) {
    const api = new FakeGitHub(REQUEST);
    api.addCompletionAuthorization(REQUEST);
    api.changeWorkflow(change);
    await assert.rejects(
      leaseClient(api).claim(REQUEST, CLAIM_A),
      /holder workflow is not authorized/u
    );
    assert.equal(api.has("active"), false);
  }
});
test("holder waits for the local active ref and resolves its own outcome", async () => {
  const api = new FakeGitHub(REQUEST);
  let slept = false;
  const client = leaseClient(api, async () => {
    assert.equal(slept, false);
    slept = true;
    api.addClaim(REQUEST, CLAIM_A);
    api.addWriter(REQUEST, WRITER_A);
    api.addWriterTerminal(REQUEST, "success");
    api.addTerminal(REQUEST, "complete");
  });

  assert.equal(await client.startAndPoll(REQUEST), "complete");
  assert.equal(slept, true);
  assert.equal(api.events.includes("POST ref active"), false);
});
test("holder rejects an active marker for a different source commit", async () => {
  const request = {
    ...REQUEST,
    sourceCommit: "f".repeat(40)
  };
  const api = new FakeGitHub(request);
  api.addOpen(request);
  api.addCommit(REQUEST, "active");
  api.addTag(
    REQUEST,
    "claimed",
    npmOperationClaimMessage(npmOperationSecretDigest(CLAIM_A))
  );
  await assert.rejects(
    leaseClient(api).startAndPoll(request),
    /targets a different source commit/u
  );
});
test("claim verifies repository controls before it creates an active marker", async () => {
  const api = new FakeGitHub(REQUEST);
  const client = new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    verifyControls: async () => {
      throw new Error("repository controls drifted");
    }
  });
  await assert.rejects(
    client.claim(REQUEST, CLAIM_A),
    /repository controls drifted/u
  );
  assert.equal(api.has("active"), false);
});
test("one fresh writer secret selects the only writing helper", async () => {
  const api = claimedApi();
  const results = await Promise.allSettled([
    leaseClient(api).acquireWriter(REQUEST, CLAIM_A, WRITER_A),
    leaseClient(api).acquireWriter(REQUEST, CLAIM_A, WRITER_B)
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const winner = results[0]!.status === "fulfilled" ? WRITER_A : WRITER_B;
  const loser = winner === WRITER_A ? WRITER_B : WRITER_A;
  await leaseClient(api).verifyWriter(REQUEST, winner);
  await assert.rejects(
    leaseClient(api).verifyWriter(REQUEST, loser),
    /writer secret does not match/u
  );
  await assert.rejects(
    leaseClient(api).acknowledgeWriter(REQUEST, loser, "failed"),
    /writer secret does not match/u
  );
  assert.equal(api.has("writer-terminal"), false);
});
test("success and failed acknowledgments race for one writer-terminal ref", async () => {
  const api = writerApi();
  const results = await Promise.allSettled([
    leaseClient(api).acknowledgeWriter(REQUEST, WRITER_A, "success"),
    leaseClient(api).acknowledgeWriter(REQUEST, WRITER_A, "failed")
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(api.refsWith("writer-terminal").length, 1);
  const outcome = api.writerOutcome();
  assert.ok(outcome === "success" || outcome === "failed");
});
test("complete and failed require the matching writer acknowledgment", async () => {
  for (const [writerOutcome, method, terminal] of [
    ["success", "complete", "complete"],
    ["failed", "fail", "failed"]
  ] as const) {
    const api = writerApi();
    api.addWriterTerminal(REQUEST, writerOutcome);
    await leaseClient(api)[method](REQUEST, CLAIM_A);
    assert.equal(api.terminalOutcome(), terminal);
  }
  const mismatch = writerApi();
  mismatch.addWriterTerminal(REQUEST, "failed");
  await assert.rejects(
    leaseClient(mismatch).complete(REQUEST, CLAIM_A),
    /did not acknowledge success/u
  );
  assert.equal(mismatch.has("terminal"), false);
});

test("finalization policy authorizes completion but permits recorded failure",
  async () => {
  const completion = writerApi();
  completion.addWriterTerminal(REQUEST, "success");
  completion.removeAbsoluteRef(
    `refs/tags/released/v${REQUEST.version}_quarantined`
  );
  await assert.rejects(
    leaseClient(completion).complete(REQUEST, CLAIM_A),
    /has no quarantine marker/u
  );
  assert.equal(completion.has("revoking"), false);

  const failure = writerApi();
  failure.addWriterTerminal(REQUEST, "failed");
  failure.removeAbsoluteRef(
    `refs/tags/released/v${REQUEST.version}_quarantined`
  );
  await leaseClient(failure).fail(REQUEST, CLAIM_A);
  assert.equal(failure.terminalOutcome(), "failed");
});

test("terminal creation binds a revocation that races with finalization",
  async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  const revokedAt = "2026-07-29T00:00:00.000Z";
  const client = new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    serverTime: async () => Date.parse(revokedAt),
    verifyControls: async () => {
      if (!api.has("revoked")) api.addRevocation(REQUEST, revokedAt);
    }
  });
  await client.complete(REQUEST, CLAIM_A);
  assert.equal(
    api.tagFor("terminal").message,
    npmOperationTerminalMessage(
      "complete",
      api.ref("revoked").object.sha
    )
  );
});

test("quarantine note authorization requires a successful writer", async () => {
  const success = writerApi();
  success.addWriterTerminal(REQUEST, "success");
  await leaseClient(success).verifySuccessfulWriter(REQUEST, CLAIM_A);

  const failed = writerApi();
  failed.addWriterTerminal(REQUEST, "failed");
  await assert.rejects(
    leaseClient(failed).verifySuccessfulWriter(REQUEST, CLAIM_A),
    /did not acknowledge success/u
  );
});

test("quarantine note authorization accepts a bound revocation", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  api.addRevocation(REQUEST, "2026-07-29T00:00:00.000Z");
  await leaseClient(api).verifySuccessfulWriter(REQUEST, CLAIM_A);
});

test("recovery reads the exact writer outcome without a secret", async () => {
  const missing = writerApi();
  assert.equal(await leaseClient(missing).writerOutcome(REQUEST), null);

  const failed = writerApi();
  failed.addWriterTerminal(REQUEST, "failed");
  assert.equal(await leaseClient(failed).writerOutcome(REQUEST), "failed");
});

test("pre-journal recovery proves immutable revocation and no writer", async () => {
  for (const claimed of [false, true]) {
    const api = new FakeGitHub(REQUEST);
    api.addOpen(REQUEST);
    api.addCommit(REQUEST, "active");
    if (claimed) {
      api.addTag(
        REQUEST,
        "claimed",
        npmOperationClaimMessage(npmOperationSecretDigest(CLAIM_A))
      );
    }
    api.addRevocation(REQUEST, "2026-07-29T00:00:00.000Z");
    await leaseClient(api).assertNoWriterAfterRevocation(REQUEST);
  }
});

test("pre-journal recovery requires a valid immutable revocation", async () => {
  const unrevoked = new FakeGitHub(REQUEST);
  unrevoked.addOpen(REQUEST);
  unrevoked.addCommit(REQUEST, "active");
  unrevoked.addRevoking(REQUEST);
  unrevoked.addTag(REQUEST, "revoked", "{}");
  await assert.rejects(
    leaseClient(unrevoked).assertNoWriterAfterRevocation(REQUEST),
    /revocation/u
  );
});

test("pre-journal recovery rejects a writer marker", async () => {
  const writer = writerApi();
  writer.addRevocation(REQUEST, "2026-07-29T00:00:00.000Z");
  await assert.rejects(
    leaseClient(writer).assertNoWriterAfterRevocation(REQUEST),
    /final proof became terminal/u
  );
});

test("pre-journal recovery validates an existing claim marker", async () => {
  const malformed = new FakeGitHub(REQUEST);
  malformed.addOpen(REQUEST);
  malformed.addCommit(REQUEST, "active");
  malformed.addTag(REQUEST, "claimed", '{"kind":"npm-operation-claim"}');
  malformed.addRevocation(REQUEST, "2026-07-29T00:00:00.000Z");
  await assert.rejects(
    leaseClient(malformed).assertNoWriterAfterRevocation(REQUEST),
    /secretSha256 is invalid/u
  );
});

test("recovery revokes writer capability and waits ten minutes before abandonment",
  async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "success");
  let now = Date.parse("2020-01-01T00:00:00.000Z");
  const client = leaseClient(api, async () => {}, () => now);
  await assert.rejects(client.abandon(REQUEST), /has no revoking ref/u);
  await client.revoke(REQUEST);
  await assert.rejects(
    client.verifyWriter(REQUEST, WRITER_A),
    /writer is revoked/u
  );
  await assert.rejects(
    client.abandon(REQUEST),
    /did not settle for ten minutes/u
  );
  assert.equal(api.has("terminal"), false);
  now += 599_999;
  await assert.rejects(
    client.abandon(REQUEST),
    /did not settle for ten minutes/u
  );
  now += 1;
  await client.abandon(REQUEST);
  assert.equal(api.terminalOutcome(), "abandoned");
});

test("fresh writer proof loses a race to immutable revocation", async () => {
  const api = writerApi();
  api.afterNextTagRead(() => api.addRevoking(REQUEST));
  await assert.rejects(
    leaseClient(api).verifyWriter(REQUEST, WRITER_A),
    /final proof became terminal/u
  );
});

test("revocation clock starts after immutable writer lockout", async () => {
  const api = writerApi();
  let reads = 0;
  const client = leaseClient(api, async () => {}, () => {
    reads += 1;
    assert.equal(api.has("revoking"), true);
    return Date.parse("2026-07-29T00:00:00.000Z");
  });
  await client.revoke(REQUEST);
  assert.equal(reads, 1);
});

test("concurrent revocation callers converge on one immutable proof", async () => {
  const api = writerApi();
  const now = () => Date.parse("2026-07-29T00:00:00.000Z");
  await Promise.all([
    leaseClient(api, async () => {}, now).revoke(REQUEST),
    leaseClient(api, async () => {}, now).revoke(REQUEST)
  ]);
  assert.equal(api.refsWith("revoking").length, 1);
  assert.equal(api.refsWith("revoked").length, 1);
});

test("holder rejects malformed or incorrectly bound revocation proof", async () => {
  const revokedAt = "2026-07-29T00:00:00.000Z";
  for (const kind of ["wrong-source", "noncanonical"] as const) {
    const api = writerApi();
    api.addRevoking(REQUEST);
    const revokingTagSha = api.ref("revoking").object.sha;
    const message = kind === "wrong-source"
      ? npmOperationRevocationMessage(
        revokedAt,
        revokingTagSha,
        "f".repeat(40)
      )
      : JSON.stringify({
        revokedAt,
        kind: "npm-operation-revocation",
        revokingTagSha,
        sourceCommit: COMMIT
      });
    api.addTag(REQUEST, "revoked", message);
    api.addTerminal(REQUEST, "abandoned");
    await assert.rejects(
      leaseClient(api).startAndPoll(REQUEST),
      /revocation/u
    );
  }

  const wrongTerminal = writerApi();
  wrongTerminal.addRevocation(REQUEST, revokedAt);
  wrongTerminal.addTag(
    REQUEST,
    "terminal",
    npmOperationTerminalMessage("abandoned", "f".repeat(40))
  );
  await assert.rejects(
    leaseClient(wrongTerminal).startAndPoll(REQUEST),
    /no valid revocation/u
  );
});

test("abandon rejects a revocation bound to an invalid revoking record", async () => {
  const api = writerApi();
  const revokedAt = "2026-07-29T00:00:00.000Z";
  api.addTag(
    REQUEST,
    "revoking",
    npmOperationRevokingMessage("f".repeat(40))
  );
  api.addTag(
    REQUEST,
    "revoked",
    npmOperationRevocationMessage(
      revokedAt,
      api.ref("revoking").object.sha,
      COMMIT
    )
  );

  await assert.rejects(
    leaseClient(
      api,
      async () => {},
      () => Date.parse(revokedAt) + 600_000
    ).abandon(REQUEST),
    /revocation source binding is invalid/u
  );
  assert.equal(api.has("terminal"), false);
});

test("fresh final ref proof catches writer acknowledgment after tag proof", async () => {
  const api = writerApi();
  api.afterNextTagRead(() => api.addWriterTerminal(REQUEST, "failed"));
  await assert.rejects(
    leaseClient(api).verifyWriter(REQUEST, WRITER_A),
    /final proof became terminal/u
  );
  assert.ok(api.urls.some((url) => {
    return /matching-refs\/tags\/npm-operations\/run-/u.test(url);
  }));
  assert.match(
    api.urls.at(-1) ?? "",
    /matching-refs\/tags\/npm-operations-open\//u
  );
});

test("completed history is never read to prove that operations are clear", async () => {
  const api = new FakeGitHub(REQUEST);
  for (let index = 1; index <= 10_000; index += 1) {
    const request = { ...REQUEST, runId: String(index) };
    api.addCommit(request, "active");
    api.addOpaqueTag(request, "terminal");
  }
  await leaseClient(api).assertNoUnterminatedActive();
  assert.equal(api.events.filter((event) => event === "GET tag").length, 0);
  assert.equal(
    api.urls.filter((url) => url.includes("matching-refs/tags/npm-operations/")).length,
    0
  );
  assert.equal(
    api.urls.filter((url) => {
      return url.includes("matching-refs/tags/npm-operations-open/");
    }).length,
    1
  );
});

test("exact namespace boundary ignores sibling tag prefixes", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addAbsoluteRef(
    "refs/tags/npm-operations-open-foo/not-a-lease",
    "commit",
    COMMIT
  );
  await leaseClient(api).assertNoUnterminatedActive();
  assert.match(api.urls[0] ?? "", /matching-refs\/tags\/npm-operations-open\//u);
});

test("holder rejects a terminal that contradicts writer acknowledgment", async () => {
  const api = writerApi();
  api.addWriterTerminal(REQUEST, "failed");
  api.addTerminal(REQUEST, "complete");
  await assert.rejects(
    leaseClient(api).startAndPoll(REQUEST),
    /no matching writer outcome/u
  );
});

function claimedApi(): FakeGitHub {
  const api = new FakeGitHub(REQUEST);
  api.addClaim(REQUEST, CLAIM_A);
  api.addReleaseAuthorization(REQUEST);
  return api;
}

function writerApi(): FakeGitHub {
  const api = claimedApi();
  api.addWriter(REQUEST, WRITER_A);
  return api;
}

function leaseClient(
  api: FakeGitHub,
  sleep: (milliseconds: number) => Promise<void> = async () => {},
  now: () => number = Date.now
): GitHubNpmOperationLease {
  api.setServerTime(now);
  return new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    sleep,
    pollIntervalMs: 1,
    maxPolls: 2,
    verifyControls: async () => {}
  });
}

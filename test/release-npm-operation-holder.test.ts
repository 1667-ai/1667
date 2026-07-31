import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GitHubNpmOperationLease,
  type GitHubNpmOperationLeaseOptions,
  type NpmOperationLeaseRequest
} from "../scripts/release-npm-operation-lease.js";
import { FakeGitHub } from "./release-npm-operation-lease-fixture.js";

const REPOSITORY = "1667-ai/1667";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLAIM = "a".repeat(64);
const WRITER = "b".repeat(64);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/**
 * Unclaimed timeout for the two claim deadline tests. The lease anchors the
 * deadline to the server clock and allows 999ms for the age of the concurrency
 * record, so the time left after the anchor is this value less 999ms. Keep about
 * a second left, so that a loaded machine still reaches the intercepted request
 * before the deadline ends the claim.
 */
const CLAIM_DEADLINE_TIMEOUT_MS = 2_000;
const REQUEST: NpmOperationLeaseRequest = Object.freeze({
  repository: REPOSITORY,
  runId: "123456789",
  runAttempt: "1",
  operation: "quarantine",
  version: "1.2.3",
  sourceCommit: COMMIT
});

test("the dependency-free holder bundle starts only the lease CLI", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "1667-holder-bundle-"));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const bundle = path.join(temporary, "holder.mjs");
  const buildOptions = {
    bundle: true,
    entryPoints: [path.join(ROOT, "scripts/release-npm-operation-lease-cli.ts")],
    format: "esm",
    logLevel: "silent",
    outfile: bundle,
    platform: "node",
    target: "node20"
  };
  const build = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { buildSync } from "esbuild";buildSync(${JSON.stringify(buildOptions)})`
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);

  const run = spawnSync(process.execPath, [bundle, "invalid"], {
    encoding: "utf8",
    env: {
      GITHUB_REPOSITORY: REPOSITORY,
      GH_TOKEN: ""
    }
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /release-npm-operation-lease: .* requires GH_TOKEN/u);
  assert.doesNotMatch(run.stderr, /release-npm-operation-controls/u);
});

test("dispatch authorization requires an administrator before queueing", async () => {
  const authorized = new FakeGitHub(REQUEST);
  await client(authorized).authorizeDispatch(REQUEST, "maintainer");
  assert.deepEqual(
    authorized.events.filter((event) => {
      return event === "GET workflow" || event === "GET collaborator permission";
    }),
    ["GET workflow", "GET collaborator permission"]
  );

  const unauthorized = new FakeGitHub(REQUEST);
  unauthorized.changePermission("maintain");
  await assert.rejects(
    client(unauthorized).authorizeDispatch(REQUEST, "maintainer"),
    /dispatcher is not an administrator/u
  );
});

test("dispatch authorization rejects a release request without authority", async () => {
  const request = Object.freeze({
    ...REQUEST,
    operation: "promotion" as const
  });
  const api = new FakeGitHub(request);
  await assert.rejects(
    client(api).authorizeDispatch(request, "maintainer"),
    /Release 1\.2\.3 is not complete/u
  );
});

test("the claim and holder require the exact in-progress hold job", async () => {
  for (const change of [
    { status: "queued" },
    { status: "completed", conclusion: "success" },
    { name: "authorize" },
    { run_id: 987654321 }
  ]) {
    const holderApi = new FakeGitHub(REQUEST);
    holderApi.changeHoldJob(change);
    await assert.rejects(
      client(holderApi).startAndPoll(REQUEST),
      /hold job is not authorized/u
    );

    const claimApi = new FakeGitHub(REQUEST);
    claimApi.changeHoldJob(change);
    await assert.rejects(
      client(claimApi).claim(REQUEST, CLAIM),
      /hold job is not authorized/u
    );
    assert.equal(claimApi.has("active"), false);
  }

  const duplicate = new FakeGitHub(REQUEST);
  duplicate.duplicateHoldJob();
  await assert.rejects(
    client(duplicate).startAndPoll(REQUEST),
    /hold job is not authorized/u
  );
});

test("the holder accepts the exact main-ref workflow path", async () => {
  const api = new FakeGitHub(REQUEST);
  api.changeWorkflow({
    path: ".github/workflows/release-npm-operation.yml@main"
  });
  api.addClaim(REQUEST, CLAIM);
  api.addWriter(REQUEST, WRITER);
  api.addWriterTerminal(REQUEST, "success");
  api.addTerminal(REQUEST, "complete");
  assert.equal(await client(api).startAndPoll(REQUEST), "complete");
});

test("the holder and claim require exact shared-lock membership", async () => {
  for (const change of [
    { job_name: "authorize" },
    { job_id: 987654322 },
    { run_id: 987654321 },
    { status: "pending" }
  ]) {
    const holderApi = new FakeGitHub(REQUEST);
    holderApi.changeConcurrencyMember(change);
    await assert.rejects(
      client(holderApi).startAndPoll(REQUEST),
      /concurrency holder is not authorized/u
    );

    const claimApi = new FakeGitHub(REQUEST);
    claimApi.changeConcurrencyMember(change);
    await assert.rejects(
      client(claimApi).claim(REQUEST, CLAIM),
      /concurrency holder is not authorized/u
    );
    assert.equal(claimApi.has("active"), false);
  }
});

test("the holder reads the complete versioned live concurrency group", async () => {
  const api = new FakeGitHub(REQUEST);
  await assert.rejects(
    client(api, { maxUnclaimedPolls: 1 }).startAndPoll(REQUEST),
    /was not claimed before its deadline/u
  );
  const calls = api.urls.map((url, index) => ({
    url: new URL(url),
    version: api.apiVersions[index]
  })).filter(({ url }) => url.pathname.includes("/actions/concurrency_groups"));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url.searchParams.get("per_page"), "100");
  assert.equal(calls[1]!.url.search, "");
  assert.deepEqual(calls.map(({ version }) => version), [
    "2026-03-10",
    "2026-03-10"
  ]);
});

test("the GitHub acquisition time rejects a late unclaimed holder", async () => {
  const now = 1_000_000;
  const holderApi = new FakeGitHub(REQUEST);
  holderApi.setServerTime(() => 100_000);
  holderApi.setConcurrencyAcquiredAt(() => 44_000);
  await assert.rejects(
    client(holderApi, { now: () => now }).startAndPoll(REQUEST),
    /was not claimed before its deadline/u
  );

  const claimApi = new FakeGitHub(REQUEST);
  claimApi.setServerTime(() => 100_000);
  claimApi.setConcurrencyAcquiredAt(() => 44_000);
  await assert.rejects(
    client(claimApi, { now: () => now }).claim(REQUEST, CLAIM),
    /was not claimed before its deadline/u
  );
  assert.equal(claimApi.has("active"), false);
});

test("a claim arms its deadline before holder authorization I/O", async () => {
  const api = new FakeGitHub(REQUEST);
  const probe = deadlineProbe(api, (url) => {
    return url.pathname.endsWith("/git/matching-refs/heads/main");
  });
  await assert.rejects(
    client(api, {
      fetch: probe.fetch,
      unclaimedTimeoutMs: CLAIM_DEADLINE_TIMEOUT_MS
    }).claim(REQUEST, CLAIM),
    /was not claimed before its deadline/u
  );
  assert.equal(probe.aborted(), true);
  assert.equal(api.has("active"), false);
});

test("a claim propagates its deadline to repository control I/O", async () => {
  const api = new FakeGitHub(REQUEST);
  const probe = deadlineProbe(api, (url) => {
    return url.pathname.includes("/environments/npm-operations");
  });
  const lease = new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: probe.fetch,
    unclaimedTimeoutMs: CLAIM_DEADLINE_TIMEOUT_MS
  });
  await assert.rejects(
    lease.claim(REQUEST, CLAIM),
    /was not claimed before its deadline/u
  );
  assert.equal(probe.aborted(), true);
  assert.equal(api.has("active"), false);
});

test("a timely immutable claim admits a holder that starts late", async () => {
  const now = 1_000_000;
  const api = new FakeGitHub(REQUEST);
  api.setServerTime(() => 100_000);
  api.setConcurrencyAcquiredAt(() => 44_000);
  api.addClaim(REQUEST, CLAIM);
  api.addWriter(REQUEST, WRITER);
  api.addWriterTerminal(REQUEST, "success");
  assert.equal(
    await client(api, {
      maxPolls: 2,
      now: () => now,
      sleep: async () => api.addTerminal(REQUEST, "complete")
    }).startAndPoll(REQUEST),
    "complete"
  );
});

test("a timely claim admits a holder after its local watchdog expires", async () => {
  const now = 1_000_000;
  const api = new FakeGitHub(REQUEST);
  api.setServerTime(() => 100_000);
  api.setConcurrencyAcquiredAt(() => 44_000);
  api.addClaim(REQUEST, CLAIM);
  api.addWriter(REQUEST, WRITER);
  api.addWriterTerminal(REQUEST, "success");
  assert.equal(
    await client(api, {
      lockStartedAtMs: now - 56_000,
      maxPolls: 2,
      now: () => now,
      sleep: async () => api.addTerminal(REQUEST, "complete")
    }).startAndPoll(REQUEST),
    "complete"
  );
});

test("a stalled acquisition check stops at the unclaimed deadline", async () => {
  const api = new FakeGitHub(REQUEST);
  const probe = deadlineProbe(api, (url) => {
    return url.pathname.endsWith("/actions/concurrency_groups");
  });
  await assert.rejects(
    client(api, {
      fetch: probe.fetch,
      unclaimedTimeoutMs: 20
    }).startAndPoll(REQUEST),
    /was not claimed before its deadline/u
  );
  assert.equal(probe.aborted(), true);
});

test("the first-step watchdog does not restart after acquisition", async () => {
  const api = new FakeGitHub(REQUEST);
  api.setServerTime(() => 100_000);
  api.setConcurrencyAcquiredAt(() => 100_900);
  const slowIgnoringFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    if (url.pathname.endsWith("/actions/concurrency_groups")) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return api.fetch(input, init);
  };
  await assert.rejects(
    client(api, {
      fetch: slowIgnoringFetch,
      unclaimedTimeoutMs: 300
    }).startAndPoll(REQUEST),
    /was not claimed before its deadline/u
  );
  assert.equal(api.events.includes("GET workflow"), false);
});

test("an unclaimed holder releases the lock before its short deadline", async () => {
  const api = new FakeGitHub(REQUEST);
  let sleeps = 0;
  await assert.rejects(
    client(api, {
      maxPolls: 4,
      maxUnclaimedPolls: 2,
      sleep: async () => {
        sleeps += 1;
      }
    }).startAndPoll(REQUEST),
    /was not claimed before its deadline/u
  );
  assert.equal(sleeps, 1);
});

test("the production unclaimed deadline is less than one minute", async () => {
  const api = new FakeGitHub(REQUEST);
  const intervals: number[] = [];
  let now = 1_000_000;
  api.setServerTime(() => now);
  const holder = new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    now: () => now,
    sleep: async (milliseconds) => {
      intervals.push(milliseconds);
      now += milliseconds;
    },
    verifyControls: async () => {}
  });
  await assert.rejects(
    holder.startAndPoll(REQUEST),
    /was not claimed before its deadline/u
  );
  assert.ok(intervals.length > 0);
  const total = intervals.reduce((sum, value) => sum + value, 0);
  assert.ok(total > 0 && total < 60_000);
  assert.equal(now, 1_000_000 + total);
  assert.ok(intervals.every((value) => value > 0));
});

test("production holder polling stays below the Actions token budget", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addClaim(REQUEST, CLAIM);
  api.addWriter(REQUEST, WRITER);
  api.addWriterTerminal(REQUEST, "success");
  const intervals: number[] = [];
  const holder = new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    maxPolls: 2,
    sleep: async (milliseconds) => {
      intervals.push(milliseconds);
      api.addTerminal(REQUEST, "complete");
    },
    verifyControls: async () => {}
  });
  assert.equal(await holder.startAndPoll(REQUEST), "complete");
  assert.deepEqual(intervals, [15_000]);
  assert.ok(2 * 60 * 60 * 1_000 / intervals[0]! < 500);
});

test("production holder polling is bounded to six hours", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addClaim(REQUEST, CLAIM);
  let elapsed = 0;
  const holder = new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    fetch: api.fetch,
    sleep: async (milliseconds) => {
      elapsed += milliseconds;
    },
    verifyControls: async () => {}
  });
  await assert.rejects(
    holder.startAndPoll(REQUEST),
    /active marker did not settle/u
  );
  assert.equal(elapsed, 6 * 60 * 60 * 1_000);
});

test("one valid immutable claim enables the long holder interval", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addClaim(REQUEST, CLAIM);
  api.addWriter(REQUEST, WRITER);
  api.addWriterTerminal(REQUEST, "success");
  let sleeps = 0;
  const terminal = await client(api, {
    maxPolls: 3,
    maxUnclaimedPolls: 1,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) api.addTerminal(REQUEST, "complete");
    }
  }).startAndPoll(REQUEST);

  assert.equal(terminal, "complete");
  assert.equal(sleeps, 2);
});

test("a valid immutable claim clears the API deadline signal", async () => {
  const api = new FakeGitHub(REQUEST);
  api.setServerTime(() => 100_000);
  api.setConcurrencyAcquiredAt(() => 100_900);
  api.addClaim(REQUEST, CLAIM);
  api.addWriter(REQUEST, WRITER);
  api.addWriterTerminal(REQUEST, "success");
  const abortAwareFetch: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted === true) throw init.signal.reason;
    return api.fetch(input, init);
  };
  let sleeps = 0;
  const terminal = await client(api, {
    fetch: abortAwareFetch,
    maxPolls: 3,
    sleep: async () => {
      sleeps += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (sleeps === 1) api.addTerminal(REQUEST, "complete");
    },
    unclaimedTimeoutMs: 200
  }).startAndPoll(REQUEST);
  assert.equal(terminal, "complete");
});

test("a malformed claim cannot enable the long holder interval", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addOpen(REQUEST);
  api.addCommit(REQUEST, "active");
  api.addTag(REQUEST, "claimed", '{"kind":"npm-operation-claim"}');
  await assert.rejects(
    client(api, {
      maxPolls: 3,
      maxUnclaimedPolls: 1
    }).startAndPoll(REQUEST),
    /secretSha256 is invalid/u
  );
});

test("a malformed claim cannot clear the API deadline signal", async () => {
  const api = new FakeGitHub(REQUEST);
  api.addOpen(REQUEST);
  api.addCommit(REQUEST, "active");
  api.addTag(REQUEST, "claimed", '{"kind":"npm-operation-claim"}');
  const delayedTagFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    if (!url.pathname.includes("/git/tags/")) return api.fetch(input, init);
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        void api.fetch(input, init).then(resolve, reject);
      }, 40);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      }, { once: true });
    });
  };
  await assert.rejects(
    client(api, {
      fetch: delayedTagFetch,
      unclaimedTimeoutMs: 20
    }).startAndPoll(REQUEST),
    /was not claimed before its deadline/u
  );
});

/**
 * Delay before deadlineProbe answers a request by itself. It stays far above
 * every deadline in these tests, so the lease deadline always ends the request
 * first.
 */
const DEADLINE_PROBE_FALLBACK_MS = 5_000;

/**
 * Holds one endpoint open until the lease deadline aborts the request. The lease
 * must arm its deadline before it starts the request and must pass the signal
 * into it; aborted() reports that it did both. A lease that does neither answers
 * from the fallback instead, which fails the aborted() assertion.
 */
interface DeadlineProbe {
  /** Replaces the lease fetch and intercepts the endpoint. */
  readonly fetch: typeof fetch;
  /** True after the lease deadline aborted the intercepted request. */
  readonly aborted: () => boolean;
}

function deadlineProbe(
  api: FakeGitHub,
  endpoint: (url: URL) => boolean
): DeadlineProbe {
  let aborted = false;
  const probeFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    if (!endpoint(url)) return api.fetch(input, init);
    const signal = init?.signal;
    assert.ok(signal);
    return await new Promise<Response>((resolve, reject) => {
      if (signal.aborted) {
        aborted = true;
        reject(signal.reason);
        return;
      }
      const fallback = setTimeout(() => resolve(new Response(null, {
        status: 500
      })), DEADLINE_PROBE_FALLBACK_MS);
      signal.addEventListener("abort", () => {
        aborted = true;
        clearTimeout(fallback);
        reject(signal.reason);
      }, { once: true });
    });
  };
  return { fetch: probeFetch, aborted: () => aborted };
}

function client(
  api: FakeGitHub,
  options: Pick<
    GitHubNpmOperationLeaseOptions,
    "fetch" | "lockStartedAtMs" | "maxPolls" | "maxUnclaimedPolls" | "now"
      | "sleep" | "unclaimedTimeoutMs"
  > = {}
): GitHubNpmOperationLease {
  return new GitHubNpmOperationLease({
    repository: REPOSITORY,
    token: "test-token",
    maxPolls: 2,
    maxUnclaimedPolls: 2,
    pollIntervalMs: 1,
    sleep: async () => {},
    verifyControls: async () => {},
    ...options,
    fetch: options.fetch ?? api.fetch
  });
}

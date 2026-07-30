import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRefStore } from
  "../scripts/release-github-ref-store.js";
import {
  NpmOperationRefNotYetVisibleError,
  type NpmOperationLeaseRequest
} from "../scripts/release-npm-operation-lease-state.js";
import {
  createOrVerifyNpmOperationRef
} from "../scripts/release-npm-operation-ref-writer.js";
import { FakeGitHub } from "./release-npm-operation-lease-fixture.js";

const REQUEST: NpmOperationLeaseRequest = Object.freeze({
  repository: "1667-ai/1667",
  runId: "123456789",
  runAttempt: "1",
  operation: "promotion",
  version: "1.2.3",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567"
});

test("ref verification aborts its retry wait without another attempt", async () => {
  const api = new FakeGitHub(REQUEST);
  const store = new GitHubRefStore({
    repository: REQUEST.repository,
    token: "test-token",
    fetch: api.fetch
  });
  const controller = new AbortController();
  const deadline = new Error("claim deadline expired");
  const timeout = Symbol("timeout");
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const operation = createOrVerifyNpmOperationRef(
    store,
    "refs/tags/test-ref",
    REQUEST.sourceCommit,
    "commit",
    "test ref",
    async () => {
      attempts += 1;
      controller.abort(deadline);
      throw new NpmOperationRefNotYetVisibleError("test ref is absent");
    },
    { signal: controller.signal }
  ).then((): unknown => undefined, (error: unknown) => error);
  const sentinel = new Promise<symbol>((resolve) => {
    timer = setTimeout(() => resolve(timeout), 50);
  });

  try {
    const outcome = await Promise.race([operation, sentinel]);
    assert.notEqual(outcome, timeout);
    assert.ok(outcome instanceof Error);
    assert.equal(outcome.name, "AbortError");
    assert.equal(
      (outcome as Error & { readonly cause?: unknown }).cause,
      deadline
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  assert.equal(attempts, 1);
});

import { expect, test } from "bun:test";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import type { StoryApi } from "../src/api.js";
import { createWorkerStoryApi } from "../src/worker-api.js";
import { FakeWorker, waitForRequest } from "./fixtures/fake-worker.js";

// Product-boundary coverage for the stream abort contract: the embedded
// backend is a FakeWorker on the real transport, driven through the public
// story API. Two rules hold together here. First, after a request's signal
// aborts, `onDelta` never runs again — late text reaches `onStopped` once,
// at terminal settlement, so a Stop save still receives it. Second, a
// deadline's error terminal carries the worker's unsent tail in
// `unsentText`, delivered before failure handling, and the failure itself
// stays an uncertain failure.

test("a deadline error's unsent tail flows through onDelta before the failure is released", async () => {
  const worker = new FakeWorker(true);
  const events: string[] = [];
  const backend = await createWorkerStoryApi({
    worker,
    readyTimeoutMs: 100,
    onRecoveryWarnings: (warnings) => {
      if (warnings.length > 0) events.push("failure-handling");
    }
  });
  await primeStoryVersion(backend.api, worker);
  const pending = backend.api.continueStory(
    "story", "Continue", "generation", { parentId: null },
    (text) => events.push(`delta:${text}`),
    new AbortController().signal
  );
  const request = await waitForRequest(worker, "continueStory");

  worker.message({ type: "delta", id: request.id, sequence: 0, text: "early" });
  worker.message({
    type: "error",
    id: request.id,
    failure: createFailureEnvelope({
      code: "mutation_outcome_unknown",
      message: "Worker mutation recovery deadline exceeded; the request was retained for reconciliation.",
      status: 408
    }),
    mutationOutcome: "uncertain",
    unsentText: " tail"
  });

  const failure = await rejection(pending);
  // The tail arrived on the live channel (the signal never aborted) and
  // strictly before the uncertain-failure handling; the failure was not
  // converted into a stop-style success.
  expect(events).toEqual(["delta:early", "delta: tail", "failure-handling"]);
  expect(failure).toMatchObject({
    status: 408,
    code: "mutation_outcome_unknown"
  });
  await backend.dispose();
});

test("an abort keeps a racing deadline's tail out of onDelta and hands it to onStopped", async () => {
  const worker = new FakeWorker(true);
  const backend = await createWorkerStoryApi({
    worker,
    readyTimeoutMs: 100,
    onRecoveryWarnings: () => {}
  });
  const cancel = new AbortController();
  const deltas: string[] = [];
  const stopped: string[] = [];
  await primeStoryVersion(backend.api, worker);
  const pending = backend.api.continueStory(
    "story", "Continue", "generation", { parentId: null },
    (text) => deltas.push(text), cancel.signal,
    (text) => stopped.push(text)
  );
  const request = await waitForRequest(worker, "continueStory");

  worker.message({ type: "delta", id: request.id, sequence: 0, text: "before" });
  cancel.abort();
  worker.message({ type: "delta", id: request.id, sequence: 1, text: " withheld" });
  worker.message({
    type: "error",
    id: request.id,
    failure: createFailureEnvelope({
      code: "mutation_outcome_unknown",
      message: "Worker mutation recovery deadline exceeded; the request was retained for reconciliation.",
      status: 408
    }),
    mutationOutcome: "uncertain",
    unsentText: " unsent"
  });

  const failure = await rejection(pending);
  expect(deltas).toEqual(["before"]);
  expect(stopped).toEqual([" withheld unsent"]);
  expect(failure).toMatchObject({
    status: 408,
    code: "mutation_outcome_unknown"
  });
  await backend.dispose();
});

async function primeStoryVersion(
  api: Pick<StoryApi, "loadStory">,
  worker: FakeWorker,
  storyId = "story"
): Promise<void> {
  const loading = api.loadStory(storyId);
  const request = await waitForRequest(worker, "loadStory");
  worker.message({
    type: "result",
    id: request.id,
    value: {
      id: storyId,
      nodes: [],
      path: [],
      aggregateVersion: { kind: "v6", revision: "1" }
    }
  });
  await loading;
}

async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("Expected promise to reject");
}

import { expect, test } from "bun:test";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { startRecoveryOrchestration } from "../src/recovery-orchestration.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { RecoveryWarningFeed } from "../src/recovery-warning-feed.js";
import {
  WorkerApiError,
  type WorkerRecoveryWarning
} from "../src/worker-api.js";

test("generation recovery carries its provider context", async () => {
  const source = demoAppSource();
  const feed = new RecoveryWarningFeed();
  source.backendRecovery = feed;
  const warning: WorkerRecoveryWarning = {
    mutationId: "m1-generation-recovery",
    method: "continueStory",
    storyId: source.payload.id,
    providerRecovery: {
      kind: "target",
      providerMutationId:
        "m1.1767225600001.1123456789abcdef0123456789abcdef"
    },
    resolution: "archived",
    error: new WorkerApiError(createFailureEnvelope({
      code: "generation_outcome_unknown",
      message: "Provider outcome is unknown.",
      status: 409
    }))
  };
  let receivedContext: unknown;
  source.api.acknowledgeUnknownOutcomes = async (
    _storyId,
    _warningMutationId,
    providerRecovery
  ) => {
    receivedContext = providerRecovery;
    return source.payload;
  };
  const state = initialState(source, false);
  const settled = deferred<void>();
  const repaint = () => {
    if (state.backendTask === null
      && receivedContext !== undefined) {
      settled.resolve();
    }
  };
  const stop = startRecoveryOrchestration({
    state,
    source,
    backend: new ActionRuntime(state, repaint),
    cache: createWrapCache<ProseStyle>(),
    repaint
  });

  expect(feed.publish([warning])).toBeTrue();
  await settled.promise;

  expect(receivedContext).toEqual(warning.providerRecovery);
  expect(state.toast).toBe(
    "something interrupted the model · you can try again"
  );
  stop();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

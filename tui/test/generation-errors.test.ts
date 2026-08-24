import { describe, expect, test } from "bun:test";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import { createComposer } from "../src/composer-model.js";
import { capturePendingDirectDraft } from "../src/composer-ownership.js";
import { demoAppSource } from "../src/demo.js";
import { generate, requestGenerationStop } from "../src/generation-action.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { recordSessionNotices } from "../src/notice-log.js";
import {
  streamPresentedReasoningText,
  streamPresentedText
} from "../src/stream-text.js";
import { currentPartActions, openActions } from "../src/story-actions.js";
import { workerApiErrorFromFailure } from "../src/worker-error.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForRecoveredPresentation(state: ReturnType<typeof initialState>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while ((state.stream?.presentation?.pendingLength ?? 0) > 0
    || (state.stream?.reasoning?.presentation?.pendingLength ?? 0) > 0) {
    if (Date.now() > deadline) throw new Error("Recovered presentation did not drain");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The exact wire shape server/worker-request-cancellation.ts's
 *  `deadlineError` produces for the worker stream deadline: status 408,
 *  code "mutation_outcome_unknown" for a mutation (continueStory always is),
 *  and the clean-timeout provenance stamp (issue #345).
 *  generation-action.ts's isTimeoutClassApiFailure gates on that stamp. */
function workerDeadlineFailure(message: string) {
  return workerApiErrorFromFailure(createFailureEnvelope({
    code: "mutation_outcome_unknown",
    message,
    status: 408,
    timeout: "worker-deadline"
  }));
}

/** The wire shape of a deadline that raced another in-flight failure:
 *  `WorkerRequestCancellation.failure()` rebuilds that failure as a
 *  `DiagnosticServiceError` (server/worker-request-cancellation.ts) with no
 *  clean-timeout stamp, which reaches the client as a
 *  `DiagnosticFailureEnvelope` — same 408 and "mutation_outcome_unknown" as
 *  a clean deadline, but masked. isTimeoutClassApiFailure must never match
 *  it. */
function maskedDeadlineFailure(message: string) {
  return workerApiErrorFromFailure(createFailureEnvelope(
    {
      code: "mutation_outcome_unknown",
      message,
      status: 408
    },
    `err_${"a".repeat(24)}`
  ));
}

/** The exact wire shape a rejected provider generation carries once
 *  classifyServiceError (server/service-error-policy.ts) folds it down:
 *  every ProviderError and every GenerationResultError with a 5xx status —
 *  including the exact-echo continuation rejection in
 *  server/generation-http.ts — collapses to (502, "provider_failure") with
 *  no clean-timeout stamp. isTimeoutClassApiFailure must never match it. */
function providerRejectionFailure(message: string) {
  return workerApiErrorFromFailure(createFailureEnvelope({
    code: "provider_failure",
    message,
    status: 502
  }));
}

function stoppedTakeRace(
  outcome: "partial-error" | "partial-null" | "complete",
  gateSave = false
) {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const generationEntered = deferred<void>();
  const generationGate = deferred<void>();
  const saveEntered = deferred<void>();
  const saveGate = deferred<void>();
  const createNode = source.api.createNode;
  let genId = "";

  state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
  source.api.continueStory = async (
    storyId,
    instruction,
    requestGenId,
    target,
    onDelta
  ) => {
    genId = requestGenId;
    onDelta(outcome === "complete" ? "arrived before Stop" : "arrived partial take");
    generationEntered.resolve();
    await generationGate.promise;
    if (outcome === "partial-error") {
      throw new Error("cancellation control failed");
    }
    if (outcome === "partial-null") return null;
    if (target.appendTo !== undefined) throw new Error("expected a new take");
    const payload = await createNode(storyId, {
      parentId: target.parentId ?? null,
      instruction,
      text: "complete take won the Stop race",
      genId: requestGenId
    });
    return { payload, droppedFacts: [] };
  };
  if (gateSave) {
    source.api.createNode = async (...args) => {
      saveEntered.resolve();
      await saveGate.promise;
      return createNode(...args);
    };
  }

  const pending = backend.run("generating prose", (task) =>
    generate(
      state,
      source,
      cache,
      () => undefined,
      "take another route",
      null,
      null,
      task
    ));
  return {
    state,
    generationEntered: generationEntered.promise,
    saveEntered: saveEntered.promise,
    finishGeneration: () => generationGate.resolve(),
    finishSave: () => saveGate.resolve(),
    stop: () => {
      beginInteraction(state);
      requestGenerationStop(state, () => undefined);
    },
    pending,
    created: () => state.payload.path.find((node) => node.genId === genId)
  };
}

describe("generation errors", () => {
  test("a backend failure remains visible after later local navigation", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const entered = deferred<void>();
    const gate = deferred<void>();
    source.api.continueStory = async () => {
      entered.resolve();
      await gate.promise;
      throw new Error("provider request failed");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "", null, null, task));
    await entered.promise;
    beginInteraction(state);
    state.focusIndex = 0;
    gate.resolve();
    await pending;

    expect(state.toast).toBe("provider request failed");
    expect(state.focusIndex).toBe(0);
    expect(state.stream).toBe(null);
    expect(state.backendTask).toBe(null);
  });

  test("a backend failure closes an action menu whose virtual part disappeared", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const entered = deferred<void>();
    const gate = deferred<void>();
    source.api.continueStory = async () => {
      entered.resolve();
      await gate.promise;
      throw new Error("provider request failed");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "", null, null, task));
    await entered.promise;
    const streamId = state.stream!.targetId;
    const streamRow = rowIndexForNode(createStoryViewModel(state.payload, state.stream), streamId);
    beginInteraction(state);
    openActions(state, streamRow);
    expect(state.actions?.partId).toBe(streamId);
    expect(currentPartActions(state).map(({ id }) => id)).not.toContain("tag");
    expect(currentPartActions(state).map(({ id }) => id)).not.toContain("prune");
    expect(currentPartActions(state).map(({ id }) => id)).not.toContain("retake-with-prompt");

    gate.resolve();
    await pending;

    expect(state.stream).toBe(null);
    expect(state.actions).toBe(null);
    expect(state.mode).toBe("NAV");
    expect(state.toast).toBe("provider request failed");
  });

  test("Stop keeps arrived text after cancellation control fails", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const presentationLengths: Array<number | null> = [];
    const repaint = () => {
      presentationLengths.push(state.stream?.presentation?.presentedText.length ?? null);
    };
    const backend = new ActionRuntime(state, repaint);
    const entered = deferred<void>();
    const gate = deferred<void>();
    let saves = 0;
    let savedText = "";
    const arrived = "queued provider text ".repeat(12).trimEnd();
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta
    ) => {
      onDelta(arrived);
      entered.resolve();
      await gate.promise;
      throw new Error("cancellation control failed");
    };
    source.api.createNode = async (_storyId, body) => {
      saves += 1;
      savedText = body.text;
      return source.payload;
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, repaint, "", null, null, task));
    await entered.promise;
    expect(state.stream?.text).toBe(arrived);
    expect(state.stream?.presentation?.pendingLength ?? 0).toBeGreaterThan(0);
    requestGenerationStop(state, repaint);
    expect(state.stream).toBe(null);
    expect(presentationLengths.at(-1)).toBe(null);
    gate.resolve();
    await pending;

    expect(saves).toBe(1);
    expect(savedText).toBe(arrived);
    expect(state.toast).toBe(null);
  });

  test("successful generation drains the presentation before payload adoption", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const presentationLengths: Array<number | null> = [];
    const repaint = () => {
      presentationLengths.push(state.stream?.presentation?.presentedText.length ?? null);
    };
    const generated = "x".repeat(160);
    source.api.continueStory = async (
      storyId,
      instruction,
      genId,
      target,
      onDelta
    ) => {
      onDelta(generated);
      const payload = target.appendTo !== undefined
        ? await source.api.createNode(storyId, {
          appendTo: target.appendTo,
          expectedTextHash: target.expectedTextHash!,
          instruction,
          text: generated,
          genId
        })
        : await source.api.createNode(storyId, {
          parentId: target.parentId ?? null,
          instruction,
          text: generated,
          genId
        });
      return { payload, droppedFacts: [] };
    };

    const backend = new ActionRuntime(state, repaint);
    await backend.run("generating prose", (task) =>
      generate(state, source, cache, repaint, "", null, null, task));

    expect(presentationLengths).toContain(16);
    expect(presentationLengths).toContain(generated.length);
    expect(state.payload.path.some((node) => node.text.endsWith(generated))).toBeTrue();
    expect(state.stream).toBe(null);
  });

  test("a deadline failure keeps text that already streamed", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    // A repaint that actually sweeps notices, the same as the real app's
    // (recordSessionNotices, app.ts) — a stubbed no-op repaint cannot see a
    // toast this settlement shows getting swept into the log a second time
    // alongside an explicit recordNotice of the same text.
    const repaint = () => recordSessionNotices(state);
    const backend = new ActionRuntime(state, repaint);
    const entered = deferred<void>();
    const gate = deferred<void>();
    let genId = "";
    let saves = 0;
    const createNode = source.api.createNode;
    source.api.createNode = async (...args) => {
      saves += 1;
      return await createNode(...args);
    };
    source.api.continueStory = async (
      _storyId,
      _instruction,
      requestGenId,
      _target,
      onDelta
    ) => {
      genId = requestGenId;
      onDelta("prose that arrived before the deadline");
      entered.resolve();
      await gate.promise;
      // Mirrors what worker-request-executor.ts actually publishes for a
      // deadline stop: a rejection (an "error" terminal), never the
      // "complete" + stoppedText shape a user Stop resolves with — and the
      // signal is never aborted, since the writer never pressed Escape. The
      // exact wire shape (408, "mutation_outcome_unknown") is what
      // isCleanWorkerMutationDeadline gates on.
      throw workerDeadlineFailure("Worker request deadline exceeded");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, repaint, "keep going", null, null, task));
    await entered.promise;
    gate.resolve();
    await pending;

    expect(saves).toBe(1);
    const created = state.payload.path.find((node) => node.genId === genId);
    expect(created?.text).toBe("prose that arrived before the deadline");
    expect(state.payload.path.at(-1)?.id).toBe(created?.id);
    const notice = "Worker request deadline exceeded · generation stopped · text kept";
    expect(state.toast).toBe(notice);
    expect(state.stream).toBe(null);
    // The shown toast is swept into the log by the real repaint above; the
    // commit path must not also call recordNotice for the same text, or this
    // is two entries for one fact instead of one.
    expect(state.notices.entries.filter((entry) => entry.text === notice).length).toBe(1);
  });

  test("a deadline failure keeps text and logs the reason even without focus", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const repaint = () => recordSessionNotices(state);
    const backend = new ActionRuntime(state, repaint);
    const entered = deferred<void>();
    const gate = deferred<void>();
    let genId = "";
    source.api.continueStory = async (
      _storyId,
      _instruction,
      requestGenId,
      _target,
      onDelta
    ) => {
      genId = requestGenId;
      onDelta("prose that arrived before the deadline");
      entered.resolve();
      await gate.promise;
      throw workerDeadlineFailure("Worker request deadline exceeded");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, repaint, "keep going", null, null, task));
    await entered.promise;
    // The writer moved on before the deadline fired — the likely case for a
    // 30-minute timeout — so this settlement no longer owns focus and must
    // not show a toast.
    beginInteraction(state);
    gate.resolve();
    await pending;

    const created = state.payload.path.find((node) => node.genId === genId);
    expect(created?.text).toBe("prose that arrived before the deadline");
    expect(state.toast).toBe(null);
    const notice = "Worker request deadline exceeded · generation stopped · text kept";
    // No toast is ever shown to sweep, so recordNotice is the only writer —
    // exactly one entry, not a duplicate.
    expect(state.notices.entries.filter((entry) =>
      entry.channel === "toast" && entry.text === notice
    ).length).toBe(1);
  });

  test("a deadline failure never claims text kept when the commit itself fails", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const entered = deferred<void>();
    const gate = deferred<void>();
    const arrived = "deadline provider burst ".repeat(32).trimEnd();
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta
    ) => {
      onDelta(arrived);
      entered.resolve();
      await gate.promise;
      throw workerDeadlineFailure("Worker request deadline exceeded");
    };
    // The deadline stop's own commit also fails (an append conflict, or the
    // worker being unhealthy right after a deadline) — settleStoppedGeneration
    // falls back to loadStory, which succeeds (source.api.loadStory is left
    // as the demo default), so `adopted` is true even though nothing was
    // ever durably saved. Only `committed` may distinguish the two.
    source.api.createNode = async () => {
      throw new Error("append conflict: the leaf changed underneath this take");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "keep going", null, null, task));
    await entered.promise;
    gate.resolve();
    await pending;
    await waitForRecoveredPresentation(state);

    // The real save failure reaches the writer, not a "text kept" claim, and
    // it is not silently overwritten by the deadline's own toast.
    expect(state.toast).toBe("append conflict: the leaf changed underneath this take");
    expect(state.notices.entries.some((entry) => entry.text.includes("text kept"))).toBe(false);
    // The prose is not lost — it survives in the still-visible stream, even
    // though the commit never landed.
    expect(state.stream?.text).toBe(arrived);
    expect(state.stream?.presentation).toBeDefined();
    expect(state.stream === null ? "" : streamPresentedText(state.stream)).toBe(arrived);
  });

  test("ordinary recovery repaints after the generation task releases", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const repaints: number[] = [];
    const repaint = () => {
      if (state.stream?.presentation !== undefined) {
        repaints.push(state.stream.presentation.presentedText.length);
      }
    };
    const backend = new ActionRuntime(state, repaint);
    const entered = deferred<void>();
    const gate = deferred<void>();
    const arrived = "ordinary recovery burst ".repeat(200).trimEnd();
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta
    ) => {
      onDelta(arrived);
      entered.resolve();
      await gate.promise;
      throw workerDeadlineFailure("Worker request deadline exceeded");
    };
    source.api.createNode = async () => {
      throw new Error("recovery save failed");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, repaint, "keep going", null, null, task));
    await entered.promise;
    gate.resolve();
    await pending;
    const repaintsAfterTask = repaints.length;
    await waitForRecoveredPresentation(state);

    expect(repaints.length).toBeGreaterThan(repaintsAfterTask);
    expect(state.stream?.text).toBe(arrived);
  });

  test("a deadline failure whose recovery save also fails is still logged without focus", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const entered = deferred<void>();
    const gate = deferred<void>();
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta
    ) => {
      onDelta("prose that arrived before the deadline");
      entered.resolve();
      await gate.promise;
      throw workerDeadlineFailure("Worker request deadline exceeded");
    };
    // The recovery commit also fails, and loadStory's fallback is left to
    // the demo default, which succeeds.
    source.api.createNode = async () => {
      throw new Error("append conflict: the leaf changed underneath this take");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "keep going", null, null, task));
    await entered.promise;
    // The writer moved on before either failure landed, so this settlement
    // no longer owns focus and must not show a toast — but the reason a
    // failed save is not the same as a silently kept text must still be
    // retrievable, or the writer has no way to ever learn the prose sitting
    // on screen was never durably saved.
    beginInteraction(state);
    gate.resolve();
    await pending;

    expect(state.toast).toBe(null);
    // Two distinct facts, two entries: the save failure (recorded inside
    // settleStoppedGeneration's catch) and the deadline that started this
    // settlement in the first place (recorded at the generate() call site).
    // Losing either one leaves the writer unable to reconstruct what
    // actually happened to the prose sitting on screen.
    expect(state.notices.entries.some((entry) =>
      entry.channel === "toast"
      && entry.text === "append conflict: the leaf changed underneath this take"
    )).toBe(true);
    expect(state.notices.entries.some((entry) =>
      entry.channel === "toast"
      && entry.text === "Worker request deadline exceeded"
    )).toBe(true);
    // The prose is not lost — it survives in the still-visible stream, even
    // though the commit never landed and nothing shows a toast for it.
    expect(state.stream?.text).toBe("prose that arrived before the deadline");
  });

  test("a deadline failure with no streamed text creates no take", async () => {
    for (const partial of ["", "   "]) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const backend = new ActionRuntime(state, () => undefined);
      const entered = deferred<void>();
      const gate = deferred<void>();
      let saves = 0;
      const beforeIds = state.payload.path.map((node) => node.id);
      const createNode = source.api.createNode;
      source.api.createNode = async (...args) => {
        saves += 1;
        return await createNode(...args);
      };
      source.api.continueStory = async (
        _storyId,
        _instruction,
        _genId,
        _target,
        onDelta
      ) => {
        if (partial.length > 0) onDelta(partial);
        entered.resolve();
        await gate.promise;
        throw new Error("Worker request deadline exceeded");
      };

      const pending = backend.run("generating prose", (task) =>
        generate(state, source, cache, () => undefined, "keep going", null, null, task));
      await entered.promise;
      gate.resolve();
      await pending;

      expect(saves).toBe(0);
      expect(state.payload.path.map((node) => node.id)).toEqual(beforeIds);
      expect(state.toast).toBe("Worker request deadline exceeded");
      expect(state.stream).toBe(null);
    }
  });

  test("a rejected continuation with substantive streamed text is never committed", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const entered = deferred<void>();
    const gate = deferred<void>();
    let saves = 0;
    const beforeIds = state.payload.path.map((node) => node.id);
    const createNode = source.api.createNode;
    source.api.createNode = async (...args) => {
      saves += 1;
      return await createNode(...args);
    };
    const rejectionMessage =
      "The model did not continue from the exact final characters; nothing was saved.";
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta
    ) => {
      // The model streamed real prose, then failed its exact-echo boundary
      // check (server/generation-http.ts) — a repeated or normalized copy
      // of the existing tail, not a timeout. The server's contract is
      // "nothing was saved"; this must stay a rejection, never a commit.
      onDelta("prose that echoes the tail instead of continuing it");
      entered.resolve();
      await gate.promise;
      throw providerRejectionFailure(rejectionMessage);
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "keep going", null, null, task));
    await entered.promise;
    gate.resolve();
    await pending;

    // No node was created from the rejected output — createNode was never
    // even called, and the active leaf did not gain a corrupted take.
    expect(saves).toBe(0);
    expect(state.payload.path.map((node) => node.id)).toEqual(beforeIds);
    // The server's rejection reaches the writer verbatim, not a "text kept"
    // claim — this is the one honest thing generate() can say here.
    expect(state.toast).toBe(rejectionMessage);
    expect(state.notices.entries.some((entry) => entry.text.includes("text kept"))).toBe(false);
    // The transient stream is cleared like any other plain failure — nothing
    // is kept on screen for a rejection the server explains as a total loss.
    expect(state.stream).toBe(null);
  });

  test("a deadline masking a raced rejection is never committed", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const entered = deferred<void>();
    const gate = deferred<void>();
    let saves = 0;
    const beforeIds = state.payload.path.map((node) => node.id);
    const createNode = source.api.createNode;
    source.api.createNode = async (...args) => {
      saves += 1;
      return await createNode(...args);
    };
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta
    ) => {
      // The worker's deadline fired at the same instant an exact-echo
      // rejection landed. WorkerRequestCancellation.failure() rebuilds that
      // rejection as a deadline failure, so it wears the same 408 +
      // "mutation_outcome_unknown" a clean deadline wears — but with a
      // diagnosticRef, since its real cause is logged, not discarded.
      onDelta("prose that echoes the tail instead of continuing it");
      entered.resolve();
      await gate.promise;
      throw maskedDeadlineFailure("Worker request deadline exceeded");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "keep going", null, null, task));
    await entered.promise;
    gate.resolve();
    await pending;

    // A masked deadline must not commit — the status and code alone are not
    // enough proof that a timeout was the only thing that happened here.
    expect(saves).toBe(0);
    expect(state.payload.path.map((node) => node.id)).toEqual(beforeIds);
    // ApiError appends the diagnostic reference to the message it carries;
    // the writer still sees the deadline wording, just with a reference.
    expect(state.toast).toContain("Worker request deadline exceeded");
    expect(state.notices.entries.some((entry) => entry.text.includes("text kept"))).toBe(false);
  });

  test("Stop focuses the new take after its arrived text is saved", async () => {
    const race = stoppedTakeRace("partial-error");
    await race.generationEntered;
    race.stop();
    race.finishGeneration();
    await race.pending;

    const created = race.created();
    expect(created).toBeDefined();
    expect(race.state.payload.path.at(-1)?.id).toBe(created?.id);
    expect(
      createStoryViewModel(race.state.payload).rows[race.state.focusIndex]?.id
    ).toBe(created?.id);
  });

  test("repeated Stop keeps focus ownership while the partial take saves", async () => {
    const race = stoppedTakeRace("partial-null", true);
    await race.generationEntered;
    race.stop();
    race.finishGeneration();
    await race.saveEntered;
    race.stop();
    race.finishSave();
    await race.pending;

    const created = race.created();
    expect(created).toBeDefined();
    expect(
      createStoryViewModel(race.state.payload).rows[race.state.focusIndex]?.id
    ).toBe(created?.id);
  });

  test("Stop focuses the completed take when the full response wins the race", async () => {
    const race = stoppedTakeRace("complete");
    await race.generationEntered;
    race.stop();
    race.finishGeneration();
    await race.pending;

    const created = race.created();
    expect(created?.text).toBe("complete take won the Stop race");
    expect(
      createStoryViewModel(race.state.payload).rows[race.state.focusIndex]?.id
    ).toBe(created?.id);
  });

  test("a stopped take save does not steal focus after later navigation", async () => {
    const race = stoppedTakeRace("partial-null", true);
    await race.generationEntered;
    race.stop();
    race.finishGeneration();
    await race.saveEntered;
    beginInteraction(race.state);
    race.state.focusIndex = 0;
    race.finishSave();
    await race.pending;

    expect(race.created()).toBeDefined();
    expect(race.state.focusIndex).toBe(0);
  });

  test("a stopped-text save failure stays visible", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const generationEntered = deferred<void>();
    const generationGate = deferred<void>();
    const arrived = "large stopped provider batch ".repeat(16).trimEnd();
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta,
      _signal,
      callbacks
    ) => {
      onDelta(arrived);
      generationEntered.resolve();
      await generationGate.promise;
      callbacks?.onReasoningStopped?.("reasoning only after Stop");
      return null;
    };
    source.api.createNode = async () => {
      throw new Error("partial save failed");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "", null, null, task));
    await generationEntered.promise;
    requestGenerationStop(state, () => undefined);
    generationGate.resolve();
    await pending;
    await waitForRecoveredPresentation(state);

    expect(state.toast).toBe("partial save failed");
    expect(state.stream?.text).toBe(arrived);
    expect(state.stream?.presentation).toBeDefined();
    expect(state.stream === null ? "" : streamPresentedText(state.stream)).toBe(arrived);
    expect(state.stream?.reasoning?.presentation).toBeDefined();
    expect(state.stream === null ? "" : streamPresentedReasoningText(state.stream))
      .toBe("reasoning only after Stop");
  });

  test("a failed stopped save exposes an oversized grapheme without a recovery spin", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const generationEntered = deferred<void>();
    const generationGate = deferred<void>();
    const oversized = `e${"\u0301".repeat(1_000)}`;
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta
    ) => {
      onDelta(oversized);
      generationEntered.resolve();
      await generationGate.promise;
      return null;
    };
    source.api.createNode = async () => {
      throw new Error("partial save failed");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "", null, null, task));
    await generationEntered.promise;
    requestGenerationStop(state, () => undefined);
    generationGate.resolve();
    await pending;

    expect(state.stream?.text).toBe(oversized);
    expect(state.stream?.presentation?.bypassed).toBeTrue();
    expect(state.stream === null ? "" : streamPresentedText(state.stream)).toBe(oversized);
  });

  test("a failed stopped-text save cannot steal focus from later navigation", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const generationEntered = deferred<void>();
    const generationGate = deferred<void>();
    const saveEntered = deferred<void>();
    const saveGate = deferred<void>();
    state.composer = createComposer();
    const submitted = capturePendingDirectDraft(state, "submitted direction");
    state.pendingGenerationDraft = submitted;
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta
    ) => {
      onDelta("arrived text");
      generationEntered.resolve();
      await generationGate.promise;
      return null;
    };
    source.api.createNode = async () => {
      saveEntered.resolve();
      await saveGate.promise;
      throw new Error("partial save failed");
    };

    const pending = backend.run("generating prose", (task) =>
      generate(
        state,
        source,
        cache,
        () => undefined,
        submitted.text,
        null,
        submitted,
        task
      ));
    await generationEntered.promise;
    requestGenerationStop(state, () => undefined);
    generationGate.resolve();
    await saveEntered.promise;
    beginInteraction(state);
    state.mode = "MAP";
    saveGate.resolve();
    await pending;

    expect(state.mode).toBe("MAP");
    expect(state.composer.text).toBe("submitted direction");
    expect(state.toast).toBe(null);
    expect(state.stream?.text).toBe("arrived text");
  });

  test("a later empty generation cannot resurrect an older submitted draft", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const entered = [deferred<void>(), deferred<void>()];
    const gates = [deferred<null>(), deferred<null>()];
    let generation = 0;
    source.api.continueStory = async () => {
      const index = generation++;
      entered[index]!.resolve();
      return gates[index]!.promise;
    };

    state.composer = createComposer();
    const submitted = capturePendingDirectDraft(state, "older submitted direction");
    state.pendingGenerationDraft = submitted;
    const first = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, submitted.text, null, submitted, task));
    await entered[0]!.promise;
    expect(state.stream?.pendingDraft).toBe(submitted);

    state.composer = createComposer("newer direction");
    requestGenerationStop(state, () => undefined);
    gates[0]!.resolve(null);
    await first;

    expect(state.composer.text).toBe("newer direction");
    expect(state.pendingGenerationDraft).toBe(null);

    state.composer = createComposer();
    const second = backend.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "", null, null, task));
    await entered[1]!.promise;
    requestGenerationStop(state, () => undefined);
    gates[1]!.resolve(null);
    await second;

    expect(state.composer.text).toBe("");
    expect(state.pendingGenerationDraft).toBe(null);
  });
});

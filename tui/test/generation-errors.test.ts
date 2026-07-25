import { describe, expect, test } from "bun:test";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import { createComposer } from "../src/composer-model.js";
import { capturePendingDirectDraft } from "../src/composer-ownership.js";
import { demoAppSource } from "../src/demo.js";
import { generate, requestGenerationStop } from "../src/generation-action.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { currentPartActions, openActions } from "../src/story-actions.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    expect(currentPartActions(state).map(({ id }) => id)).not.toContain("bookmark");
    expect(currentPartActions(state).map(({ id }) => id)).not.toContain("prune");
    expect(currentPartActions(state).map(({ id }) => id)).not.toContain("retake-with-prompt");

    gate.resolve();
    await pending;

    expect(state.stream).toBe(null);
    expect(state.actions).toBe(null);
    expect(state.mode).toBe("NAV");
    expect(state.toast).toBe("provider request failed");
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

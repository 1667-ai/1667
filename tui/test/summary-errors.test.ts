import { describe, expect, test } from "bun:test";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import { initialState, type AppSource } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { startSummary } from "../src/summary-action.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("summary errors", () => {
  test("a provider failure remains visible after later local input", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const entered = deferred<Awaited<ReturnType<AppSource["api"]["createSummaryTake"]>>>();
    source.api.createSummaryTake = async () => entered.promise;

    const pending = startSummary(state, source, { backend, cache, repaint: () => undefined });
    expect(state.mode).toBe("SUMMARY");
    beginInteraction(state);
    state.focusIndex = 0;
    entered.reject(new Error("summary provider failed"));
    await pending;

    expect(state.toast).toBe("summary provider failed");
    expect(state.focusIndex).toBe(0);
    expect(state.mode).toBe("NAV");
    expect(state.summary).toBe(null);
    expect(state.abort).toBe(null);
    expect(state.backendTask).toBe(null);
  });

  test("a completed summary drains its preview without delaying line switch", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const switchEntered = deferred<void>();
    const switchGate = deferred<void>();
    const nodeId = source.payload.path.at(-1)!.id;
    const summaryText = `${"summary words ".repeat(64)}¶ 3 of 3`;
    source.api.createSummaryTake = async (_storyId, _body, onDelta) => {
      onDelta(summaryText);
      return { nodeId, narrowedTo: null };
    };
    source.api.switchLine = async () => {
      switchEntered.resolve();
      await switchGate.promise;
      return source.payload;
    };

    const pending = startSummary(state, source, { backend, cache, repaint: () => undefined });
    await switchEntered.promise;
    const deadline = Date.now() + 1_000;
    while ((state.summary?.presentation?.pendingLength ?? 0) > 0) {
      if (Date.now() > deadline) throw new Error("Summary presentation did not drain");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(state.summary?.presentation?.presentedText).toBe(summaryText);
    switchGate.resolve();
    await pending;
  });
});

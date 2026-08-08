import { describe, expect, test } from "bun:test";
import type { PromptTokenCount } from "../../shared/tokenize-source.js";
import {
  startPromptTokenCountLane,
  type PromptTokenCountApi
} from "../src/prompt-token-count.js";
import {
  countedPromptTokenAnswer as countedAnswer,
  flushPromptTokenCount as flush,
  promptTokenCountFixture as fixture,
  promptTokenCountStream as streamView
} from "./fixtures/prompt-token-count.js";

describe("prompt token count during generation", () => {
  test("many stream deltas never call the backend and leave no debounce pending", () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { calls += 1; return countedAnswer(1); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.stream = streamView("");
    for (let delta = 0; delta < 20; delta += 1) {
      state.stream.text += `chunk ${delta} `;
      lane.notify();
    }

    expect(calls).toBe(0);
    expect(clock.pendingCount()).toBe(0);
    lane.dispose();
  });

  test("generation ending fires exactly one debounced count for the whole stream", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { calls += 1; return countedAnswer(1); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.stream = streamView("");
    for (let delta = 0; delta < 10; delta += 1) {
      state.stream.text += `chunk ${delta} `;
      lane.notify();
    }
    state.stream = null;
    lane.notify();
    expect(calls).toBe(0);
    expect(clock.pendingCount()).toBe(1);

    lane.notify();
    lane.notify();
    expect(clock.pendingCount()).toBe(1);

    clock.fireDelay(250);
    await flush();
    expect(calls).toBe(1);
    lane.dispose();
  });

  test("a count showing before generation starts is retired and refreshed", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { calls += 1; return countedAnswer(calls); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireAll();
    await flush();
    expect(calls).toBe(1);
    expect(state.promptTokenCount).not.toBe(null);

    state.stream = streamView("");
    lane.notify();
    expect(state.promptTokenCount).toBe(null);

    // An empty or stopped generation can leave the settled prompt unchanged.
    state.stream = null;
    lane.notify();
    clock.fireDelay(250);
    await flush();
    expect(calls).toBe(2);
    expect(state.promptTokenCount?.count).toEqual(countedAnswer(2));
    lane.dispose();
  });

  test("generation start aborts a count already in flight", () => {
    const { state, clock, repaint } = fixture();
    const signals: AbortSignal[] = [];
    const api: PromptTokenCountApi = {
      countPromptTokens: async (_messages, signal) => {
        if (signal !== undefined) signals.push(signal);
        return await new Promise<PromptTokenCount>(() => { /* never settles */ });
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.mode = "REQUEST";
    lane.notify();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBeFalse();

    state.stream = streamView("");
    lane.notify();

    expect(signals[0]!.aborted).toBeTrue();
    expect(state.promptTokenCount).toBe(null);
    lane.dispose();
  });

  test("generation end uses a debounce while the request viewer stays open", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { calls += 1; return countedAnswer(1); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.mode = "REQUEST";
    lane.notify();
    await flush();
    expect(calls).toBe(1);

    state.stream = streamView("");
    lane.notify();
    state.stream.text += "more";
    lane.notify();
    state.systemPrompt = `${state.systemPrompt} plus generated text`;
    state.stream = null;
    lane.notify();

    expect(calls).toBe(1);
    expect(clock.pendingCount()).toBe(1);
    clock.fireDelay(250);
    await flush();
    expect(calls).toBe(2);
    lane.dispose();
  });
});

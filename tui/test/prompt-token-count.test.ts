import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import {
  startPromptTokenCountLane,
  type PromptTokenCountApi
} from "../src/prompt-token-count.js";
import type { PromptTokenCount } from "../../shared/tokenize-source.js";

type TimerHandle = ReturnType<typeof setTimeout>;

/** A scheduler a test drives by hand: `cancel` actually removes a pending
 *  task (unlike a real timer left to fire), so a debounce reset leaves
 *  exactly one task behind rather than an orphan the real clock would still
 *  run. `fireDelay` fires only tasks scheduled at an exact delay, so a test
 *  can settle the 250ms debounce without also tripping the 5s failure
 *  cooldown (or the reverse). */
function fakeClock() {
  let nextHandle = 1;
  const tasks = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    schedule(callback: () => void, delayMs: number): TimerHandle {
      const handle = nextHandle++;
      tasks.set(handle, { callback, delayMs });
      return handle as unknown as TimerHandle;
    },
    cancel(handle: TimerHandle) {
      tasks.delete(handle as unknown as number);
    },
    pendingCount() {
      return tasks.size;
    },
    fireAll() {
      const callbacks = [...tasks.values()].map((task) => task.callback);
      tasks.clear();
      for (const callback of callbacks) callback();
    },
    fireDelay(delayMs: number) {
      const due = [...tasks.entries()].filter(([, task]) => task.delayMs === delayMs);
      for (const [handle, task] of due) {
        tasks.delete(handle);
        task.callback();
      }
    }
  };
}

/** Enough microtask turns for a chain of `await`s inside the lane's own
 *  async work to settle before an assertion reads its effect. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

function countedAnswer(total: number): PromptTokenCount {
  return { kind: "counted", source: "bundled-openai", grade: "exact", total, perMessage: null };
}

function fixture() {
  const state = initialState(demoAppSource(), false);
  const clock = fakeClock();
  let repaints = 0;
  const repaint = () => { repaints += 1; };
  return { state, clock, repaint, repaints: () => repaints };
}

describe("prompt token count lane", () => {
  test("a burst of notifications collapses to one call after the debounce settles", async () => {
    const { state, clock, repaint } = fixture();
    const calls: number[] = [];
    const api: PromptTokenCountApi = {
      countPromptTokens: async (messages) => {
        calls.push(messages.length);
        return countedAnswer(123);
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    // Five keystrokes in a row: each restarts the same 250ms window rather
    // than queuing its own call.
    for (let key = 0; key < 5; key += 1) lane.notify();
    expect(clock.pendingCount()).toBe(1);
    expect(calls).toEqual([]);

    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1);
    expect(state.promptTokenCount?.count).toEqual(countedAnswer(123));
    lane.dispose();
  });

  test("opening the request viewer counts at once, without waiting on the debounce", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { calls += 1; return countedAnswer(50); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.mode = "REQUEST";
    lane.notify();

    // No debounce firing needed: the call already went out synchronously.
    expect(calls).toBe(1);
    expect(clock.pendingCount()).toBe(0);
    await flush();
    expect(state.promptTokenCount?.count).toEqual(countedAnswer(50));
    lane.dispose();
  });

  test("an answer that arrives after the prompt changed is discarded, not shown", async () => {
    const { state, clock, repaint, repaints } = fixture();
    let resolveCount!: (value: PromptTokenCount) => void;
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => {
        calls += 1;
        return await new Promise<PromptTokenCount>((resolve) => { resolveCount = resolve; });
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.mode = "REQUEST";
    lane.notify();
    expect(calls).toBe(1);

    // The prompt moves on before the answer lands.
    state.systemPrompt = `${state.systemPrompt} — a later edit`;
    resolveCount(countedAnswer(999));
    await flush();

    expect(state.promptTokenCount).toBe(null);
    expect(repaints()).toBe(0);
    lane.dispose();
  });

  test("a rejected probe clears to the estimate: no toast, no notice, nothing thrown", async () => {
    const { state, clock, repaint, repaints } = fixture();
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { throw new Error("tokenizer unreachable"); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.mode = "REQUEST";
    lane.notify();
    await flush();

    expect(state.promptTokenCount).toBe(null);
    expect(state.toast).toBe(null);
    expect(state.notices.entries).toEqual([]);
    expect(repaints()).toBe(0);
    lane.dispose();
  });

  test("an unchanged prompt is not asked about twice", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { calls += 1; return countedAnswer(77); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireAll();
    await flush();
    expect(calls).toBe(1);

    // Nothing about the projected prompt changed — a later debounce (a
    // scroll, a cursor move) must not repeat the call.
    lane.notify();
    clock.fireAll();
    await flush();
    expect(calls).toBe(1);
    lane.dispose();
  });

  test("a story change clears the stored count and stops trusting the old fingerprint", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { calls += 1; return countedAnswer(88); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireAll();
    await flush();
    expect(state.promptTokenCount).not.toBe(null);

    state.payload = { ...state.payload, id: "a-different-story" };
    lane.notify();

    expect(state.promptTokenCount).toBe(null);
    clock.fireAll();
    await flush();
    expect(calls).toBe(2);
    lane.dispose();
  });

  test("a failed count is retried after the cooldown, not before it", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    let succeed = false;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => {
        calls += 1;
        if (!succeed) throw new Error("tokenizer unreachable");
        return countedAnswer(66);
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.mode = "REQUEST";
    lane.notify();
    await flush();
    expect(calls).toBe(1);
    expect(state.promptTokenCount).toBe(null);

    // A repaint during the cooldown — the connection banner, a cursor move —
    // queues the ordinary debounce, but the cooldown still refuses the count.
    lane.notify();
    clock.fireDelay(250);
    await flush();
    expect(calls).toBe(1);

    // Once the cooldown elapses, the next quiet window retries for real.
    succeed = true;
    clock.fireDelay(5_000);
    lane.notify();
    clock.fireDelay(250);
    await flush();
    expect(calls).toBe(2);
    expect(state.promptTokenCount?.count).toEqual(countedAnswer(66));
    lane.dispose();
  });

  test("a resolved probe failure is retried too, not pinned like a settled answer", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    let failing = true;
    const api: PromptTokenCountApi = {
      // The backend answers a failed probe rather than rejecting, so this
      // reaches the lane looking exactly like a completed count.
      countPromptTokens: async () => {
        calls += 1;
        return failing
          ? { kind: "estimate", reason: "probe-failed" }
          : countedAnswer(55);
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.mode = "REQUEST";
    lane.notify();
    await flush();
    expect(calls).toBe(1);
    expect(state.promptTokenCount?.count).toEqual({ kind: "estimate", reason: "probe-failed" });

    failing = false;
    clock.fireDelay(5_000);
    lane.notify();
    clock.fireDelay(250);
    await flush();

    // Same prompt, same route: a transient server failure must not pin it to
    // the estimate until the writer happens to edit the text.
    expect(calls).toBe(2);
    expect(state.promptTokenCount?.count).toEqual(countedAnswer(55));
    lane.dispose();
  });

  test("a preset with no tokenizer is asked once, not after every typing pause", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => {
        calls += 1;
        return { kind: "estimate", reason: "no-source" };
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireAll();
    await flush();
    expect(calls).toBe(1);

    // Writing changes the prompt every time, so the fingerprint guard alone
    // would let each pause ship the whole prompt again. Ollama, LM Studio,
    // OpenRouter and custom all answer no-source, and no retry invents a
    // tokenizer for them.
    for (const suffix of [" one", " two", " three"]) {
      state.systemPrompt += suffix;
      lane.notify();
      clock.fireAll();
      await flush();
    }

    expect(calls).toBe(1);
    lane.dispose();
  });

  test("a route change asks the new preset even though it settled the old one", async () => {
    const { state, clock, repaint } = fixture();
    const asked: string[] = [];
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => {
        asked.push(state.generationRoute);
        return { kind: "estimate", reason: "no-source" };
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireAll();
    await flush();
    expect(asked).toHaveLength(1);

    state.generationRoute = "anthropic https://api.anthropic.com claude-opus-5";
    lane.notify();
    clock.fireAll();
    await flush();

    // The old preset having no tokenizer says nothing about the new one.
    expect(asked).toHaveLength(2);
    expect(asked[1]).toBe("anthropic https://api.anthropic.com claude-opus-5");
    lane.dispose();
  });

  test("a route change retires the count and asks again for the same prose", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { calls += 1; return countedAnswer(44); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireAll();
    await flush();
    expect(calls).toBe(1);
    expect(state.promptTokenCount).not.toBe(null);

    // Settings reached the runtime state. The prose did not move, but the
    // connection that counted it did.
    state.generationRoute = "openai-compatible http://localhost:11434/v1 llama3";
    lane.notify();

    expect(state.promptTokenCount).toBe(null);
    clock.fireAll();
    await flush();
    expect(calls).toBe(2);
    lane.dispose();
  });

  test("a model-server count is retired at its age bound, then counted again", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => {
        calls += 1;
        return {
          kind: "counted", source: "koboldcpp-tokencount", grade: "near-exact",
          total: 100 + calls, perMessage: null
        };
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireDelay(250);
    await flush();
    expect(calls).toBe(1);
    expect(state.promptTokenCount?.count.kind).toBe("counted");

    // The same local server can be running a different model by now, and an
    // idle session repaints rarely — so the bound has to fire on its own.
    clock.fireDelay(30_000);
    expect(state.promptTokenCount).toBe(null);

    clock.fireDelay(250);
    await flush();
    expect(calls).toBe(2);
    expect(state.promptTokenCount?.count).toEqual({
      kind: "counted", source: "koboldcpp-tokencount", grade: "near-exact",
      total: 102, perMessage: null
    });
    lane.dispose();
  });

  test("an aged count is not still shown when its refresh fails", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => {
        calls += 1;
        if (calls > 1) throw new Error("the model server went away");
        return {
          kind: "counted", source: "llama-cpp-tokenize", grade: "near-exact",
          total: 900, perMessage: null
        };
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireDelay(250);
    await flush();
    expect(state.promptTokenCount?.count.kind).toBe("counted");

    clock.fireDelay(30_000);
    clock.fireDelay(250);
    await flush();

    // The refresh failed, so there is nothing to vouch for. A number 1667 has
    // already declared too old must not stay on screen wearing its mark.
    expect(calls).toBe(2);
    expect(state.promptTokenCount).toBe(null);
    lane.dispose();
  });

  test("a bundled count is not retired by the model-server age bound", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => { calls += 1; return countedAnswer(64); }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireDelay(250);
    await flush();
    expect(calls).toBe(1);

    // The bundled tokenizer is a pure function of the model and the text, so
    // nothing about waiting can make its answer wrong.
    clock.fireDelay(30_000);
    expect(state.promptTokenCount?.count).toEqual(countedAnswer(64));
    expect(calls).toBe(1);
    lane.dispose();
  });

  test("opening the request viewer asks again rather than trusting an old answer", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => {
        calls += 1;
        return {
          kind: "counted", source: "llama-cpp-tokenize", grade: "near-exact",
          total: 500, perMessage: null
        };
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    lane.notify();
    clock.fireAll();
    await flush();
    expect(calls).toBe(1);

    // The viewer is on demand and can afford a full count, so it takes one
    // instead of showing whatever the meter last happened to hold.
    state.mode = "REQUEST";
    lane.notify();
    await flush();

    expect(calls).toBe(2);
    // And it never blinked back to an estimate on the way.
    expect(state.promptTokenCount?.count.kind).toBe("counted");
    lane.dispose();
  });

  test("a new story is counted at once, not held behind the old one's cooldown", async () => {
    const { state, clock, repaint } = fixture();
    let calls = 0;
    let failing = true;
    const api: PromptTokenCountApi = {
      countPromptTokens: async () => {
        calls += 1;
        if (failing) throw new Error("tokenizer unreachable");
        return countedAnswer(31);
      }
    };
    const lane = startPromptTokenCountLane({
      state, api, repaint, schedule: clock.schedule, cancel: clock.cancel
    });

    state.mode = "REQUEST";
    lane.notify();
    await flush();
    expect(calls).toBe(1);

    // A different story is a different prompt. It does not inherit the backoff
    // that the previous one's failure armed.
    failing = false;
    state.mode = "NAV";
    state.payload = { ...state.payload, id: "a-different-story" };
    lane.notify();
    clock.fireDelay(250);
    await flush();

    expect(calls).toBe(2);
    expect(state.promptTokenCount?.count).toEqual(countedAnswer(31));
    lane.dispose();
  });

  test("dispose aborts an in-flight call and leaves no timer pending", async () => {
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

    lane.dispose();
    expect(signals[0]!.aborted).toBeTrue();
    expect(clock.pendingCount()).toBe(0);
  });
});

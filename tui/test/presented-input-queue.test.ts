import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime, withActionAdmission } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import {
  createPresentedInputQueue,
  observeInputAdmission
} from "../src/presented-input-queue.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function key(name: string, sequence = name, ctrl = false): KeyEvent {
  return { name, sequence, shift: false, ctrl, meta: false } as KeyEvent;
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe("presented input queue", () => {
  test("drains in order only while the latest frame is presented", () => {
    let ready = false;
    let flushes = 0;
    const handled: string[] = [];
    const queue = createPresentedInputQueue({
      flush() { flushes += 1; },
      ready: () => ready
    });

    queue.enqueue(() => {
      handled.push("open-editor");
      ready = false;
    });
    queue.enqueue(() => { handled.push("copy"); });
    expect(handled).toEqual([]);
    expect(queue.pending).toBe(2);

    ready = true;
    queue.presented();
    expect(handled).toEqual(["open-editor"]);
    expect(queue.pending).toBe(1);

    ready = true;
    queue.presented();
    expect(handled).toEqual(["open-editor", "copy"]);
    expect(queue.pending).toBe(0);
    expect(flushes).toBe(4);
  });

  test("orders Ctrl+C behind typeahead but keeps failure and idle quit live", () => {
    const queue = createPresentedInputQueue({ flush() {}, ready: () => false });

    expect(queue.shouldQuitImmediately("NAV", false)).toBeTrue();
    expect(queue.shouldQuitImmediately("EDITOR", false)).toBeFalse();
    queue.enqueue(() => undefined);
    expect(queue.shouldQuitImmediately("NAV", false)).toBeFalse();
    expect(queue.shouldQuitImmediately("EDITOR", false)).toBeFalse();
    expect(queue.shouldQuitImmediately("EDITOR", true)).toBeTrue();
  });

  test("presentation failure drops unsafe reducers and runs emergency escapes in order", () => {
    const handled: string[] = [];
    const queue = createPresentedInputQueue({ flush() {}, ready: () => false });
    queue.enqueue(() => { handled.push("stale reducer"); });
    queue.enqueue(() => { handled.push("queued control"); }, () => { handled.push("escape one"); });
    queue.enqueue(() => undefined, () => { handled.push("escape two"); });

    queue.presentationFailed();

    expect(handled).toEqual(["escape one", "escape two"]);
    expect(queue.pending).toBe(0);
  });

  test("rejects future input immediately after presentation recovery is exhausted", () => {
    let exhausted = true;
    let flushes = 0;
    let handled = 0;
    let dropped = 0;
    const queue = createPresentedInputQueue({
      flush() { flushes += 1; },
      ready: () => false,
      recoveryExhausted: () => exhausted
    });

    queue.enqueue(() => { handled += 1; }, () => { dropped += 1; });
    expect({ handled, dropped, flushes, pending: queue.pending }).toEqual({
      handled: 0, dropped: 1, flushes: 0, pending: 0
    });

    exhausted = false;
    queue.enqueue(() => { handled += 1; }, () => { dropped += 1; });
    expect({ handled, dropped, flushes, pending: queue.pending }).toEqual({
      handled: 0, dropped: 1, flushes: 1, pending: 1
    });
  });

  test("holds real async key admission through editor entry before Ctrl+C", async () => {
    const source = demoAppSource(false);
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    let ready = true;
    let quitRequests = 0;
    const repaint = () => { ready = false; };
    const backend = new ActionRuntime(state, repaint);
    const queue = createPresentedInputQueue({ flush() {}, ready: () => ready });
    const enqueueKey = (event: KeyEvent) => {
      queue.enqueue(() => observeInputAdmission((admit) => handleKey(
        event,
        state,
        source,
        cache,
        () => { repaint(); admit(); },
        () => { admit(); return Promise.resolve(); },
        () => { quitRequests += 1; },
        null,
        () => undefined,
        () => undefined,
        withActionAdmission(backend, admit)
      ), (work) => backend.observe(work)));
    };

    enqueueKey(key("e"));
    expect(queue.shouldQuitImmediately(state.mode, false)).toBeFalse();
    enqueueKey(key("c", "\u0003", true));
    await drainMicrotasks();

    expect(state.mode).toBe("EDITOR");
    expect(queue.pending).toBe(1);
    ready = true;
    queue.presented();
    await drainMicrotasks();

    expect(state.mode).toBe("EDITOR");
    expect(quitRequests).toBe(0);
    expect(queue.pending).toBe(0);
    backend.dispose();
  });
});

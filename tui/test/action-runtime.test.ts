import { describe, expect, test } from "bun:test";
import {
  ActionRuntime,
  beginInteraction,
  type ActionTask
} from "../src/action-runtime.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("backend action ownership", () => {
  test("local interactions run while backend work owns its slot", async () => {
    const state = initialState(demoAppSource(), false);
    const gate = deferred<void>();
    let task!: ActionTask;
    const runtime = new ActionRuntime(state, () => undefined);
    const pending = runtime.run("switching take", async (owned) => {
      task = owned;
      await gate.promise;
    });

    expect(state.backendTask).toMatchObject({ kind: "action", label: "switching take", storyId: state.payload.id });
    expect(task.storyCurrent()).toBeTrue();
    expect(task.interactionCurrent()).toBeTrue();

    beginInteraction(state);
    state.focusIndex = 0;
    expect(state.focusIndex).toBe(0);
    expect(task.storyCurrent()).toBeTrue();
    expect(task.interactionCurrent()).toBeFalse();

    gate.resolve();
    expect(await pending).toBeTrue();
    expect(state.backendTask).toBe(null);
  });

  test("conflicting backend work rejects immediately instead of queuing", async () => {
    const state = initialState(demoAppSource(), false);
    const gate = deferred<void>();
    let repaints = 0;
    const runtime = new ActionRuntime(state, () => { repaints += 1; });
    const first = runtime.run("saving story", async () => gate.promise);
    expect(repaints).toBe(1);
    let secondStarted = false;

    const secondRuntime = new ActionRuntime(state, () => undefined);
    const second = secondRuntime.run("loading story", async () => { secondStarted = true; });

    expect(await second).toBeFalse();
    expect(secondStarted).toBeFalse();
    expect(state.toast).toBe("busy · saving story still running");
    gate.resolve();
    expect(await first).toBeTrue();
    expect(state.toast).toBe(null);
  });

  test("dispose invalidates the outstanding adoption token", async () => {
    const state = initialState(demoAppSource(), false);
    const gate = deferred<void>();
    const runtime = new ActionRuntime(state, () => undefined);
    let task!: ActionTask;
    const pending = runtime.run("loading story", async (owned) => {
      task = owned;
      await gate.promise;
    });
    const idle = runtime.whenIdle();

    runtime.dispose();
    expect(await idle).toBeFalse();
    expect(task.owns()).toBeFalse();
    expect(task.storyCurrent()).toBeFalse();
    expect(state.backendTask).toBe(null);

    gate.resolve();
    await pending;
  });

  test("rejected work releases ownership for the next task", async () => {
    const state = initialState(demoAppSource(), false);
    const runtime = new ActionRuntime(state, () => undefined);

    const message = await runtime.run("failing mutation", async () => {
      throw new Error("backend exploded");
    }).then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(message).toBe("backend exploded");
    expect(state.backendTask).toBe(null);

    let admitted = false;
    expect(await runtime.run("next mutation", async () => { admitted = true; })).toBeTrue();
    expect(admitted).toBeTrue();
  });
});

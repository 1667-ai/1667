import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState, requestQuitForState } from "../src/app.js";
import { textHash } from "../src/api.js";
import { demoAppSource } from "../src/demo.js";
import type { FactConsistencyInput } from "../src/fact-consistency-api.js";
import { factsOpeningPartId } from "../src/facts-command-context.js";
import { openMap } from "../src/map-actions.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { setComposerText } from "../src/composer-model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { adoptSameStoryPayload, adoptStoryState } from "../src/story-adoption.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

const planToken = "0".repeat(64);

function key(name: string, sequence = name): KeyEvent {
  return { name, sequence, shift: false, ctrl: false, meta: false } as KeyEvent;
}

function ctrlP(): KeyEvent {
  return { ...key("p", "\u0010"), ctrl: true } as KeyEvent;
}

async function typeQuery(
  press: (event: KeyEvent) => Promise<void>,
  query: string
): Promise<void> {
  for (const character of query) await press(key(character));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("Fact consistency runs through the palette, confirmation, result panel, and focus jump", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const planned: Array<{ scope: string; focusedPartId: string }> = [];
  const checked: Array<{ scope: string; focusedPartId: string }> = [];
  const plan = source.api.planFactConsistency!;
  const check = source.api.checkFactConsistency!;
  source.api.planFactConsistency = async (input) => {
    planned.push(input);
    const result = await plan(input);
    // The backend batches Fact States per part. This demo chapter has three
    // eligible parts, so its exact plan has three model requests.
    return { ...result, requestCount: 3 };
  };
  source.api.checkFactConsistency = async (input) => {
    checked.push(input);
    return check(input);
  };
  const press = (event: KeyEvent) => handleKey(
    event,
    state,
    source,
    cache,
    () => undefined,
    async () => undefined,
    () => undefined,
    null,
    undefined,
    undefined,
    backend
  );

  await press(ctrlP());
  expect(state.commands?.selectedId).toBe("check-chapter-against-facts");
  await press(key("return"));
  expect(planned).toHaveLength(1);
  expect(checked).toHaveLength(0);
  expect(state.mode).toBe("FACT-CONSISTENCY");
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.factConsistency?.surface.preflight.eligiblePartCount).toBeGreaterThan(0);
  expect(state.factConsistency?.surface.preflight.requestCount).toBe(3);

  await press(key("escape"));
  expect(state.mode).toBe("NAV");
  expect(state.factConsistency).toBeNull();

  await press(ctrlP());
  await press(key("return"));
  await press(key("return"));
  expect(checked).toHaveLength(1);
  expect(checked[0]?.scope).toBe("chapter");
  expect(state.mode).toBe("FACT-CONSISTENCY");
  const result = state.factConsistency?.surface;
  expect(result?.phase).toBe("results");
  if (result?.phase !== "results") throw new Error("Fact check did not settle");
  expect(result.run.findings.length).toBeGreaterThan(0);
  expect(state.payload.hasFactConsistencyRun).toBeTrue();

  const frame = frameText(renderStoryScreen(state, {
    width: 120,
    height: 30,
    wrapCache: cache
  }).lines);
  expect(frame).toContain("fact consistency · chapter");
  expect(frame).toContain("Fact Name:");
  expect(frame).toContain("exact quote:");
  expect(frame).toContain("contradiction:");

  const finding = result.run.findings[0]!;
  await press(key("f"));
  expect(state.mode).toBe("FACTS");
  expect(state.facts?.cursor).toBe(state.payload.facts.findIndex(({ id }) => id === finding.factId));
  await press(key("escape"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  await press(key("escape"));
  expect(state.mode).toBe("NAV");

  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  expect(state.commands?.selectedId).toBe("show-fact-findings");
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  expect(checked).toHaveLength(1);

  await press(key("return"));
  expect(state.mode).toBe("NAV");
  expect(state.factConsistency?.surface.phase).toBe("results");
  expect(state.focusIndex).toBe(rowIndexForNode(
    createStoryViewModel(state.payload),
    finding.partId
  ));
});

test("keeps an empty preflight confirmation and reports nothing to check", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  source.api.planFactConsistency = async () => ({
    partCount: 0,
    requestCount: 0,
    planToken
  });
  let checks = 0;
  source.api.checkFactConsistency = async (input) => {
    checks += 1;
    throw new Error(`unexpected check for ${input.scope}`);
  };
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.factConsistency?.surface.preflight.eligiblePartCount).toBe(0);
  await press(key("return"));
  expect(checks).toBe(0);
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.toast).toBe("nothing to check");
});

test("restores confirmation after a provider error", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const check = source.api.checkFactConsistency!;
  let attempts = 0;
  source.api.checkFactConsistency = async (input) => {
    attempts += 1;
    if (attempts === 1) throw new Error("provider unavailable");
    return check(input);
  };
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.toast).toBe("Fact consistency failed · provider unavailable");
  expect(state.factConsistency?.input.planToken).toBeUndefined();
  expect(state.factConsistency?.surface.preflight.requestCount).toBeUndefined();
  expect(state.factConsistency?.surface.preflight.requestCountExact).toBeFalse();
  const failedFrame = frameText(renderStoryScreen(state, {
    width: 100,
    height: 24,
    wrapCache: cache
  }).lines);
  expect(failedFrame).toContain("↵ plan again · esc cancel");

  await press(key("return"));
  expect(state.factConsistency?.surface.preflight.requestCountExact).toBeTrue();
  await press(key("return"));
  expect(attempts).toBe(2);
  expect(state.factConsistency?.surface.phase).toBe("results");
  backend.dispose();
});

test("requires an exact plan and retries planning before paid work", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const originalPlan = source.api.planFactConsistency!;
  const originalCheck = source.api.checkFactConsistency!;
  let plans = 0;
  let checks = 0;
  source.api.planFactConsistency = async (input) => {
    plans += 1;
    if (plans === 1) throw new Error("planner unavailable");
    return originalPlan(input);
  };
  source.api.checkFactConsistency = async (input) => {
    checks += 1;
    return originalCheck(input);
  };
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  expect(plans).toBe(1);
  expect(checks).toBe(0);
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.factConsistency?.surface.preflight.requestCountExact).toBeFalse();
  expect(state.factConsistency?.planFailure).toBe("planner unavailable");

  // Enter retries the failed plan and only leaves confirmation after an
  // exact request count is available.
  await press(key("return"));
  expect(plans).toBe(2);
  expect(checks).toBe(0);
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.factConsistency?.surface.preflight.requestCount).toBe(3);
  expect(state.factConsistency?.surface.preflight.requestCountExact).toBeTrue();

  await press(key("return"));
  expect(checks).toBe(1);
  expect(state.factConsistency?.surface.phase).toBe("results");
  backend.dispose();
});

test("does not reactivate a stale finding after the writer changes its prose", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  await press(key("return"));
  const surface = state.factConsistency?.surface;
  if (surface?.phase !== "results") throw new Error("Fact check did not settle");
  const finding = surface.run.findings[0];
  if (finding === undefined) throw new Error("Fact check returned no finding");
  const node = state.payload.path.find(({ id }) => id === finding.partId);
  if (node === undefined) throw new Error("Finding part is not on the current path");
  const beforePath = state.payload.path.map(({ id }) => id);

  const edited = await source.api.editNode(state.payload.id, node, {
    text: "The writer's corrected prose no longer contains the recorded quote."
  });
  adoptStoryState(state, edited, cache);
  expect(state.payload.path.map(({ id }) => id)).toEqual(beforePath);

  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  expect(state.payload.path.map(({ id }) => id)).toEqual(beforePath);
  expect(state.toast).toBe("Fact consistency finding is stale · story line unchanged");
  backend.dispose();
});

test("does not reactivate a stale finding after the writer switches to a sibling take", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  await press(key("return"));
  const surface = state.factConsistency?.surface;
  if (surface?.phase !== "results") throw new Error("Fact check did not settle");
  const finding = surface.run.findings[0];
  if (finding === undefined) throw new Error("Fact check returned no finding");
  const original = state.payload.path.find(({ id }) => id === finding.partId);
  if (original === undefined) throw new Error("Finding part is not in the payload");

  // Use the same edit-as-sibling request as the writer. The backend makes the
  // new take active, so the checked take becomes genuinely unselected.
  const switched = await source.api.createNode(state.payload.id, {
    sourceNodeId: original.id,
    expectedTextHash: await textHash(original.text),
    instruction: original.instruction,
    text: "A corrected sibling take that does not retain the old quote."
  });
  expect(switched.path.some(({ id }) => id === original.id)).toBeFalse();
  expect(switched.path.at(-1)?.id).not.toBe(original.id);
  adoptSameStoryPayload(state, switched, cache);
  const activePathAfterSwitch = state.payload.path.map(({ id }) => id);
  openMap(state);
  if (state.map === null) throw new Error("Map did not open");
  const mapCursorsBefore = {
    path: state.map.pathCursorId,
    tree: state.map.treeCursorId
  };

  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  expect(state.commands?.selectedId).toBe("show-fact-findings");
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  await press(key("return"));

  expect(state.mode).toBe("MAP");
  expect(state.payload.path.map(({ id }) => id)).toEqual(activePathAfterSwitch);
  expect(state.payload.path.some(({ id }) => id === original.id)).toBeFalse();
  expect(state.map?.pathCursorId).toBe(mapCursorsBefore.path);
  expect(state.map?.treeCursorId).toBe(mapCursorsBefore.tree);
  expect(state.toast).toBe("Fact consistency finding is stale · MAP cursor unchanged");
  backend.dispose();
});

test("settles a hidden run and reports its counts", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const check = source.api.checkFactConsistency!;
  const pending = deferred<Awaited<ReturnType<typeof check>>>();
  let checks = 0;
  source.api.checkFactConsistency = async () => {
    checks += 1;
    return pending.promise;
  };
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  const running = press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("running");
  expect(state.backendTask).toBeNull();
  expect(await backend.run("edit while Fact check runs", async () => {})).toBeTrue();
  await press(key("escape"));
  expect(state.mode).toBe("NAV");
  expect(state.factConsistency?.surface.phase).toBe("running");
  const hiddenFrame = frameText(renderStoryScreen(state, {
    width: 120,
    height: 30,
    wrapCache: cache
  }).lines);
  expect(hiddenFrame).toContain("working · Fact consistency");
  const retained = state.factConsistency;
  await press(ctrlP());
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  expect(state.factConsistency).toBe(retained);
  expect(checks).toBe(1);
  expect(state.toast ?? "").not.toContain("already running");
  await press(key("escape"));
  pending.resolve(await check({
    storyId: state.payload.id,
    focusedPartId: state.payload.path[0]!.id,
    scope: "chapter",
    planToken
  }));
  await running;
  expect(state.mode).toBe("NAV");
  expect(state.factConsistency?.surface.phase).toBe("results");
  expect(state.toast).toContain("findings");
  expect(state.toast).toContain("rejected");
  expect(state.toast).toContain("unchecked");
});

test("retires a late run after a story switch and reloads its persisted result", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const check = source.api.checkFactConsistency!;
  // Use a catalog story so the demo can switch away and then load it again.
  const firstPayload = await source.api.loadStory("demo-salt-road");
  adoptStoryState(state, firstPayload, cache);
  const storyId = state.payload.id;
  const focusedPartId = state.payload.path[0]!.id;
  // Seed the demo backend's persisted latest run. The delayed request below
  // returns the same old-story result after the UI has moved elsewhere.
  const persisted = await check({ storyId, focusedPartId, scope: "chapter", planToken });
  const pending = deferred<Awaited<ReturnType<typeof check>>>();
  source.api.checkFactConsistency = async () => pending.promise;
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  const running = press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("running");
  await press(key("escape"));

  const otherPayload = await source.api.loadStory("demo-winter-orchard");
  adoptStoryState(state, otherPayload, cache);
  expect(state.payload.id).toBe("demo-winter-orchard");
  expect(state.factConsistency).toBeNull();

  let quits = 0;
  requestQuitForState(state, () => undefined, () => { quits += 1; });
  expect(quits).toBe(0);
  expect(state.quitArmed).toBeTrue();
  expect(state.toast).toBe(
    "Fact consistency check running · press Ctrl+C again to abandon check and quit"
  );

  pending.resolve(persisted);
  await running;
  expect(state.payload.id).toBe("demo-winter-orchard");
  expect(state.factConsistency).toBeNull();

  const returnedPayload = await source.api.loadStory(storyId);
  adoptStoryState(state, returnedPayload, cache);
  expect(state.payload.hasFactConsistencyRun).toBeTrue();
  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  expect(state.commands?.selectedId).toBe("show-fact-findings");
  await press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("results");
  expect(state.toast ?? "").not.toContain("already running");
});

test("keeps the confirmation overlay when planning is refused as busy", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const pending = deferred<void>();
  const busy = backend.run("another request", async () => {
    await pending.promise;
  });
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.toast).toContain("busy");
  pending.resolve();
  await busy;
  await press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.factConsistency?.surface.preflight.requestCountExact).toBeTrue();
  await press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("results");
  backend.dispose();
});

test("rechecks a hidden summary before confirming a Fact check", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  let checks = 0;
  const check = source.api.checkFactConsistency!;
  source.api.checkFactConsistency = async (input) => {
    checks += 1;
    return check(input);
  };
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  state.summary = {
    start: 0,
    end: 1,
    totalParts: 1,
    text: "",
    controller: new AbortController()
  };
  await press(key("return"));

  expect(checks).toBe(0);
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.toast).toBe("summary running · esc cancels");
  backend.dispose();
});

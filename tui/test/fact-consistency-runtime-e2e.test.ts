import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
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
import type { RuntimeState } from "../src/state.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

const planToken = "0".repeat(64);

function currentFactSurface(state: RuntimeState) {
  return state.factConsistency?.surface;
}

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

test("does not let a pending plan enable a duplicate Fact check", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const plan = source.api.planFactConsistency!;
  const planned = deferred<Awaited<ReturnType<typeof plan>>>();
  source.api.planFactConsistency = async () => planned.promise;
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
  const opening = press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.factConsistency?.planPending).toBeTrue();

  await press(key("return"));
  expect(checks).toBe(0);
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.toast).toBe("Fact consistency plan is still running · wait for it to finish");

  planned.resolve({ partCount: 1, requestCount: 1, planToken });
  await opening;
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.factConsistency?.planPending).toBeFalse();

  await press(key("return"));
  expect(checks).toBe(1);
  expect(state.factConsistency?.surface.phase).toBe("results");
  backend.dispose();
});

test("keeps a newer same-story payload when a Fact response arrives late", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const version = (revision: number) => ({
    kind: "v6" as const,
    revision: String(revision).padStart(20, "0")
  });
  const oldVersion = version(10);
  const newVersion = version(11);
  state.payload = { ...state.payload, aggregateVersion: oldVersion };

  const originalCheck = source.api.checkFactConsistency!;
  const oldResult = await originalCheck({
    storyId: state.payload.id,
    focusedPartId: state.payload.path[0]!.id,
    scope: "chapter",
    planToken
  });
  const oldFindingPartId = oldResult.run.parts.find((part) => part.findings.length > 0)?.partId;
  if (oldFindingPartId === undefined) throw new Error("Fact check returned no finding part");
  const original = state.payload.path.find(({ id }) => id === oldFindingPartId);
  if (original === undefined) throw new Error("Finding part is not on the current path");

  const pending = deferred<Awaited<ReturnType<typeof originalCheck>>>();
  source.api.checkFactConsistency = async () => pending.promise;
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  const running = press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("running");

  const switched = await source.api.createNode(state.payload.id, {
    sourceNodeId: original.id,
    expectedTextHash: await textHash(original.text),
    instruction: original.instruction,
    text: "A newer sibling take that fixes the checked contradiction."
  });
  const switchedWithVersion = { ...switched, aggregateVersion: newVersion };
  adoptSameStoryPayload(state, switchedWithVersion, cache);
  const activePathAfterSwitch = state.payload.path.map(({ id }) => id);

  // The response carries the newer selected path, but the persisted run says
  // that the finding was checked on the take that was selected at start.
  pending.resolve({ ...oldResult, payload: switchedWithVersion });
  await running;
  expect(state.payload.aggregateVersion).toEqual(newVersion);
  expect(state.payload.path.map(({ id }) => id)).toEqual(activePathAfterSwitch);
  expect(state.payload.path.some(({ id }) => id === original.id)).toBeFalse();

  const settled = state.factConsistency?.surface;
  if (settled?.phase !== "results") throw new Error("Fact check did not settle");
  const freshFrame = frameText(renderStoryScreen(state, {
    width: 100,
    height: 24,
    wrapCache: cache
  }).lines);
  expect(freshFrame).toContain("[stale]");

  // Reopen the persisted run after dropping the retained surface. The stored
  // selected-at-run bit must keep the old take stale after reload, too.
  const persistedPayload = await source.api.loadStory(state.payload.id);
  adoptSameStoryPayload(state, persistedPayload, cache);
  state.factConsistency = null;
  state.mode = "NAV";
  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  const reopened = currentFactSurface(state);
  if (reopened?.phase !== "results") throw new Error("Persisted findings did not reopen");
  const reopenedFrame = frameText(renderStoryScreen(state, {
    width: 100,
    height: 24,
    wrapCache: cache
  }).lines);
  expect(reopenedFrame).toContain("[stale]");

  const findingIndex = reopened.run.findings.findIndex(({ partId }) => partId === oldFindingPartId);
  expect(findingIndex).toBeGreaterThanOrEqual(0);
  for (let index = 0; index < findingIndex; index += 1) await press(key("down"));
  await press(key("return"));
  expect(state.payload.path.map(({ id }) => id)).toEqual(activePathAfterSwitch);
  expect(state.toast).toBe("Fact consistency finding is stale · story line unchanged");
  backend.dispose();
});

test("keeps an existing Direct draft when Fact consistency is running", async () => {
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
  await press(key("escape"));
  await press(key("return"));
  expect(state.mode).toBe("COMPOSE");
  for (const character of "keep this draft") await press(key(character));

  await press(key("return"));
  expect(checks).toBe(1);
  expect(state.mode).toBe("COMPOSE");
  expect(state.composer.text).toBe("keep this draft");
  expect(state.toast).toBe("Fact consistency check running · wait for it to finish");

  pending.resolve(await check({
    storyId: state.payload.id,
    focusedPartId: state.payload.path[0]!.id,
    scope: "chapter",
    planToken
  }));
  await running;
  expect(state.factConsistency?.surface.phase).toBe("results");
});

test("keeps Aside readable while Fact consistency runs but blocks send and retake", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const check = source.api.checkFactConsistency!;
  const pending = deferred<Awaited<ReturnType<typeof check>>>();
  source.api.checkFactConsistency = async () => pending.promise;

  let asks = 0;
  let retakes = 0;
  source.api.getAsideV2 = async () => ({
    schemaVersion: 2,
    anchor: null,
    sessions: [{
      schemaVersion: 2,
      id: "session-1",
      anchor: null,
      title: "session",
      turns: [{ q: "Why?", a: "Because." }]
    }],
    anchors: [],
    unanchoredCount: 1
  });
  source.api.askAsideV2 = async () => {
    asks += 1;
    return null;
  };
  source.api.retakeAside = async () => {
    retakes += 1;
    return null;
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
  await press(key("return"));
  const running = press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("running");
  await press(key("escape"));
  expect(state.mode).toBe("NAV");

  await press(ctrlP());
  await typeQuery(press, "aside");
  expect(state.commands?.selectedId).toBe("aside");
  await press(key("return"));
  expect(state.mode).toBe("ASIDE");
  expect(state.aside?.modelVersion).toBe(2);
  const frame = frameText(renderStoryScreen(state, {
    width: 100,
    height: 30,
    wrapCache: cache
  }).lines);
  expect(frame).toContain("Because.");

  await press(key("r"));
  expect(retakes).toBe(0);
  expect(state.toast).toBe("Fact consistency check running · wait for it to finish");

  await press(key("tab"));
  if (state.aside === null) throw new Error("Aside did not open");
  setComposerText(state.aside.composer, "Can I ask while checking?");
  await press(key("return"));
  expect(asks).toBe(0);
  expect(state.aside.composer.text).toBe("Can I ask while checking?");
  expect(state.toast).toBe("Fact consistency check running · wait for it to finish");

  pending.resolve(await check({
    storyId: state.payload.id,
    focusedPartId: state.payload.path[0]!.id,
    scope: "chapter",
    planToken
  }));
  await running;
  expect(state.factConsistency?.surface.phase).toBe("results");
});

test("reopens persisted findings after its anchor take is deleted", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p13");
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined,
    () => undefined, null, undefined, undefined, backend
  );

  await press(ctrlP());
  await press(key("return"));
  await press(key("return"));
  const completed = state.factConsistency?.surface;
  if (completed?.phase !== "results") throw new Error("Fact check did not settle");
  const anchorId = state.factConsistency?.input.focusedPartId;
  if (anchorId === undefined) throw new Error("Fact check has no anchor");

  const deleted = await source.api.deleteNode(state.payload.id, anchorId, 1);
  expect(deleted.nodes.some(({ id }) => id === anchorId)).toBeFalse();
  const persistedPayload = await source.api.loadStory(state.payload.id);
  expect(persistedPayload.hasFactConsistencyRun).toBeTrue();

  const reopenedSource = { ...source, payload: persistedPayload };
  const reopenedState = initialState(reopenedSource, false);
  const reopenedBackend = new ActionRuntime(reopenedState, () => undefined);
  const reopen = (event: KeyEvent) => handleKey(
    event,
    reopenedState,
    reopenedSource,
    createWrapCache<ProseStyle>(),
    () => undefined,
    async () => undefined,
    () => undefined,
    null,
    undefined,
    undefined,
    reopenedBackend
  );

  await reopen(ctrlP());
  await typeQuery(reopen, "show fact findings");
  expect(reopenedState.commands?.selectedId).toBe("show-fact-findings");
  await reopen(key("return"));
  expect(reopenedState.mode).toBe("FACT-CONSISTENCY");
  const reopened = reopenedState.factConsistency?.surface;
  expect(reopened?.phase).toBe("results");
  if (reopened?.phase !== "results") throw new Error("Persisted findings did not reopen");
  expect(reopenedState.factConsistency?.input.focusedPartId).toBe(anchorId);
  expect(reopened.run.findings.length).toBeGreaterThan(0);
});

test("checks a take selected in MAP even when it is off the active story line", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p13");
  openMap(state);
  if (state.map === null) throw new Error("Map did not open");
  state.map.view = "path";
  state.map.pathCursorId = "p5-alt";
  expect(factsOpeningPartId(state)).toBe("p5-alt");

  const planned: FactConsistencyInput[] = [];
  source.api.planFactConsistency = async (input) => {
    planned.push(input);
    return { partCount: 1, requestCount: 1, planToken };
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

  expect(planned).toEqual([{
    storyId: state.payload.id,
    focusedPartId: "p5-alt",
    scope: "chapter"
  }]);
  expect(state.mode).toBe("FACT-CONSISTENCY");
  expect(state.factConsistency?.surface.phase).toBe("confirm");
  expect(state.factConsistency?.surface.preflight.eligiblePartCount).toBe(1);
  await press(key("escape"));
  expect(state.mode).toBe("MAP");
  expect(state.map?.pathCursorId).toBe("p5-alt");
});

test("returns to MAP and lands both cursors on an off-line finding", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p13");
  openMap(state);
  if (state.map === null) throw new Error("Map did not open");
  state.map.view = "path";
  state.map.pathCursorId = "p5-alt";
  state.map.treeCursorId = "p13";
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
  await press(key("return"));
  const surface = state.factConsistency?.surface;
  if (surface?.phase !== "results") throw new Error("Fact check did not settle");
  expect(surface.run.findings.length).toBeGreaterThan(0);
  for (let index = 0; index < 4; index += 1) await press(key("down"));
  const frame = frameText(renderStoryScreen(state, {
    width: 100,
    height: 24,
    wrapCache: cache
  }).lines);
  expect(frame).toContain("[off line]");
  expect(frame).toContain("↵ view in MAP");

  await press(key("return"));
  expect(state.mode).toBe("MAP");
  expect(state.map?.pathCursorId).toBe("p5-alt");
  expect(state.map?.treeCursorId).toBe("p5-alt");
  expect(state.toast).toBe(
    "Fact consistency finding is off the active story line · MAP cursor moved"
  );

  await press(key("escape"));
  expect(state.mode).toBe("NAV");
  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  await press(key("return"));
  await press(key("return"));
  expect(state.mode).toBe("MAP");
  expect(state.map?.pathCursorId).toBe("p5-alt");
  expect(state.map?.treeCursorId).toBe("p5-alt");
  expect(state.toast).toBe(
    "Fact consistency finding is off the active story line · opened in MAP"
  );
  backend.dispose();
});

test("retains a hidden failure for a visible retry", async () => {
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
  await press(key("return"));
  const running = press(key("return"));
  await press(key("escape"));
  await running;
  expect(state.mode).toBe("NAV");
  const failedSurface = state.factConsistency?.surface;
  if (failedSurface?.phase !== "confirm") throw new Error("Fact check failure was not retained");
  expect(failedSurface.failure).toBe("provider unavailable");
  expect(state.toast).toBe("Fact consistency failed · provider unavailable");

  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  expect(state.commands?.selectedId).toBe("show-fact-findings");
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  const frame = frameText(renderStoryScreen(state, {
    width: 100,
    height: 24,
    wrapCache: cache
  }).lines);
  expect(frame).toContain("Fact consistency failed");
  await press(key("return"));
  expect(state.factConsistency?.surface.preflight.requestCountExact).toBeTrue();
  await press(key("return"));
  expect(attempts).toBe(2);
  expect(state.factConsistency?.surface.phase).toBe("results");
});

import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  parseFactConsistencyRun,
  serializeFactConsistencyRun
} from "../../shared/fact-consistency-types.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState, type AppSource } from "../src/app.js";
import { confirmingFactConsistency } from "../src/fact-consistency-actions.js";
import {
  factConsistencyFindingStatus
} from "../src/fact-consistency-check.js";
import { demoAppSource } from "../src/demo.js";
import { libraryAction } from "../src/library-actions.js";
import { openMap } from "../src/map-actions.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { adoptStoryState } from "../src/story-adoption.js";
import type { RuntimeState } from "../src/state.js";
import { createWrapCache, type ProseStyle, type WrapCache } from "../src/wrap.js";

const planToken = "0".repeat(64);

function key(name: string, sequence = name): KeyEvent {
  return { name, sequence, shift: false, ctrl: false, meta: false } as KeyEvent;
}

function ctrlP(): KeyEvent {
  return { ...key("p", "\u0010"), ctrl: true } as KeyEvent;
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

async function typeQuery(
  press: (event: KeyEvent) => Promise<void>,
  query: string
): Promise<void> {
  for (const character of query) await press(key(character));
}

function pressFor(
  state: RuntimeState,
  source: AppSource,
  cache: WrapCache<ProseStyle>,
  backend: ActionRuntime
): (event: KeyEvent) => Promise<void> {
  return (event) => handleKey(
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
}

test("reopened off-line findings retain provenance and open MAP without activation", async () => {
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
  const press = pressFor(state, source, cache, backend);

  await press(ctrlP());
  await press(key("return"));
  await press(key("return"));
  const completed = state.factConsistency?.surface;
  if (completed?.phase !== "results") throw new Error("Fact check did not settle");
  const finding = completed.run.findings.find(({ partId }) => partId === "p5-alt");
  if (finding === undefined) throw new Error("Expected an off-line finding");

  const persisted = await source.api.getFactConsistencyRun!(state.payload.id);
  if (persisted === null) throw new Error("Demo did not persist the Fact run");
  const persistedPart = persisted.parts.find(({ partId }) => partId === finding.partId);
  expect(persistedPart?.selectedAtRun).toBeFalse();
  const roundTripped = parseFactConsistencyRun(serializeFactConsistencyRun(persisted));
  expect(roundTripped.parts.find(({ partId }) => partId === finding.partId)?.selectedAtRun)
    .toBeFalse();

  const payload = await source.api.loadStory(state.payload.id);
  expect(payload.hasFactConsistencyRun).toBeTrue();
  const reopenedSource = { ...source, payload };
  const reopenedState = initialState(reopenedSource, false);
  const reopenedCache = createWrapCache<ProseStyle>();
  const reopenedBackend = new ActionRuntime(reopenedState, () => undefined);
  const reopen = pressFor(reopenedState, reopenedSource, reopenedCache, reopenedBackend);

  await reopen(ctrlP());
  await typeQuery(reopen, "show fact findings");
  await reopen(key("return"));
  const reopened = reopenedState.factConsistency?.surface;
  if (reopened?.phase !== "results") throw new Error("Persisted findings did not reopen");
  const reopenedIndex = reopened.run.findings.findIndex(({ partId }) => partId === finding.partId);
  expect(reopenedIndex).toBeGreaterThanOrEqual(0);
  expect(factConsistencyFindingStatus(reopenedState.payload, reopened.run.findings[reopenedIndex]!))
    .toBe("off-line");
  const frame = frameText(renderStoryScreen(reopenedState, {
    width: 100,
    height: 24,
    wrapCache: reopenedCache
  }).lines);
  expect(frame).toContain("[off line]");

  for (let index = 0; index < reopenedIndex; index += 1) await reopen(key("down"));
  await reopen(key("return"));
  expect(reopenedState.mode).toBe("MAP");
  expect(reopenedState.map?.pathCursorId).toBe(finding.partId);
  expect(reopenedState.map?.treeCursorId).toBe(finding.partId);
  expect(reopenedState.payload.path.some(({ id }) => id === finding.takeId)).toBeFalse();
  expect(reopenedState.toast).toBe(
    "Fact consistency finding is off the active story line · opened in MAP"
  );
  backend.dispose();
  reopenedBackend.dispose();
});

test("reopening after a provider failure keeps the retry surface", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const press = pressFor(state, source, cache, backend);

  await press(ctrlP());
  await press(key("return"));
  await press(key("return"));
  const settled = state.factConsistency?.surface;
  if (settled?.phase !== "results") throw new Error("Fact check did not settle");
  const retained = state.factConsistency;
  if (retained === null || retained === undefined) throw new Error("Missing retained run");
  retained.surface = confirmingFactConsistency(settled.preflight, "provider unavailable");
  state.mode = "NAV";

  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  const failed = state.factConsistency?.surface;
  if (failed?.phase !== "confirm") throw new Error("failed run was not retained");
  expect(failed.failure).toBe("provider unavailable");
  const frame = frameText(renderStoryScreen(state, {
    width: 100,
    height: 24,
    wrapCache: cache
  }).lines);
  expect(frame).toContain("Fact consistency failed");
  expect(frame).toContain("plan again");
  backend.dispose();
});

test("reattaches a hidden run when returning before it settles", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const initial = await source.api.loadStory("demo-salt-road");
  adoptStoryState(state, initial, cache);
  const storyId = state.payload.id;
  const focusedPartId = state.payload.path[0]!.id;
  const originalCheck = source.api.checkFactConsistency!;
  const persisted = await originalCheck({ storyId, focusedPartId, scope: "chapter", planToken });
  const pending = deferred<Awaited<ReturnType<typeof originalCheck>>>();
  source.api.checkFactConsistency = async () => pending.promise;
  const press = pressFor(state, source, cache, backend);

  await press(ctrlP());
  await press(key("return"));
  const running = press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("running");
  await press(key("escape"));

  const other = await source.api.loadStory("demo-winter-orchard");
  adoptStoryState(state, other, cache);
  expect(state.factConsistency).toBeNull();

  const returned = await source.api.loadStory(storyId);
  adoptStoryState(state, returned, cache);
  expect(state.mode).toBe("NAV");
  expect(state.factConsistency?.surface.phase).toBe("running");
  expect(state.factConsistency?.returnMode).toBe("NAV");
  const frame = frameText(renderStoryScreen(state, {
    width: 100,
    height: 24,
    wrapCache: cache
  }).lines);
  expect(frame).toContain("working · Fact consistency");

  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  expect(state.commands?.selectedId).toBe("show-fact-findings");
  await press(key("escape"));

  pending.resolve(persisted);
  await running;
  expect(state.payload.hasFactConsistencyRun).toBeTrue();
  expect(state.factConsistency?.surface.phase).toBe("results");
  const settled = state.factConsistency?.surface;
  if (settled?.phase !== "results") throw new Error("Fact check did not settle");
  expect(settled.run.findings.length).toBeGreaterThan(0);

  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  expect(state.factConsistency?.surface.phase).toBe("results");
  backend.dispose();
});

test("reattaches a failed run after returning from another story", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const initial = await source.api.loadStory("demo-salt-road");
  adoptStoryState(state, initial, cache);
  const storyId = state.payload.id;
  const focusedPartId = state.payload.path[0]!.id;
  const check = source.api.checkFactConsistency!;
  const persisted = await check({ storyId, focusedPartId, scope: "chapter", planToken });
  const pending = deferred<Awaited<ReturnType<typeof check>>>();
  source.api.checkFactConsistency = async () => pending.promise;
  const press = pressFor(state, source, cache, backend);

  await press(ctrlP());
  await press(key("return"));
  const running = press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("running");
  await press(key("escape"));

  const other = await source.api.loadStory("demo-winter-orchard");
  adoptStoryState(state, other, cache);
  expect(state.factConsistency).toBeNull();

  pending.reject(new Error("provider unavailable"));
  await running;

  const returned = await source.api.loadStory(storyId);
  adoptStoryState(state, returned, cache);
  expect(state.payload.hasFactConsistencyRun).toBeTrue();
  expect(state.mode).toBe("NAV");
  const failed = state.factConsistency?.surface;
  if (failed?.phase !== "confirm") throw new Error("failed run was not retained");
  expect(failed.failure).toBe("provider unavailable");
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
  expect(frame).toContain("plan again");
  expect(state.factConsistency?.surface.phase).not.toBe("results");
  expect(persisted.run.parts.length).toBeGreaterThan(0);

  // Escape cancels a visible parked failure. Switching away and back must not
  // resurrect it; the older persisted run can still be opened explicitly.
  await press(key("escape"));
  expect(state.mode).toBe("NAV");
  expect(state.factConsistency).toBeNull();
  adoptStoryState(state, await source.api.loadStory("demo-winter-orchard"), cache);
  adoptStoryState(state, await source.api.loadStory(storyId), cache);
  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  await press(key("return"));
  expect(state.mode).toBe("FACT-CONSISTENCY");
  const reopened = state.factConsistency?.surface;
  if (reopened?.phase !== "results") {
    throw new Error("canceled failure replaced the persisted Fact run");
  }
  expect(reopened.run.findings.length).toBe(
    persisted.run.parts.reduce((count, part) => count + part.findings.length, 0)
  );
  backend.dispose();
});

test("cancelling a retried failure does not resurrect it after another story", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const initial = await source.api.loadStory("demo-salt-road");
  adoptStoryState(state, initial, cache);
  const storyId = state.payload.id;
  const focusedPartId = state.payload.path[0]!.id;
  const check = source.api.checkFactConsistency!;
  const pending = deferred<Awaited<ReturnType<typeof check>>>();
  source.api.checkFactConsistency = async () => pending.promise;
  const press = pressFor(state, source, cache, backend);

  await press(ctrlP());
  await press(key("return"));
  const running = press(key("return"));
  await press(key("escape"));
  adoptStoryState(state, await source.api.loadStory("demo-winter-orchard"), cache);
  pending.reject(new Error("provider unavailable"));
  await running;
  adoptStoryState(state, await source.api.loadStory(storyId), cache);

  await press(ctrlP());
  await typeQuery(press, "show fact findings");
  await press(key("return"));
  const failed = state.factConsistency?.surface;
  if (failed?.phase !== "confirm") throw new Error("failed run was not retained");
  expect(failed.failure).toBe("provider unavailable");
  await press(key("return"));
  const retried = state.factConsistency?.surface;
  if (retried?.phase !== "confirm") throw new Error("retry did not restore confirmation");
  expect(retried.failure).toBeUndefined();
  expect(retried.preflight.requestCountExact).toBeTrue();
  await press(key("escape"));
  expect(state.factConsistency).toBeNull();

  adoptStoryState(state, await source.api.loadStory("demo-winter-orchard"), cache);
  adoptStoryState(state, await source.api.loadStory(storyId), cache);
  expect(state.factConsistency).toBeNull();
  expect(state.toast ?? "").not.toContain("Fact consistency failed");
  backend.dispose();
});

test("deleting a story drops its parked Fact failure", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const initial = await source.api.loadStory("demo-salt-road");
  adoptStoryState(state, initial, cache);
  const storyId = state.payload.id;
  const focusedPartId = state.payload.path[0]!.id;
  const check = source.api.checkFactConsistency!;
  const pending = deferred<Awaited<ReturnType<typeof check>>>();
  source.api.checkFactConsistency = async () => pending.promise;
  const press = pressFor(state, source, cache, backend);

  await press(ctrlP());
  await press(key("return"));
  const running = press(key("return"));
  await press(key("escape"));
  const survivorSummary = source.stories.find(({ id }) => id === "demo-winter-orchard")!;
  adoptStoryState(state, await source.api.loadStory(survivorSummary.id), cache);
  pending.reject(new Error("provider unavailable"));
  await running;
  expect(state.factConsistency).toBeNull();

  let deleted = false;
  const originSummary = source.stories.find(({ id }) => id === storyId)!;
  source.stories = [originSummary, survivorSummary];
  source.api.deleteStory = async (id) => {
    expect(id).toBe(storyId);
    deleted = true;
    return { ok: true };
  };
  source.api.listStories = async () => [survivorSummary];
  state.library = {
    stories: source.stories,
    cursor: 0,
    query: "",
    prompt: { kind: "delete", value: originSummary.title, targetId: storyId }
  };
  state.mode = "LIBRARY";
  await libraryAction({ action: "open-selected" }, state, source, {
    backend,
    cache,
    repaint: () => undefined,
    applyTheme: () => undefined,
    previewTheme: () => undefined,
    renderer: null
  });
  await backend.whenIdle();
  expect(deleted).toBeTrue();
  expect(state.factConsistencyFailuresByStory?.has(storyId)).toBeFalse();
  backend.dispose();
});

test("a deleted story does not retain a late Fact failure", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const initial = await source.api.loadStory("demo-salt-road");
  adoptStoryState(state, initial, cache);
  const storyId = state.payload.id;
  const focusedPartId = state.payload.path[0]!.id;
  const check = source.api.checkFactConsistency!;
  const pending = deferred<Awaited<ReturnType<typeof check>>>();
  source.api.checkFactConsistency = async () => pending.promise;
  const press = pressFor(state, source, cache, backend);

  await press(ctrlP());
  await press(key("return"));
  const running = press(key("return"));
  expect(state.factConsistency?.surface.phase).toBe("running");
  await press(key("escape"));

  const survivorSummary = source.stories.find(({ id }) => id === "demo-winter-orchard")!;
  const originSummary = source.stories.find(({ id }) => id === storyId)!;
  const listStarted = deferred<void>();
  const releaseList = deferred<void>();
  source.api.deleteStory = async (id) => {
    expect(id).toBe(storyId);
    return { ok: true };
  };
  source.api.listStories = async () => {
    listStarted.resolve();
    await releaseList.promise;
    return [survivorSummary];
  };
  state.library = {
    stories: [originSummary, survivorSummary],
    cursor: 0,
    query: "",
    prompt: { kind: "delete", value: originSummary.title, targetId: storyId }
  };
  state.mode = "LIBRARY";
  const deletion = libraryAction({ action: "open-selected" }, state, source, {
    backend,
    cache,
    repaint: () => undefined,
    applyTheme: () => undefined,
    previewTheme: () => undefined,
    renderer: null
  });

  await listStarted.promise;
  expect(state.factConsistency).toBeNull();
  pending.reject(new Error("provider unavailable"));
  releaseList.resolve();
  await deletion;
  await running;

  expect(state.payload.id).toBe(survivorSummary.id);
  expect(state.factConsistency).toBeNull();
  expect(state.factConsistencyFailuresByStory?.has(storyId)).toBeFalse();
  expect(state.factConsistencyRunsInFlight?.size).toBe(0);
  expect(state.toast).toBe(`deleted ${originSummary.title}`);
  backend.dispose();
});

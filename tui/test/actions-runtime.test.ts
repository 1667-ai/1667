import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { handleKey, initialState, type AppSource } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { moveComposerTo, createComposer } from "../src/composer-model.js";
import { capturePendingDirectDraft } from "../src/composer-ownership.js";
import { commandContext, commandMatches } from "../src/command-model.js";
import { createSelectionSafeMouseGate, mouseToAction } from "../src/mouse-actions.js";
import {
  composeAction,
  currentPartActions,
  generate,
  restoreStoppedGenerationDraft
} from "../src/story-actions.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import type { ContinueTarget } from "../src/api.js";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import { requestGenerationStop } from "../src/generation-action.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";

const key = (name: string, sequence = name): KeyEvent => ({ name, sequence, shift: false, ctrl: false, meta: false }) as KeyEvent;
const STREAM_STARTED_AT = "2026-07-22T00:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function harness() {
  const source: AppSource = demoAppSource();
  const state = initialState(source, false);
  const press = (name: string, sequence = name) => handleKey(
    key(name, sequence), state, source, createWrapCache(), () => {}, async () => {}, () => {},
    { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
  );
  return { source, state, press };
}

function focusNode(state: ReturnType<typeof harness>["state"], nodeId: string): number {
  const index = rowIndexForNode(createStoryViewModel(state.payload), nodeId);
  state.focusIndex = index;
  return index;
}

describe("demo action runtime and input", () => {
  test("map reroute closes after a repaint commits derived map state", async () => {
    const { source, state, press } = harness();
    await press("m");
    await press("up");
    const targetId = state.map?.pathCursorId;
    expect(targetId).not.toBe(null);

    const gate = deferred<void>();
    const switchLine = source.api.switchLine;
    source.api.switchLine = async (...args) => {
      await gate.promise;
      return await switchLine(...args);
    };
    let derivedCommits = 0;
    const repaint = () => {
      if (derivedCommits > 0 || state.backendTask?.label !== "rerouting story" || state.map === null) return;
      derivedCommits += 1;
      state.map = {
        ...state.map,
        rowIds: [...state.map.rowIds],
        openedColdFolds: new Set(state.map.openedColdFolds)
      };
    };
    const runtime = new ActionRuntime(state, repaint);
    const pending = handleKey(
      key("return", "\r"), state, source, createWrapCache(), repaint,
      async () => {}, () => {}, {
        updateChecks: INERT_UPDATE_CHECK_LIFECYCLE,
        renderer: null,
        applyTheme: () => {},
        previewTheme: () => {},
        backend: runtime
      }
    );

    await Promise.resolve();
    expect(derivedCommits).toBe(1);
    expect(state.mode).toBe("MAP");
    gate.resolve();
    await pending;

    expect(state.mode).toBe("NAV");
    expect(state.map).toBe(null);
    expect(state.focusIndex).toBe(rowIndexForNode(createStoryViewModel(state.payload), targetId!));
  });

  test("manual reconnect refreshes prompt, provider capability, model, and window", async () => {
    const { source, state, press } = harness();
    const settings = {
      ...source.settings,
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      systemPrompt: "Use the server's newly loaded voice.",
      contextWindow: 8_192
    };
    source.api.getSettings = async () => ({
      ...source.settingsView,
      effective: settings,
      effectiveProse: settings
    });
    source.connection = {
      api: source.api,
      state: () => ({ down: false, attempt: 0, nextRetryAt: null, error: null }),
      retryNow: async () => true,
      subscribe: () => () => undefined,
      dispose: () => undefined
    };
    state.connection = { down: true, attempt: 1, nextRetryAt: null, error: "offline" };

    await press("R", "R");

    expect(state.systemPrompt).toBe(settings.systemPrompt);
    expect(state.contextWindow).toBe(8_192);
    expect(state.model).toBe("claude-sonnet-4-6");
    expect(state.assistantPrefill).toBeFalse();
    expect(source.settings).toEqual(settings);
  });

  test("offline keyboard retry bypasses an armed prune without disarming it", async () => {
    const { source, state, press } = harness();
    let retries = 0;
    source.connection = {
      api: source.api,
      state: () => ({ down: false, attempt: 0, nextRetryAt: null, error: null }),
      retryNow: async () => { retries += 1; return true; },
      subscribe: () => () => undefined,
      dispose: () => undefined
    };
    state.connection = { down: true, attempt: 1, nextRetryAt: null, error: "offline" };
    await press("d");
    const plan = state.prune;
    expect(plan).not.toBe(null);

    await press("R", "R");

    expect(retries).toBe(1);
    expect(state.prune).toBe(plan);
    expect(state.connection.down).toBeFalse();
  });

  test("clicking a part focuses it; right-click opens its menu", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.hitRows = [{ target: { kind: "part", index: 3, rowId: "p3" }, left: 0, right: 80 }];
    const click = (button: number) => mouseToAction(
      { type: "down", button, x: 5, y: 0, modifiers: { shift: false, alt: false, ctrl: false } } as never, state);
    expect(click(0)).toEqual({ action: "focus-index", index: 3, rowId: "p3" });
    state.focusIndex = 3;
    expect(click(0)).toEqual({ action: "focus-index", index: 3, rowId: "p3" });
    // The menu carries the row it was opened on, so a part landing above it
    // cannot slide the menu onto a different one.
    expect(click(2)).toEqual({ action: "open-actions", index: 3, rowId: "p3" });
  });

  test("same-story adoption keeps an action menu anchored across chapter rows", async () => {
    const { state, press } = harness();
    const targetId = "p6";
    const rowIndex = focusNode(state, targetId);
    expect(rowIndex).toBeGreaterThan(state.payload.path.findIndex((node) => node.id === targetId));
    await press("x");

    const actions = state.actions;
    const payload = {
      ...state.payload,
      nodes: state.payload.nodes.filter((node) => node.chapterBreakId !== "chapter-break-1")
    };
    adoptSameStoryPayload(state, payload, createWrapCache<ProseStyle>());

    expect(state.actions).toBe(actions);
    const view = createStoryViewModel(state.payload);
    expect(rowIndexForNode(view, state.actions!.partId)).toBeGreaterThan(-1);
  });

  test("a click outside an open panel dismisses it", () => {
    const state = initialState(demoAppSource(), false);
    state.hitRows = [{ target: { kind: "scrim" }, left: 0, right: 80 }];
    expect(mouseToAction({ type: "down", button: 0, x: 2, y: 0, modifiers: { shift: false, alt: false, ctrl: false } } as never, state))
      .toEqual({ action: "cancel" });
  });

  test("clicks outside a panel's columns do nothing", () => {
    const state = initialState(demoAppSource(), false);
    state.hitRows = [{ target: { kind: "list", index: 2 }, left: 40, right: 100 }];
    expect(mouseToAction({ type: "down", button: 0, x: 5, y: 0, modifiers: { shift: false, alt: false, ctrl: false } } as never, state)).toBe(null);
  });

  test("map chrome is inert while its wheel moves map rows", () => {
    const state = initialState(demoAppSource(), false);
    state.mode = "MAP";
    state.hitRows = [{ target: { kind: "panel" }, left: 0, right: 80 }];
    expect(mouseToAction({ type: "down", button: 0, x: 5, y: 0,
      modifiers: { shift: false, alt: false, ctrl: false } } as never, state)).toBe(null);
    expect(mouseToAction({ type: "scroll", scroll: { direction: "down" },
      modifiers: { shift: false, alt: false, ctrl: false } } as never, state)).toEqual({ action: "focus-next" });
  });

  test("shifted arrows scroll one line while ctrl+d/u jump a screenful", async () => {
    const { state } = harness();
    const source: AppSource = demoAppSource();
    const send = (event: KeyEvent) => handleKey(
      event, state, source, createWrapCache(), () => {}, async () => {}, () => {},
      { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
    );
    const modified = (name: string, modifier: "shift" | "ctrl"): KeyEvent =>
      ({ name, sequence: "", shift: modifier === "shift", ctrl: modifier === "ctrl", meta: false }) as KeyEvent;
    state.mode = "NAV";
    state.lastViewportStart = 20;
    state.viewScroll = null;
    await send(modified("down", "shift"));
    expect(state).toMatchObject({ viewScroll: null, viewScrollDelta: 1 });
    await send(modified("up", "shift"));
    expect(state).toMatchObject({ viewScroll: null, viewScrollDelta: 0 });
    // The coarse scroll must stay coarse, or the fine one has no reason to exist.
    await send(modified("d", "ctrl"));
    expect(state.viewScrollDelta).toBeGreaterThan(1);
  });

  test("shift-drag is left to the terminal's own selection", () => {
    const state = initialState(demoAppSource(), false);
    state.hitRows = [{ target: { kind: "part", index: 2, rowId: "p2" }, left: 0, right: 80 }];
    expect(mouseToAction({ type: "down", button: 0, x: 5, y: 0, modifiers: { shift: true, alt: false, ctrl: false } } as never, state)).toBe(null);
  });

  test("prose focus waits for mouse-up and a drag preserves the visible take", () => {
    const gate = createSelectionSafeMouseGate();
    const focus = { action: "focus-index" as const, index: 12, rowId: "node-12" };
    const down = { type: "down", button: 0, x: 20, y: 8 } as never;
    const up = { type: "up", button: 0, x: 20, y: 8 } as never;
    expect(gate.resolve(down, focus)).toBe(null);
    // A repaint may occur between down/up; the same semantic row still clicks.
    expect(gate.resolve(up, focus)).toEqual(focus);

    expect(gate.resolve(down, focus)).toBe(null);
    const reordered = { action: "focus-index" as const, index: 15, rowId: "node-12" };
    expect(gate.resolve(up, reordered)).toEqual(reordered);

    expect(gate.resolve(down, focus)).toBe(null);
    expect(gate.resolve(
      { type: "drag", button: 0, x: 40, y: 9 } as never, null
    )).toBe(null);
    expect(gate.resolve(
      { type: "up", button: 0, x: 40, y: 9 } as never, null
    )).toBe(null);

    expect(gate.resolve(down, focus)).toBe(null);
    expect(gate.resolve(
      up, { action: "focus-index", index: 12, rowId: "replacement-12" }
    )).toBe(null);

    const prompt = { action: "toggle-prompt" as const, index: 12, rowId: "node-12" };
    expect(gate.resolve(down, prompt)).toBe(null);
    expect(gate.resolve(up, prompt)).toEqual(prompt);
    expect(gate.resolve(down, prompt)).toBe(null);
    expect(gate.resolve(
      { type: "drag", button: 0, x: 40, y: 9 } as never, null
    )).toBe(null);
    expect(gate.resolve(
      { type: "up", button: 0, x: 40, y: 9 } as never, null
    )).toBe(null);
  });

  test("ownership reset cancels a deferred prose click before new pixels arrive", () => {
    const gate = createSelectionSafeMouseGate();
    const down = { type: "down", button: 0, x: 20, y: 8 } as never;
    const up = { type: "up", button: 0, x: 20, y: 8 } as never;
    const oldFrame = { action: "focus-index" as const, index: 2, rowId: "shared-id" };
    const newFrame = { action: "focus-index" as const, index: 9, rowId: "shared-id" };

    expect(gate.resolve(down, oldFrame)).toBe(null);
    gate.reset();
    expect(gate.resolve(up, newFrame)).toBe(null);
  });

  test("generation claims its slot before its first await", async () => {
    const { state } = harness();
    focusNode(state, "p13");
    const source = demoAppSource();
    source.payload = state.payload;
    const runtime = new ActionRuntime(state, () => undefined);
    const pending = runtime.run("generating prose", (task) =>
      generate(state, source, createWrapCache(), () => undefined, "", null, null, task));
    // Synchronously mid-await: claimed before any stream is visible.
    expect(state.abort).not.toBe(null);
    expect(state.stream).toBe(null);
    requestGenerationStop(state, () => undefined);
    beginInteraction(state);
    state.focusIndex = 0;
    state.mode = "COMPOSE";
    state.composer = createComposer("newer draft");
    await pending;
    expect(state.stream).toBe(null);
    expect(state.abort).toBe(null);
    expect(state.focusIndex).toBe(0);
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("newer draft");
  });

  test("generation startup does not steal focus changed during its first await", async () => {
    const { state } = harness();
    focusNode(state, "p13");
    const source = demoAppSource();
    source.payload = state.payload;
    const entered = deferred<void>();
    const gate = deferred<null>();
    source.api.continueStory = async () => {
      entered.resolve();
      return gate.promise;
    };
    const beforeStream = Date.now();
    const runtime = new ActionRuntime(state, () => undefined);
    const pending = runtime.run("generating prose", (task) =>
      generate(state, source, createWrapCache(), () => undefined, "", null, null, task));

    expect(state.stream).toBe(null);
    beginInteraction(state);
    state.focusIndex = 0;
    state.mode = "COMPOSE";
    state.composer = createComposer("newer draft");
    await entered.promise;

    expect(state.stream).not.toBe(null);
    const streamStartedAt = Date.parse(state.stream!.startedAt);
    expect(streamStartedAt >= beforeStream).toBeTrue();
    expect(streamStartedAt <= Date.now()).toBeTrue();
    expect(state.focusIndex).toBe(0);
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("newer draft");
    expect(frameText(renderStoryScreen(state, { width: 80, height: 24 }).lines))
      .toContain("Maren lit the last lamp before the storm found Sorrow Cliff.");
    gate.resolve(null);
    await pending;
    expect(state.focusIndex).toBe(0);
  });

  test("append deltas retain the completed prefix cache for resumable reuse", async () => {
    const { source, state } = harness();
    const leaf = state.payload.path.at(-1)!;
    focusNode(state, leaf.id);
    const cache = createWrapCache<ProseStyle>();
    cache.wrap(leaf.id, 10, leaf.text, []);
    expect(cache.appendCandidate(leaf.id, 10, leaf.text.length)).not.toBe(null);
    const deltaSeen = deferred<void>();
    const finish = deferred<null>();
    source.api.continueStory = async (
      _storyId,
      _instruction,
      _genId,
      _target,
      onDelta
    ) => {
      onDelta(" continued");
      deltaSeen.resolve();
      return finish.promise;
    };
    const runtime = new ActionRuntime(state, () => undefined);
    const running = runtime.run("generating prose", (task) =>
      generate(state, source, cache, () => undefined, "", null, null, task));

    await deltaSeen.promise;
    expect(cache.epoch).toBe(0);
    expect(cache.appendCandidate(leaf.id, 10, leaf.text.length)).not.toBe(null);

    finish.resolve(null);
    await running;
  });

  test("compose deletes to the line end and start, not the other way round", async () => {
    // Routing tests cannot catch a flipped boundary flag: both directions
    // resolve to a real action and differ only in the boolean the reducer
    // passes on. Drive the reducer and read the text back.
    const context = () => ({
      cache: createWrapCache<ProseStyle>(), repaint: () => undefined, renderer: null,
      applyTheme: () => undefined, previewTheme: () => undefined,
      backend: new ActionRuntime(state, () => undefined)
    });
    const { source, state } = harness();
    state.mode = "COMPOSE";

    state.composer = createComposer("the lantern keeper");
    moveComposerTo(state.composer, 11);
    await composeAction({ action: "delete-line-end" }, state, source, context() as never);
    expect(state.composer.text).toBe("the lantern");

    state.composer = createComposer("the lantern keeper");
    moveComposerTo(state.composer, 11);
    await composeAction({ action: "delete-line-start" }, state, source, context() as never);
    expect(state.composer.text).toBe(" keeper");

    state.composer = createComposer("the lantern keeper");
    moveComposerTo(state.composer, 18);
    await composeAction({ action: "delete-word-left" }, state, source, context() as never);
    expect(state.composer.text).toBe("the lantern ");
  });

  test("a null generation outcome restores its submitted direction", async () => {
    const { source, state } = harness();
    const cache = createWrapCache<ProseStyle>();
    state.mode = "COMPOSE";
    state.composer = createComposer("keep this direction");
    source.api.continueStory = async () => null;

    await composeAction({ action: "send" }, state, source, {
      cache, repaint: () => undefined, renderer: null,
      applyTheme: () => undefined, previewTheme: () => undefined,
      backend: new ActionRuntime(state, () => undefined)
    });
    while (state.abort !== null) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.composer.text).toBe("keep this direction");
    expect(state.mode).toBe("COMPOSE");
    expect(state.pendingGenerationDraft).toMatchObject({
      text: "keep this direction", restored: true
    });
  });

  test("stopping before the first delta preserves a newer composer draft", async () => {
    const { source, state } = harness();
    const cache = createWrapCache<ProseStyle>();
    state.mode = "COMPOSE";
    state.composer = createComposer("submitted direction");
    let finish!: (payload: null) => void;
    source.api.continueStory = async () => await new Promise<null>((resolve) => { finish = resolve; });

    const pending = composeAction({ action: "send" }, state, source, {
      cache, repaint: () => undefined, renderer: null,
      applyTheme: () => undefined, previewTheme: () => undefined,
      backend: new ActionRuntime(state, () => undefined)
    });
    while (state.stream === null) await new Promise((resolve) => setTimeout(resolve, 0));
    const submitted = state.pendingGenerationDraft!;
    expect(state.stream.pendingDraft).toBe(submitted);
    state.composer = createComposer("new direction written during the request");

    restoreStoppedGenerationDraft(state, state.stream);

    expect(state.composer.text).toBe("new direction written during the request");
    expect(state.pendingGenerationDraft).toBe(null);

    finish(null);
    await pending;

    state.composer = createComposer();
    restoreStoppedGenerationDraft(state, {
      targetId: "pending-two", parentId: "p13", append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "", text: ""
    });
    expect(state.composer.text).toBe("");

    state.composer = createComposer();
    const restorable = capturePendingDirectDraft(state, "submitted direction");
    state.pendingGenerationDraft = restorable;
    restoreStoppedGenerationDraft(state, {
      targetId: "pending-three", parentId: "p13", append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: restorable.text, text: "", pendingDraft: restorable
    });
    expect(state.composer.text).toBe("submitted direction");
    expect(state.pendingGenerationDraft).toMatchObject({ restored: true });
  });

  test("an authoritative generation outcome clears its submitted direction", async () => {
    const { source, state } = harness();
    const cache = createWrapCache<ProseStyle>();
    state.mode = "COMPOSE";
    state.composer = createComposer("land this direction");
    source.api.continueStory = async () =>
      ({ payload: { ...state.payload, title: "authoritative result" }, droppedFacts: [] });

    await composeAction({ action: "send" }, state, source, {
      cache, repaint: () => undefined, renderer: null,
      applyTheme: () => undefined, previewTheme: () => undefined,
      backend: new ActionRuntime(state, () => undefined)
    });
    while (state.abort !== null) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.payload.title).toBe("authoritative result");
    expect(state.pendingGenerationDraft).toBe(null);
    expect(state.composer.text).toBe("");
  });

  test("Continue after a chapter break streams as the next chapter's child", async () => {
    const { source, state } = harness();
    const leaf = state.payload.path.at(-1)!;
    state.payload.chapterBreaks.push({
      id: "break-after-leaf", parentPartId: leaf.id, title: "Beyond the Storm",
      createdAt: "1667-07-19T16:09:00.000Z"
    });
    focusNode(state, leaf.id);
    state.viewScroll = 0;
    source.payload = state.payload;
    let target: ContinueTarget | null = null;
    let finish!: (payload: null) => void;
    source.api.continueStory = async (_storyId, _instruction, _genId, nextTarget, onDelta) => {
      target = nextTarget;
      onDelta("The next chapter begins.");
      return await new Promise<null>((resolve) => { finish = resolve; });
    };

    const runtime = new ActionRuntime(state, () => undefined);
    const running = runtime.run("generating prose", (task) =>
      generate(state, source, createWrapCache(), () => {}, "", null, null, task));
    while (target === null) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target).toEqual({ parentId: leaf.id });
    expect(state.stream).toMatchObject({ parentId: leaf.id, append: false });
    expect(state.viewScroll).toBe(null);
    const view = createStoryViewModel(state.payload, state.stream);
    const divider = view.rows.findIndex((row) => row.kind === "chapter-divider"
      && row.break.id === "break-after-leaf");
    const streamed = rowIndexForNode(view, state.stream!.targetId);
    expect(streamed).toBeGreaterThan(divider);
    finish(null);
    await running;
  });

  test("the abort-only window blocks take switches, undo and pruning", async () => {
    const { state, press } = harness();
    // ¶12 has five takes, and a chapter break is the only thing `u` can take
    // back, so each guard has something it would actually change if it were
    // missing.
    focusNode(state, "p12");
    await press("right");
    const switched = state.payload.path.map((node) => node.id);
    await press("C", "C");
    const breaks = state.payload.chapterBreaks.length;
    expect(state.undo.length).toBe(1);

    // Enter the window the fix is about: claimed, but no stream yet.
    state.abort = {
      kind: "generation",
      controller: new AbortController(),
      stopInteractionVersion: null
    };
    state.stream = null;

    await press("right");
    expect(state.payload.path.map((node) => node.id)).toEqual(switched);
    await press("u");
    expect(state.payload.chapterBreaks).toHaveLength(breaks);
    expect(state.undo.length).toBe(1);

    const nodesBefore = state.payload.nodes.length;
    await press("m");
    await press("d");
    await press("d");
    expect(state.payload.nodes.length).toBe(nodesBefore);
    state.abort = null;
  });

  test("copy stays available from the menu while a stream runs", async () => {
    const { state, press } = harness();
    focusNode(state, "p12");
    await press("x");
    state.stream = { targetId: "p13", parentId: "p12", append: true,
      startedAt: STREAM_STARTED_AT, instruction: "", text: "" };
    const copyRow = currentPartActions(state).findIndex((action) => action.id === "copy");
    state.actions!.cursor = copyRow;
    await press("return", "\r");
    expect(state.toast).toContain("¶ 12");
  });

  test("a visible stream blocks mutation prompts while leaving their targets intact", async () => {
    const { state, press } = harness();
    const before = state.payload.nodes.length;
    focusNode(state, "p12");
    state.stream = { targetId: "p13", parentId: "p12", append: true,
      startedAt: STREAM_STARTED_AT, instruction: "", text: "" };
    await press("d");
    expect(state.prune).toBe(null);
    expect(state.toast).toBe("stream running · esc stops it first");
    await press("t");
    expect(state.tag).toBe(null);
    expect(state.toast).toBe("stream running · esc stops it first");
    await press("r");
    expect(state.toast).toBe("stream running · esc stops it first");
    expect(state.payload.nodes.length).toBe(before);
  });

  test("command selection keeps its identity when a request settlement reorders Suggested", async () => {
    const { source, state, press } = harness();
    state.stream = { targetId: "p13", parentId: "p12", append: true,
      startedAt: STREAM_STARTED_AT, instruction: "", text: "" };
    state.abort = {
      kind: "generation",
      controller: new AbortController(),
      stopInteractionVersion: null
    };
    const active = commandMatches(
      "", state.demo, commandContext(state.payload, {
        connectionDown: state.connection.down, requestActive: true, canRewriteSelection: false
      })
    );
    const cursor = active.findIndex(({ command }) => command.id === "switch-story");
    expect(cursor).toBeGreaterThan(-1);
    state.mode = "COMMANDS";
    state.commands = {
      query: "", cursor, selectedId: "switch-story", view: "commands", returnMode: "NAV"
    };
    source.api.exportMarkdown = async () => { throw new Error("stale cursor executed export"); };

    state.stream = null;
    state.abort = null;
    await press("return", "\r");

    expect(state.mode).toBe("LIBRARY");
    expect(state.library).not.toBe(null);
  });

  test("a rename prompt cannot adopt over an active generation owner", async () => {
    const { source, state, press } = harness();
    const payload = state.payload;
    const stream = { targetId: "p13", parentId: "p12", append: true,
      startedAt: STREAM_STARTED_AT, instruction: "", text: "" };
    const abort = {
      kind: "generation" as const,
      controller: new AbortController(),
      stopInteractionVersion: null
    };
    state.stream = stream;
    state.abort = abort;
    state.mode = "LIBRARY";
    state.library = {
      stories: source.stories,
      cursor: 0,
      query: "",
      prompt: { kind: "rename", composer: createComposer("renamed while streaming"), targetId: payload.id }
    };
    let renamed = 0;
    source.api.renameStory = async () => { renamed += 1; return { ...payload, title: "wrong" }; };

    await press("return", "\r");

    expect(renamed).toBe(0);
    expect(state.payload).toBe(payload);
    expect(state.stream).toBe(stream);
    expect(state.abort).toBe(abort);
    expect(state.library?.prompt?.kind).toBe("rename");
    expect(state.toast).toBe("stream running · esc stops it first");
  });

  test("a take switch records nothing to undo and never advertises u", async () => {
    // `u` used to reverse a take switch, which the arrows already do, and a
    // stack that mixed the two told the reader that `u` reaches into prose. It
    // takes back stored changes only.
    const { state, press } = harness();
    focusNode(state, "p12");

    await press("right");

    expect(state.undo).toEqual([]);
    expect(state.toast).toContain("take");
    expect(state.toast).not.toContain("u undoes");

    await press("u");
    expect(state.toast).toBe("nothing to undo · u takes back an added or removed chapter break");
  });

test("a chapter rename records nothing to undo", async () => {
    // "chapter change" was too wide a word for what `u` holds: a rename and a
    // summary edit are chapter changes, and neither is undoable. Naming the
    // category rebuilt the ambiguity this key was narrowed to remove.
    const { state, source, press } = harness();
    focusNode(state, "p12");
    await press("C", "C");
    expect(state.undo).toHaveLength(1);

    const created = state.undo.at(-1)!;

    // Rename a different break, so the stack cannot pass by holding the entry
    // the rename itself would have added.
    const target = state.payload.chapterBreaks.find(({ id }) => id !== (created as { breakId: string }).breakId)!;
    state.mode = "CHAPTERS";
    state.chapters = {
      cursor: 0,
      rename: { breakId: target.id, composer: createComposer("Renamed") },
      deleteArmedId: null
    };
    await press("return");

    // The rename landed, and it left the stack exactly as it found it.
    expect((await source.api.loadStory(state.payload.id)).chapterBreaks
      .find((chapterBreak) => chapterBreak.id === target.id)?.title).toBe("Renamed");
    expect(state.undo).toEqual([created]);
});

  test("chapter rename moves a real caret before it inserts and deletes", async () => {
    const { state, press } = harness();
    await press("c");
    await press("up");
    await press("e");

    const rename = state.chapters?.rename;
    expect(rename).not.toBe(null);
    const original = rename!.composer.text;
    const cursorBefore = rename!.composer.cursor;
    await press("left");
    expect(rename!.composer.cursor).toBe(cursorBefore - 1);
    await press("X");
    expect(rename!.composer.text).toBe(
      `${original.slice(0, cursorBefore - 1)}X${original.slice(cursorBefore - 1)}`
    );
    await press("backspace");
    expect(rename!.composer.text).toBe(original);

    const frame = renderStoryScreen(state, { width: 80, height: 30 });
    expect(frame.lines.flat().some((part) =>
      part.composerStart === rename!.composer.cursor
        && part.background === "compose accent"
    )).toBeTrue();
  });

  test("chapter summarization names its stage and cancels through the API signal", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    let signal: AbortSignal | undefined;
    source.api.summarizeChapter = async (_storyId, _breakId, callerSignal) => {
      signal = callerSignal;
      await entered.promise;
      return state.payload;
    };

    await press("c");
    await press("up");
    const pending = press("s");
    await Promise.resolve();

    expect(state.chapterSummary).toMatchObject({ chapterNumber: 2, stage: "writing" });
    expect(signal?.aborted).toBeFalse();
    state.chapters = null;
    const frame = renderStoryScreen(state, { width: 120, height: 30 });
    expect(frameText(frame.lines)).toContain("ch 2");
    expect(frameText(frame.lines)).toContain("model progress unavailable");
    expect(frameText(frame.lines)).toContain("esc cancels");

    await press("escape", "\u001b");
    expect(signal?.aborted).toBeTrue();
    expect(state.chapterSummary?.stage).toBe("stopping");
    entered.resolve();
    await pending;

    expect(state.chapterSummary).toBe(null);
    expect(state.abort).toBe(null);
    expect(state.toast).toBe("Chapter Two summary stopped");
  });

  test("navigation stays available and does not hide chapter summary completion", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const summarize = source.api.summarizeChapter;
    source.api.summarizeChapter = async (...args) => {
      entered.resolve();
      await release.promise;
      return await summarize(...args);
    };

    await press("c");
    await press("up");
    const pending = press("s");
    await entered.promise;
    const interactionVersion = state.interactionVersion;
    const cursor = state.chapters!.cursor;

    await press("down");
    expect(state.interactionVersion).toBe(interactionVersion + 1);
    expect(state.chapters!.cursor).not.toBe(cursor);

    release.resolve();
    await pending;
    expect(state.toast).toContain("summarized");
    expect(state.toast).not.toContain("esc cancels");
  });

  test("escape closes an action menu without cancelling a chapter summary", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    source.api.summarizeChapter = async (_storyId, _breakId, callerSignal) => {
      signal = callerSignal;
      entered.resolve();
      await release.promise;
      return state.payload;
    };

    await press("c");
    await press("up");
    const pending = press("s");
    await entered.promise;
    state.mode = "NAV";
    state.chapters = null;
    await press("x");
    expect(state.actions).not.toBe(null);
    expect(frameText(renderStoryScreen(state, { width: 120, height: 30 }).lines))
      .not.toContain("esc cancels");

    await press("escape", "\u001b");
    expect(state.actions).toBe(null);
    expect(signal?.aborted).toBeFalse();
    expect(frameText(renderStoryScreen(state, { width: 120, height: 30 }).lines))
      .toContain("esc cancels");

    release.resolve();
    await pending;
  });

  test("escape closes a text menu without cancelling a chapter summary", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    source.api.summarizeChapter = async (_storyId, _breakId, callerSignal) => {
      signal = callerSignal;
      entered.resolve();
      await release.promise;
      return state.payload;
    };

    await press("c");
    await press("up");
    const pending = press("s");
    await entered.promise;
    state.mode = "NAV";
    state.chapters = null;
    state.textActions = {
      cursor: 0,
      owner: null,
      ownerSnapshot: null,
      nativeSelection: undefined,
      composerSelectionProjection: null,
      copyOnly: true
    };
    expect(frameText(renderStoryScreen(state, { width: 120, height: 30 }).lines))
      .not.toContain("esc cancels");

    await press("escape", "\u001b");
    expect(state.textActions).toBe(null);
    expect(signal?.aborted).toBeFalse();
    expect(frameText(renderStoryScreen(state, { width: 120, height: 30 }).lines))
      .toContain("esc cancels");

    release.resolve();
    await pending;
  });

  test("a chapter summary that commits before cancellation wins is adopted", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const summarize = source.api.summarizeChapter;
    source.api.summarizeChapter = async (...args) => {
      entered.resolve();
      await release.promise;
      return await summarize(...args);
    };

    await press("c");
    await press("up");
    const pending = press("s");
    await entered.promise;
    await press("escape", "\u001b");
    release.resolve();
    await pending;

    expect(createStoryViewModel(state.payload).chapters[1]?.summary).not.toBe(null);
    expect(state.toast).toBe("Chapter Two summary completed before stop");
  });

  test("C creates a focused-part chapter break and u removes it", async () => {
    const { state, press } = harness();
    focusNode(state, "p12");
    const before = state.payload.chapterBreaks.length;
    await press("C", "C");
    expect(state.payload.chapterBreaks).toHaveLength(before + 1);
    expect(state.payload.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === "p12")).toBeTrue();
    expect(state.undo.at(-1)).toMatchObject({ kind: "create-break" });
    await press("u");
    expect(state.payload.chapterBreaks).toHaveLength(before);
  });

  test("divider deletion is two-step and undo restores its summary", async () => {
    const { state, press } = harness();
    const view = createStoryViewModel(state.payload);
    state.focusIndex = view.rows.findIndex((row) => row.kind === "chapter-divider" && row.break.id === "chapter-break-1");
    await press("d");
    expect(state.chapterDeleteArmedId).toBe("chapter-break-1");
    await press("d");
    expect(state.payload.chapterBreaks.some((chapterBreak) => chapterBreak.id === "chapter-break-1")).toBeFalse();
    expect(state.payload.nodes.some((node) => node.chapterBreakId === "chapter-break-1")).toBeFalse();
    await press("u");
    expect(state.payload.chapterBreaks.some((chapterBreak) => chapterBreak.id === "chapter-break-1")).toBeTrue();
    expect(state.payload.nodes.some((node) => node.chapterBreakId === "chapter-break-1")).toBeTrue();
  });

  test("chapters overlay summarizes a closed raw chapter and jumps to its divider", async () => {
    const { state, press } = harness();
    await press("c");
    expect(state.mode).toBe("CHAPTERS");
    await press("up");
    await press("s");
    expect(state.payload.nodes.some((node) => node.chapterBreakId === "chapter-break-2")).toBeTrue();
    await press("return", "\r");
    expect(state.mode).toBe("NAV");
    expect(createStoryViewModel(state.payload).rows[state.focusIndex]).toMatchObject({
      kind: "chapter-divider",
      break: { id: "chapter-break-1" }
    });
  });

  test("enter expands and collapses a focused chapter summary", async () => {
    const { state, press } = harness();
    const view = createStoryViewModel(state.payload);
    state.focusIndex = view.rows.findIndex((row) => row.kind === "chapter-summary");
    await press("return", "\r");
    expect(state.expandedChapterSummaryIds.has("chapter-summary-1")).toBeTrue();
    await press("return", "\r");
    expect(state.expandedChapterSummaryIds.has("chapter-summary-1")).toBeFalse();
  });

  test("n opens the Author's Note when a chapter summary is focused", async () => {
    const { state, press } = harness();
    const previousId = state.payload.id;
    const view = createStoryViewModel(state.payload);
    state.focusIndex = view.rows.findIndex((row) => row.kind === "chapter-summary");

    await press("n");

    expect(state.payload.id).toBe(previousId);
    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toMatchObject({
      kind: "document",
      target: { kind: "authors-note" }
    });
  });

  test("n opens the Author's Note when a chapter divider is focused", async () => {
    const { state, press } = harness();
    const previousId = state.payload.id;
    const view = createStoryViewModel(state.payload);
    state.focusIndex = view.rows.findIndex((row) => row.kind === "chapter-divider");

    await press("n");

    expect(state.payload.id).toBe(previousId);
    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toMatchObject({
      kind: "document",
      target: { kind: "authors-note" }
    });
  });

  test("bracket keys jump to adjacent opening dividers", async () => {
    const { state, press } = harness();
    focusNode(state, "p12");
    await press("[");
    expect(createStoryViewModel(state.payload).rows[state.focusIndex]).toMatchObject({
      kind: "chapter-divider", break: { id: "chapter-break-1" }
    });
    await press("]");
    expect(createStoryViewModel(state.payload).rows[state.focusIndex]).toMatchObject({
      kind: "chapter-divider", break: { id: "chapter-break-2" }
    });
  });

  test(":end here creates a break at the active leaf", async () => {
    const { state, press } = harness();
    await press(":", ":");
    for (const character of "end here") await press(character, character);
    await press("return", "\r");
    expect(state.payload.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === "p13")).toBeTrue();
  });
});

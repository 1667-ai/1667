import { describe, expect, test } from "bun:test";
import { TextRenderable, type KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { ActionRuntime, withActionAdmission } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import { clearNativeSelectionIfMatches, storySelectionFromRendererSelection } from "../src/copy-actions.js";
import { demoAppSource } from "../src/demo.js";
import { createInteractiveInputAdmission } from "../src/interactive-input-admission.js";
import { createPalette } from "../src/palette.js";
import {
  createPresentedInputQueue,
  observeInputAdmission
} from "../src/presented-input-queue.js";
import {
  capturePresentedInputSelection,
  consumePresentedSelection,
  guardFactsStorySelectionCapture,
  reconcilePresentedSelection,
  retirePresentedSelection,
  type CapturedPresentedSelection,
  type PresentedSelectionFrame
} from "../src/presented-selection.js";
import { buildStorySelectionProjection } from "../src/selection-projection.js";
import { segment, type FrameLine } from "../src/screens/story/frame.js";
import { createStorySurface } from "../src/story-surface.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function key(name: string, sequence = name, ctrl = false): KeyEvent {
  return { name, sequence, shift: false, ctrl, meta: false } as KeyEvent;
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

  test("releases the presented-input queue while a Fact check runs", async () => {
    const source = demoAppSource(false);
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    const originalCheck = source.api.checkFactConsistency!;
    const result = deferred<Awaited<ReturnType<typeof originalCheck>>>();
    source.api.checkFactConsistency = async () => result.promise;
    let repaints = 0;

    const enqueueKey = (event: KeyEvent) => {
      let admitted!: () => void;
      let rejected!: (error: unknown) => void;
      let dispatch!: Promise<void>;
      const admission = new Promise<void>((resolve, reject) => {
        admitted = resolve;
        rejected = reject;
      });
      queue.enqueue(() => {
        const pending = observeInputAdmission((admit) => {
          dispatch = handleKey(
            event,
            state,
            source,
            cache,
            () => { repaints += 1; admit(); },
            () => { admit(); return Promise.resolve(); },
            () => undefined,
            null,
            undefined,
            undefined,
            withActionAdmission(backend, admit)
          );
          return dispatch;
        }, (work) => backend.observe(work));
        void pending.then(admitted, rejected);
        return pending;
      });
      return { admission, dispatch: () => dispatch };
    };

    try {
      await enqueueKey(key("p", "\u0010", true)).dispatch();
      await enqueueKey(key("return")).dispatch();
      const repaintsBeforeCheck = repaints;
      const checking = enqueueKey(key("return"));
      await checking.admission;
      expect(repaints).toBeGreaterThan(repaintsBeforeCheck);
      expect(state.factConsistency?.surface.phase).toBe("running");

      const escape = enqueueKey(key("escape"));
      await escape.admission;
      expect(state.mode).toBe("NAV");
      expect(state.factConsistency?.surface.phase).toBe("running");

      const direct = enqueueKey(key("return"));
      await direct.admission;
      await direct.dispatch();
      expect(state.mode).toBe("COMPOSE");
      for (const character of "draft while checking") {
        const typed = enqueueKey(key(character));
        await typed.admission;
        await typed.dispatch();
      }
      expect(state.composer.text).toBe("draft while checking");

      result.resolve(await originalCheck({
        storyId: state.payload.id,
        focusedPartId: state.payload.path[0]!.id,
        scope: "chapter",
        planToken: "0".repeat(64)
      }));
      await checking.dispatch();
      expect(state.factConsistency?.surface.phase).toBe("results");
    } finally {
      backend.dispose();
    }
  });

  test("retains story selection when Facts opens before Ctrl-P Fact creation", async () => {
    const setup = await createTestRenderer({ width: 80, height: 4 });
    const source = demoAppSource(false);
    const state = initialState(source, false);
    const palette = createPalette("lantern", "256");
    const surface = createStorySurface(setup.renderer, palette);
    const selectedText = "selected story text";
    const frame: FrameLine[] = [[{
      ...segment(selectedText),
      storySource: { key: "part:selection:text", text: selectedText, start: 0 }
    }]];
    const width = 80;
    surface.paint(frame, palette, {
      fullWidth: width,
      pageWidth: width,
      railStart: null,
      factLeft: null,
      railRight: null
    }, null);
    await setup.renderOnce();

    const page = setup.renderer.root.findDescendantById("story") as TextRenderable;
    const projection = buildStorySelectionProjection(frame, width);
    state.storySelectionProjection = projection;
    setup.renderer.startSelection(page, 0, 0);
    setup.renderer.updateSelection(page, selectedText.length, 0, { finishDragging: true });
    expect(storySelectionFromRendererSelection(setup.renderer, projection)?.text).toBe(selectedText);

    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const inputAdmission = createInteractiveInputAdmission();
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    let latestSelectionCapture: CapturedPresentedSelection | null = null;
    const presentedFrame = (): PresentedSelectionFrame => ({
      version: 1,
      storyId: state.payload.id,
      interactive: true,
      state: { mode: state.mode },
      composerSelectionProjection: null,
      storySelectionProjection: state.mode === "NAV" || state.mode === "FACTS"
        ? state.storySelectionProjection
        : null
    });
    const press = async (event: KeyEvent): Promise<void> => {
      const previous = latestSelectionCapture;
      const queuedSelection = capturePresentedInputSelection(
        setup.renderer,
        presentedFrame(),
        previous,
        false
      );
      const guardedSelection = guardFactsStorySelectionCapture(queuedSelection, previous);
      latestSelectionCapture = guardedSelection;
      let settled!: () => void;
      const done = new Promise<void>((resolve) => { settled = resolve; });
      inputAdmission.enqueueText(queue, () => {
        const selection = reconcilePresentedSelection(guardedSelection, 1, state);
        if (selection.kind === "stale") {
          retirePresentedSelection(setup.renderer, guardedSelection);
          settled();
          return;
        }
        const capturedStorySelection = selection.kind === "captured"
          ? storySelectionFromRendererSelection(selection.native, selection.story)
          : null;
        if (selection.kind === "captured" && selection.native !== null) {
          clearNativeSelectionIfMatches(setup.renderer, selection.native);
        }
        consumePresentedSelection(guardedSelection);
        const work = observeInputAdmission((admit) => handleKey(
          event,
          state,
          source,
          cache,
          admit,
          () => { admit(); return Promise.resolve(); },
          () => undefined,
          setup.renderer,
          () => undefined,
          () => undefined,
          withActionAdmission(backend, admit),
          capturedStorySelection
        ), (pending) => backend.observe(pending));
        void work.then(settled, settled);
        return work;
      }, () => {
        retirePresentedSelection(setup.renderer, guardedSelection);
        settled();
      });
      await done;
      await backend.settle();
    };

    try {
      await press(key("f"));
      expect(state.mode).toBe("FACTS");
      expect(state.facts?.storySelection?.text).toBe(selectedText);

      await press(key("p", "\u0010", true));
      expect(state.mode).toBe("COMMANDS");
      expect(state.commands?.selection?.text).toBe(selectedText);

      for (const character of "new Fact from selection") await press(key(character));
      expect(state.commands?.selectedId).toBe("new-fact-from-selection");
      await press(key("return", "\r"));

      expect(state.mode).toBe("EDITOR");
      expect(state.editor?.kind).toBe("fact");
      expect(state.editor?.kind === "fact" ? state.editor.composer.text : null).toBe(selectedText);
    } finally {
      backend.dispose();
      setup.renderer.destroy();
    }
  });

  test("does not project a fresh Facts-panel range onto story commands", async () => {
    const setup = await createTestRenderer({ width: 80, height: 4 });
    const source = demoAppSource(false);
    const state = initialState(source, false);
    const palette = createPalette("lantern", "256");
    const surface = createStorySurface(setup.renderer, palette);
    const storyText = "underlying story text";
    const storyFrame: FrameLine[] = [[{
      ...segment(storyText),
      storySource: { key: "part:underlying:text", text: storyText, start: 0 }
    }]];
    const width = 80;
    const layout = {
      fullWidth: width,
      pageWidth: width,
      railStart: null,
      factLeft: null,
      railRight: null
    };
    surface.paint(storyFrame, palette, layout, null);
    await setup.renderOnce();
    state.storySelectionProjection = buildStorySelectionProjection(storyFrame, width);

    const cache = createWrapCache<ProseStyle>();
    const backend = new ActionRuntime(state, () => undefined);
    const inputAdmission = createInteractiveInputAdmission();
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    let latestSelectionCapture: CapturedPresentedSelection | null = null;
    const presentedFrame = (): PresentedSelectionFrame => ({
      version: 1,
      storyId: state.payload.id,
      interactive: true,
      state: { mode: state.mode },
      composerSelectionProjection: null,
      storySelectionProjection: state.mode === "NAV" || state.mode === "FACTS"
        ? state.storySelectionProjection
        : null
    });
    const press = async (event: KeyEvent): Promise<void> => {
      const previous = latestSelectionCapture;
      const queuedSelection = capturePresentedInputSelection(
        setup.renderer,
        presentedFrame(),
        previous,
        false
      );
      const guardedSelection = guardFactsStorySelectionCapture(queuedSelection, previous);
      latestSelectionCapture = guardedSelection;
      let settled!: () => void;
      const done = new Promise<void>((resolve) => { settled = resolve; });
      inputAdmission.enqueueText(queue, () => {
        const selection = reconcilePresentedSelection(guardedSelection, 1, state);
        if (selection.kind === "stale") {
          retirePresentedSelection(setup.renderer, guardedSelection);
          settled();
          return;
        }
        const capturedStorySelection = selection.kind === "captured"
          ? storySelectionFromRendererSelection(selection.native, selection.story)
          : null;
        if (selection.kind === "captured" && selection.native !== null) {
          clearNativeSelectionIfMatches(setup.renderer, selection.native);
        }
        consumePresentedSelection(guardedSelection);
        const work = observeInputAdmission((admit) => handleKey(
          event,
          state,
          source,
          cache,
          admit,
          () => { admit(); return Promise.resolve(); },
          () => undefined,
          setup.renderer,
          () => undefined,
          () => undefined,
          withActionAdmission(backend, admit),
          capturedStorySelection
        ), (pending) => backend.observe(pending));
        void work.then(settled, settled);
        return work;
      }, () => {
        retirePresentedSelection(setup.renderer, guardedSelection);
        settled();
      });
      await done;
      await backend.settle();
    };

    try {
      // Use the normal Facts entry key. There is no native range at this
      // point, so the retained projection has no original selection owner.
      await press(key("f"));
      expect(state.mode).toBe("FACTS");

      const panelText = "Facts panel cell";
      surface.paint([[segment(panelText)]], palette, layout, null);
      await setup.renderOnce();
      const page = setup.renderer.root.findDescendantById("story") as TextRenderable;
      setup.renderer.startSelection(page, 0, 0);
      setup.renderer.updateSelection(page, panelText.length, 0, { finishDragging: true });
      expect(setup.renderer.getSelection()).not.toBeNull();

      await press(key("p", "\u0010", true));
      expect(state.mode).toBe("COMMANDS");
      expect(state.commands?.selection ?? null).toBeNull();
      for (const character of "rewrite selection") await press(key(character));
      expect(state.commands?.selectedId).not.toBe("rewrite-selection");
      await press(key("return", "\r"));
      expect(state.mode).not.toBe("EDITOR");
    } finally {
      backend.dispose();
      setup.renderer.destroy();
    }
  });
});

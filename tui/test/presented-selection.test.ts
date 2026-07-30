import { expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { createComposer, insertComposerText } from "../src/composer-model.js";
import {
  clearNativeSelectionIfMatches,
  handleMainCopyShortcut,
  syncMouseComposerSelection
} from "../src/copy-actions.js";
import { demoAppSource } from "../src/demo.js";
import {
  capturePresentedInputSelection,
  capturePresentedSelection,
  consumePresentedSelection,
  hasCopyablePresentedSelection,
  reconcilePresentedSelection,
  retirePresentedSelection
} from "../src/presented-selection.js";
import { buildComposerSelectionProjection } from "../src/selection-projection.js";
import { fitLine } from "../src/screens/story/frame.js";

test("presented selection freezes its native range and frame projections", () => {
  const state = initialState(demoAppSource(), false);
  const storyProjection = [{ key: "part:text", text: "alpha", start: 0, end: 1 }];
  let selected = nativeSelection("alpha", 0, 5);
  const captured = capturePresentedSelection(
    { getSelection: () => selected } as never,
    {
      version: 7,
      storyId: state.payload.id,
      interactive: true,
      state: { mode: "NAV" },
      composerSelectionProjection: null,
      storySelectionProjection: storyProjection
    }
  );

  selected = nativeSelection("beta", 6, 10);
  const reconciled = reconcilePresentedSelection(captured, 7, state);

  expect(reconciled.kind).toBe("captured");
  if (reconciled.kind !== "captured") throw new Error("expected captured selection");
  expect(reconciled.native.text).toBe("alpha");
  expect(reconciled.native.range).toEqual({ start: 0, end: 5 });
  expect(reconciled.story).toBe(storyProjection);
});

test("presented selection discards a native range after semantic ownership changes", () => {
  const state = initialState(demoAppSource(), false);
  const captured = capturePresentedSelection(
    { getSelection: () => nativeSelection("alpha", 0, 5) } as never,
    {
      version: 7,
      storyId: state.payload.id,
      interactive: true,
      state: { mode: "NAV" },
      composerSelectionProjection: null,
      storySelectionProjection: null
    }
  );

  expect(reconcilePresentedSelection(captured, 8, state).kind).toBe("stale");
  state.mode = "COMPOSE";
  expect(reconcilePresentedSelection(captured, 7, state).kind).toBe("stale");
});

test("presented selection rejects stale projections owned by a loading frame", () => {
  const state = initialState(demoAppSource(), false);
  const captured = capturePresentedSelection(
    { getSelection: () => nativeSelection("alpha", 0, 5) } as never,
    {
      version: 7,
      storyId: state.payload.id,
      interactive: false,
      state: { mode: "NAV" },
      composerSelectionProjection: null,
      storySelectionProjection: [{ key: "old:text", text: "old", start: 0, end: 1 }]
    }
  );

  expect(reconcilePresentedSelection(captured, 7, state).kind).toBe("stale");
});

test("retiring stale ownership clears a rebound native selection identity", () => {
  const state = initialState(demoAppSource(), false);
  let text = "old pixels";
  let range = { start: 0, end: 10 };
  const selected = {
    getSelectedText: () => text,
    anchor: { x: 0, y: 0 },
    focus: { x: 10, y: 0 },
    selectedRenderables: [{ getSelection: () => range }]
  } as never;
  let current: typeof selected | null = selected;
  const renderer = {
    getSelection: () => current,
    clearSelection: () => { current = null; }
  } as never;
  const captured = capturePresentedSelection(renderer, {
    version: 7,
    storyId: state.payload.id,
    interactive: true,
    state: { mode: "NAV" },
    composerSelectionProjection: null,
    storySelectionProjection: null
  });
  const sibling = capturePresentedSelection(renderer, captured.frame, captured);

  expect(sibling).toBe(captured);
  expect(reconcilePresentedSelection(captured, 8, state).kind).toBe("stale");
  text = "new pixels";
  range = { start: 11, end: 21 };
  retirePresentedSelection(renderer, captured);

  expect(captured.disposition).toBe("retired");
  expect(reconcilePresentedSelection(sibling, 8, state).kind).toBe("stale");
  expect(current).toBe(null);
  const next = capturePresentedSelection(renderer, {
    version: 8,
    storyId: state.payload.id,
    interactive: true,
    state: { mode: "NAV" },
    composerSelectionProjection: null,
    storySelectionProjection: null
  }, captured);
  expect(reconcilePresentedSelection(next, 8, state).kind).toBe("none");
});

test("retiring stale ownership preserves a newer drag identity", () => {
  const state = initialState(demoAppSource(), false);
  const oldSelection = nativeSelection("old", 0, 3);
  const newSelection = nativeSelection("new", 4, 7);
  let current = oldSelection;
  let clears = 0;
  const renderer = {
    getSelection: () => current,
    clearSelection: () => { clears += 1; }
  } as never;
  const captured = capturePresentedSelection(renderer, {
    version: 7,
    storyId: state.payload.id,
    interactive: true,
    state: { mode: "NAV" },
    composerSelectionProjection: null,
    storySelectionProjection: null
  });

  current = newSelection;
  retirePresentedSelection(renderer, captured);

  expect(clears).toBe(0);
  expect(capturePresentedSelection(renderer, {
    version: 8,
    storyId: state.payload.id,
    interactive: true,
    state: { mode: "NAV" },
    composerSelectionProjection: null,
    storySelectionProjection: null
  }, captured).native?.identity).toBe(newSelection);
});

test("a retained native range on a loading frame is not copyable", () => {
  const state = initialState(demoAppSource(), false);
  const captured = capturePresentedSelection(
    { getSelection: () => nativeSelection("old pixels", 0, 10) } as never,
    {
      version: 7,
      storyId: state.payload.id,
      interactive: false,
      state: { mode: "NAV" },
      composerSelectionProjection: null,
      storySelectionProjection: null
    }
  );

  expect(hasCopyablePresentedSelection(captured)).toBeFalse();
});

test("failed-frame input retires rebound native selection but keeps the key selection-free", () => {
  const state = initialState(demoAppSource(), false);
  state.mode = "COMPOSE";
  let text = "selected draft";
  const selection = {
    getSelectedText: () => text,
    anchor: { x: 0, y: 0 },
    focus: { x: 8, y: 0 },
    selectedRenderables: [{ getSelection: () => ({ start: 0, end: 8 }) }]
  } as never;
  let current: typeof selection | null = selection;
  const renderer = {
    getSelection: () => current,
    clearSelection: () => { current = null; }
  } as never;
  const frame = {
    version: 7,
    storyId: state.payload.id,
    interactive: true,
    state: { mode: "COMPOSE" as const },
    composerSelectionProjection: null,
    storySelectionProjection: null
  };
  const prior = capturePresentedSelection(renderer, frame);

  text = "partial pixels";
  const queued = capturePresentedInputSelection(renderer, frame, prior, true);

  expect(prior.disposition).toBe("retired");
  expect(current).toBe(null);
  expect(queued.native).toBe(null);
  expect(reconcilePresentedSelection(queued, 7, state).kind).toBe("none");
});

test("queued typeahead consumes one shared native selection only once", () => {
  const state = initialState(demoAppSource(), false);
  state.mode = "COMPOSE";
  state.composer = createComposer("alpha beta");
  const selected = nativeSelection("alpha", 0, 5);
  const renderer = { getSelection: () => selected } as never;
  const composerProjection = buildComposerSelectionProjection([fitLine([{
    text: state.composer.text,
    composerStart: 0
  }], 20)], 20)!;
  const frame = {
    version: 7,
    storyId: state.payload.id,
    interactive: true,
    state: { mode: "COMPOSE" as const },
    composerSelectionProjection: composerProjection,
    storySelectionProjection: null
  };
  const first = capturePresentedSelection(renderer, frame);
  const animationFrame = {
    ...frame,
    state: { ...frame.state }
  };
  const loading = capturePresentedSelection(renderer, {
    ...animationFrame,
    interactive: false
  }, first);
  const second = capturePresentedSelection(renderer, animationFrame, first);

  expect(loading).not.toBe(first);
  expect(second).toBe(first);
  const firstSelection = reconcilePresentedSelection(first, 7, state);
  expect(firstSelection.kind).toBe("captured");
  if (firstSelection.kind !== "captured") throw new Error("expected captured selection");
  syncMouseComposerSelection(firstSelection.native, state, firstSelection.composer);
  consumePresentedSelection(first);
  insertComposerText(state.composer, "X");

  expect(reconcilePresentedSelection(second, 8, state).kind).toBe("none");
  insertComposerText(state.composer, "Y");
  expect(state.composer.text).toBe("XY beta");
});

test("copying an uneditable selection clears before the next key capture", () => {
  const state = initialState(demoAppSource(), false);
  state.mode = "EDITOR";
  const body = createComposer("Body");
  state.editor = {
    kind: "fact",
    target: { kind: "fact", factId: null, base: null },
    composer: body,
    tag: createComposer("weather"),
    focus: "body",
    initialFact: { tag: "weather", text: body.text },
    title: "edit fact",
    placeholder: "fact text…",
    returnMode: "FACTS",
    conflict: null,
    cutConfirmation: null,
    tagCutConfirmation: null
  };
  const selected = nativeSelection("weather", 0, 7);
  let current: typeof selected | null = selected;
  const renderer = {
    getSelection: () => current,
    clearSelection: () => { current = null; }
  } as never;
  const projection = buildComposerSelectionProjection([fitLine([{
    text: "weather",
    composerSource: { id: "fact-tag", editable: false }
  }], 20)], 20)!;
  const frame = {
    version: 7,
    storyId: state.payload.id,
    interactive: true,
    state: { mode: "EDITOR" as const },
    composerSelectionProjection: projection,
    storySelectionProjection: null
  };
  const captured = capturePresentedSelection(renderer, frame);
  const reconciled = reconcilePresentedSelection(captured, 7, state);
  if (reconciled.kind !== "captured") throw new Error("expected captured selection");

  expect(handleMainCopyShortcut(
    reconciled.native,
    state,
    () => undefined,
    () => { throw new Error("copy must not quit"); },
    reconciled,
    async () => "command"
  )).toBeTrue();
  expect(syncMouseComposerSelection(
    reconciled.native,
    state,
    reconciled.composer
  )).toBe("uneditable");
  expect(clearNativeSelectionIfMatches(renderer, reconciled.native)).toBeTrue();
  consumePresentedSelection(captured);

  const next = capturePresentedSelection(renderer, frame, captured);
  expect(reconcilePresentedSelection(next, 7, state).kind).toBe("none");
});

test("an empty selection remains drain-time input even after its frame changes", () => {
  const state = initialState(demoAppSource(), false);
  const captured = capturePresentedSelection(
    { getSelection: () => null } as never,
    {
      version: 7,
      storyId: state.payload.id,
      interactive: true,
      state: { mode: "NAV" },
      composerSelectionProjection: null,
      storySelectionProjection: null
    }
  );

  state.mode = "COMPOSE";
  expect(reconcilePresentedSelection(captured, 8, state).kind).toBe("none");
});

function nativeSelection(text: string, start: number, end: number) {
  return {
    getSelectedText: () => text,
    anchor: { x: start, y: 0 },
    focus: { x: end, y: 0 },
    selectedRenderables: [{ getSelection: () => ({ start, end }) }]
  } as never;
}

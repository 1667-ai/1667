import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { commandPaletteModel } from "../src/command-model.js";
import { createWrapCache } from "../src/wrap.js";
type ProseStyle = import("../src/wrap.js").ProseStyle;

const key = (name: string): KeyEvent => ({
  name,
  sequence: name,
  shift: false,
  ctrl: false,
  meta: false
}) as KeyEvent;

function context(state: ReturnType<typeof initialState>) {
  return {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: null,
    applyTheme: () => undefined,
    previewTheme: () => undefined,
    asideEntryPointsOpen: true
  };
}

test("activated palette Aside refuses during a live generation", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.stream = {
    targetId: "p13",
    parentId: "p12",
    append: true,
    startedAt: "2026-07-22T00:00:00.000Z",
    instruction: "",
    text: "partial"
  };
  state.abort = {
    kind: "generation",
    controller: new AbortController(),
    stopInteractionVersion: null
  };
  state.mode = "COMMANDS";
  state.commands = {
    query: "aside",
    cursor: 0,
    selectedId: "aside",
    view: "commands",
    returnMode: "NAV"
  };

  const matches = commandPaletteModel("aside", false, {
    connectionDown: false,
    requestActive: true,
    hasProse: true,
    lineTagged: false,
    canRewriteSelection: false,
    asideEntryPointsOpen: true
  }).selectable;
  expect(matches).toHaveLength(1);
  expect(matches[0]!.command).toMatchObject({
    id: "aside",
    blockedByLiveStream: true
  });

  let reads = 0;
  source.api.getAside = async () => {
    reads += 1;
    return { notes: [] };
  };

  await handleOverlayAction({ action: "open-selected" }, state, source, context(state));

  expect(state.toast).toBe("stream running · esc stops it first");
  expect(state.mode).toBe("COMMANDS");
  expect(state.aside).toBeNull();
  expect(reads).toBe(0);
});

test("a opens Aside from story navigation", async () => {
  const source = demoAppSource();
  const state = initialState(source, false);
  let requestedStoryId: string | null = null;
  source.api.getAside = async (storyId) => {
    requestedStoryId = storyId;
    return { notes: [] };
  };

  await handleKey(
    key("a"),
    state,
    source,
    createWrapCache<ProseStyle>(),
    () => undefined,
    async () => undefined,
    () => undefined
  );

  expect(requestedStoryId).toBe(source.payload.id);
  expect(state.mode).toBe("ASIDE");
  expect(state.aside?.storyId).toBe(source.payload.id);
});

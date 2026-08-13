import { expect, test } from "bun:test";

// Exercise the successor-only command without changing the production release
// switch. The predecessor test in aside.test.ts still covers the default gate.
const bunTest = await import("bun:test") as unknown as {
  mock: { module(path: string, factory: () => Record<string, unknown>): void };
};
bunTest.mock.module("../../shared/aside-release.js", () => ({
  ASIDE_ACTIVATED: true,
  resolveAsideActivation: (option?: boolean) => option ?? true,
  asideEntryPointsOpen: (option?: boolean) => option ?? true
}));

const { ActionRuntime } = await import("../src/action-runtime.js");
const { initialState } = await import("../src/app.js");
const { demoAppSource } = await import("../src/demo.js");
const { handleOverlayAction } = await import("../src/overlay-actions.js");
const { commandPaletteModel } = await import("../src/command-model.js");
const { createWrapCache } = await import("../src/wrap.js");
type ProseStyle = import("../src/wrap.js").ProseStyle;

function context(state: ReturnType<typeof initialState>) {
  return {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: null,
    applyTheme: () => undefined,
    previewTheme: () => undefined
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

  const matches = commandPaletteModel("aside", false).selectable;
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

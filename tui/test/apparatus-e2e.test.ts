import { describe, expect, test } from "bun:test";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import type { NodeStub } from "../../shared/types.js";
import { handleKey, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { createStoryViewModel, rowPart } from "../src/model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, visibleWidth } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function key(name: string, sequence = name): KeyEvent {
  return {
    name,
    sequence,
    shift: false,
    ctrl: false,
    meta: false,
    option: false,
    super: false
  } as KeyEvent;
}

async function press(
  name: string,
  state: ReturnType<typeof initialState>,
  source: ReturnType<typeof demoAppSource>,
  terminalWidth?: number,
  sequence = name
): Promise<void> {
  await handleKey(
    key(name, sequence),
    state,
    source,
    createWrapCache<ProseStyle>(),
    () => undefined,
    async () => undefined,
    () => undefined,
    terminalWidth === undefined
      ? null
      : { width: terminalWidth, height: 36 } as CliRenderer
  );
}

function apparatusSource(): ReturnType<typeof demoAppSource> {
  const source = demoAppSource();
  source.config = { ...source.config, apparatus: "on" };
  return source;
}

describe("apparatus beta surface", () => {
  test("keeps the default page unchanged when the setting is off", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const first = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);
    const second = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);

    expect(state.config.apparatus).toBe("off");
    expect(second).toBe(first);
    expect(first).not.toContain("apparatus ·");
  });

  test("shows doorway previews at the focused fork", () => {
    const source = apparatusSource();
    const state = initialState(source, false);
    const text = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);

    expect(text).toContain("apparatus · ¶12 · site 1 · negative · 5 takes");
    expect(text).toContain("active take omitted · stored previews");
    expect(text).toContain('1  b  "Ashe left the compass closed');
    expect(text).toContain("── end apparatus ──");
    expect(text).not.toContain("variant");
    expect(text).not.toContain("witness");
    expect(text).not.toContain("sigla");
  });

  test("ends the apparatus before the next story part", () => {
    const source = apparatusSource();
    const state = initialState(source, false);
    const text = frameText(renderStoryScreen(state, { width: 120, height: 80 }).lines);

    expect(text).toMatch(/── end apparatus ──\s*\n\s*» continue/u);
  });

  test("bounds the band at 80 columns", () => {
    const source = apparatusSource();
    const state = initialState(source, false);
    const lines = renderStoryScreen(state, { width: 80, height: 24 }).lines;

    expect(lines).toHaveLength(24);
    expect(lines.every((line) => visibleWidth(line.map((part) => part.text).join("")) <= 80)).toBeTrue();
    expect(frameText(lines)).toContain("apparatus · ¶12");
    expect(frameText(lines)).toContain("+ 2 more takes · m opens map");
    expect(frameText(lines)).toContain("── end apparatus ──");
  });

  test("promotes a labeled doorway and consumes an invalid chord key", async () => {
    const source = apparatusSource();
    const state = initialState(source, false);
    const before = state.focusIndex;

    await press("1", state, source, 80);
    expect(state.apparatusArmedNodeId).toBe("p12");
    const armed = frameText(renderStoryScreen(state, { width: 80, height: 24 }).lines);
    expect(armed).toContain("site 1 armed · letter selects take");
    expect(armed).toContain("+ 2 more takes");
    expect(armed).not.toContain("m opens map");
    await press("down", state, source, 80);
    expect(state.apparatusArmedNodeId).toBeNull();
    expect(state.focusIndex).toBe(before);

    await press("1", state, source, 80);
    await press("e", state, source, 80);
    expect(state.apparatusArmedNodeId).toBeNull();
    expect(state.focusIndex).toBe(before);

    await press("1", state, source, 80);
    await press("B", state, source, 80);
    expect(state.apparatusArmedNodeId).toBeNull();
    expect(state.focusIndex).toBe(before);

    await press("1", state, source, 80);
    await press("b", state, source, 80, "B");
    expect(state.apparatusArmedNodeId).toBeNull();
    expect(state.focusIndex).toBe(before);

    await press("1", state, source, 80);
    await press("b", state, source, 80);
    expect(state.apparatusArmedNodeId).toBeNull();
    expect(rowPart(createStoryViewModel(state.payload), state.focusIndex)?.id).toBe("p12-t1");
  });

  test("promotes the fourth doorway shown at wide width", async () => {
    const source = apparatusSource();
    const state = initialState(source, false);

    await press("1", state, source, 120);
    await press("e", state, source, 120);

    expect(rowPart(createStoryViewModel(state.payload), state.focusIndex)?.id).toBe("p12-t4");
  });

  test("does not promote a doorway folded at wide width", async () => {
    const source = apparatusSource();
    const hidden: NodeStub = {
      id: "p12-hidden",
      parentId: "p11",
      preview: "This take stays behind the fold.",
      words: 7,
      tokens: 10,
      childCount: 0,
      leafCount: 1,
      lastTouched: "2026-07-20T00:00:00Z",
      hasInstruction: false,
      activeChildId: null
    };
    source.payload = { ...source.payload, nodes: [...source.payload.nodes, hidden] };
    const state = initialState(source, false);
    const before = state.focusIndex;

    expect(frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines))
      .toContain("+ 1 more takes · m opens map");
    await press("1", state, source, 120);
    await press("h", state, source, 120);

    expect(state.apparatusArmedNodeId).toBeNull();
    expect(state.focusIndex).toBe(before);
    expect(rowPart(createStoryViewModel(state.payload), state.focusIndex)?.id).toBe("p12");
  });
});

import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { dispatch, handleKey, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import type { HitRows } from "../src/hit.js";
import { mouseToAction } from "../src/mouse-actions.js";
import type { MapState } from "../src/map-state.js";
import { renderMapScreen } from "../src/screens/map.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import type { RuntimeState } from "../src/state.js";
import { createWrapCache } from "../src/wrap.js";

const STAMP = "2026-01-01T00:00:00.000Z";

const key = (name: string, sequence = name): KeyEvent => ({
  name, sequence, shift: false, ctrl: false, meta: false, option: false, super: false
}) as KeyEvent;

function mapState(state: RuntimeState, lens: string | null = null): MapState {
  const leaf = state.payload.path.at(-1)!.id;
  return {
    view: "tree",
    pathCursorId: leaf,
    pathShowAllTakes: true,
    treeCursorId: leaf,
    rowIds: [],
    showSketches: true,
    openedColdFolds: new Set(),
    massSort: "size",
    factLensFactId: lens
  };
}

function lensState(): ReturnType<typeof initialState> {
  const source = demoAppSource();
  const state = initialState(source, false);
  const base = state.payload.facts[0]!;
  state.payload = {
    ...state.payload,
    facts: [
      {
        ...base,
        id: "ama",
        name: "ama",
        states: [
          { id: "ama-1", text: "The old answer.", createdAt: STAMP, updatedAt: STAMP },
          { id: "ama-2", anchorPartId: "p7", text: "The later answer.", createdAt: STAMP, updatedAt: STAMP },
          { id: "ama-end", anchorPartId: "p11", ends: true, createdAt: STAMP, updatedAt: STAMP }
        ]
      },
      {
        ...base,
        id: "lamp",
        name: "seaward-lamp",
        states: [
          { id: "lamp-1", anchorPartId: "p1", text: "The lamp is lit.", createdAt: STAMP, updatedAt: STAMP },
          { id: "lamp-end", anchorPartId: "p11", ends: true, createdAt: STAMP, updatedAt: STAMP }
        ]
      }
    ]
  };
  state.mode = "MAP";
  state.map = mapState(state);
  return state;
}

function sourceAndState() {
  const source = demoAppSource();
  const state = lensState();
  return { source, state };
}

async function press(
  state: ReturnType<typeof initialState>,
  source: ReturnType<typeof demoAppSource>,
  event: KeyEvent
): Promise<void> {
  await handleKey(event, state, source, createWrapCache(), () => undefined, async () => undefined, () => undefined);
}

function click(x: number, y: number) {
  return {
    type: "down", button: 0, x, y,
    modifiers: { shift: false, alt: false, ctrl: false }
  } as never;
}

function clickText(
  state: ReturnType<typeof initialState>,
  lines: ReturnType<typeof renderStoryScreen>["lines"],
  text: string
) {
  const row = lines.findIndex((line) => plainLine(line).includes(text));
  expect(row).toBeGreaterThan(-1);
  const rendered = plainLine(lines[row]!);
  const left = visibleWidth(rendered.slice(0, rendered.indexOf(text)));
  return mouseToAction(click(left + Math.floor(visibleWidth(text) / 2), row), state);
}

describe("Loom Fact lens", () => {
  test("recolors the existing tree from the shared resolver, including later and dead reach", () => {
    const state = lensState();
    state.map!.factLensFactId = "ama";
    const hits: HitRows = [];
    const frame = renderMapScreen(state, state.map!, 140, 60, hits);
    const text = frameText(frame.lines);

    expect(text).toContain("loom");
    expect(text).toContain("fact lens: ama");
    expect(text).toContain("◆");
    expect(text).toContain("✕");
    expect(text).toContain("╌");

    const later = frame.lines.find((line) => plainLine(line).includes("He called himself Ashe"));
    expect(later?.some((part) => part.role === "fresh 1")).toBeTrue();
    const end = frame.lines.find((line) => plainLine(line).includes("Maren counted the lanterns"));
    expect(end?.some((part) => part.text.includes("✕") && part.role === "prose · dim")).toBeTrue();
    const dead = frame.lines.find((line) => plainLine(line).includes("Outside, the storm"));
    expect(dead?.some((part) => part.text.includes("╌") && part.role === "dimmed page")).toBeTrue();
  });

  test("opens from the tree, cycles Facts, and Esc preserves the map", async () => {
    const { source, state } = sourceAndState();
    const map = state.map!;
    const cursor = map.treeCursorId;
    await press(state, source, key("f"));
    expect(state.map?.factLensFactId).toBe("ama");

    await press(state, source, key("tab", "\t"));
    expect(state.map?.factLensFactId).toBe("lamp");
    await press(state, source, key("escape"));
    expect(state.mode).toBe("MAP");
    expect(state.map).toBe(map);
    expect(state.map?.view).toBe("tree");
    expect(state.map?.treeCursorId).toBe(cursor);
    expect(state.map?.factLensFactId).toBe(null);
  });

  test("Enter follows the selected visible anchor and e opens that state editor", async () => {
    const { source, state } = sourceAndState();
    state.map!.factLensFactId = "ama";
    state.map!.treeCursorId = "p7";
    await press(state, source, key("return", "\r"));
    expect(state.mode).toBe("NAV");
    expect(state.map).toBe(null);
    expect(state.focusIndex).toBe(rowIndexForNode(createStoryViewModel(state.payload), "p7"));

    const second = sourceAndState();
    second.state.map!.factLensFactId = "ama";
    second.state.map!.treeCursorId = "p7";
    await press(second.state, second.source, key("e"));
    expect(second.state.mode).toBe("EDITOR");
    expect(second.state.editor).toMatchObject({ kind: "fact", stateId: "ama-2", returnMode: "MAP" });
    await press(second.state, second.source, key("escape"));
    expect(second.state.mode).toBe("MAP");
    expect(second.state.map?.factLensFactId).toBe("ama");

    const saved = sourceAndState();
    const savedMap = saved.state.map!;
    savedMap.factLensFactId = "ama";
    savedMap.treeCursorId = "p7";
    await press(saved.state, saved.source, key("e"));
    expect(saved.state.mode).toBe("EDITOR");
    await dispatch(
      { action: "save-edit" }, saved.state, saved.source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );
    expect(saved.state.mode).toBe("MAP");
    expect(saved.state.map).toBe(savedMap);
    expect(saved.state.map?.factLensFactId).toBe("ama");
  });

  test("Fact editor re-anchor cursor follows the selected Map lens node", async () => {
    const { source, state } = sourceAndState();
    state.map!.factLensFactId = "ama";
    state.map!.treeCursorId = "p7";
    await press(state, source, key("e"));
    expect(state.editor?.kind).toBe("fact");
    expect(state.editor?.kind === "fact" ? state.editor.stateCursorAnchorId : null)
      .toBe("p7");

    const mouse = sourceAndState();
    mouse.state.map!.factLensFactId = "ama";
    mouse.state.map!.treeCursorId = "p7";
    const frame = renderStoryScreen(mouse.state, {
      width: 140,
      height: 36,
      wrapCache: createWrapCache()
    });
    Object.assign(mouse.state, frame.derived);
    const action = clickText(mouse.state, frame.lines, "e edit state");
    expect(action).toEqual({ action: "edit-fact-lens" });
    await dispatch(
      action!, mouse.state, mouse.source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );
    expect(mouse.state.editor?.kind).toBe("fact");
    expect(mouse.state.editor?.kind === "fact" ? mouse.state.editor.stateCursorAnchorId : null)
      .toBe("p7");
  });

  test("does not edit an unrelated state from an off-path Map row", async () => {
    const { source, state } = sourceAndState();
    state.payload = {
      ...state.payload,
      facts: state.payload.facts.map((fact) => fact.id !== "ama"
        ? fact
        : { ...fact, states: fact.states.filter((candidate) => candidate.anchorPartId !== undefined) })
    };
    state.map!.factLensFactId = "ama";
    state.map!.treeCursorId = "p5-alt";
    await press(state, source, key("e"));
    expect(state.mode).toBe("MAP");
    expect(state.editor).toBeNull();
    expect(state.toast).toBe("this Fact has no state here");
  });

  test("the off-path edit footer click keeps the lens open", async () => {
    const { source, state } = sourceAndState();
    state.payload = {
      ...state.payload,
      facts: state.payload.facts.map((fact) => fact.id !== "ama"
        ? fact
        : { ...fact, states: fact.states.filter((candidate) => candidate.anchorPartId !== undefined) })
    };
    state.map!.factLensFactId = "ama";
    state.map!.treeCursorId = "p5-alt";
    const rendered = renderStoryScreen(state, { width: 140, height: 36, wrapCache: createWrapCache() });
    Object.assign(state, rendered.derived);
    const action = clickText(state, rendered.lines, "e edit state");
    expect(action).toEqual({ action: "edit-fact-lens" });
    await dispatch(action!, state, source, createWrapCache(), () => undefined, async () => undefined, () => undefined);
    expect(state.mode).toBe("MAP");
    expect(state.editor).toBeNull();
    expect(state.toast).toBe("this Fact has no state here");
  });

  test("lens footer controls are all mouse targets with matching actions", async () => {
    const { source, state } = sourceAndState();
    state.map!.factLensFactId = "ama";
    const rendered = renderStoryScreen(state, { width: 140, height: 36, wrapCache: createWrapCache() });
    Object.assign(state, rendered.derived);
    const footer = plainLine(rendered.lines.at(-1)!);
    expect(footer).toContain("tab next fact");
    expect(footer).toContain("enter go to ◆");
    expect(footer).toContain("e edit state");
    expect(footer).toContain("esc loom");
    expect(clickText(state, rendered.lines, "tab next fact")).toEqual({ action: "cycle-fact-lens" });
    expect(clickText(state, rendered.lines, "enter go to ◆")).toEqual({ action: "open-fact-lens-anchor" });
    expect(clickText(state, rendered.lines, "e edit state")).toEqual({ action: "edit-fact-lens" });
    expect(clickText(state, rendered.lines, "esc loom")).toEqual({ action: "cancel" });

    const open = sourceAndState();
    const openFrame = renderStoryScreen(open.state, { width: 140, height: 36, wrapCache: createWrapCache() });
    Object.assign(open.state, openFrame.derived);
    const action = clickText(open.state, openFrame.lines, "f lens");
    expect(action).toEqual({ action: "open-fact-lens" });
    await dispatch(action!, open.state, open.source, createWrapCache(), () => undefined, async () => undefined, () => undefined);
    expect(open.state.map?.factLensFactId).toBe("ama");

    const lensFrame = renderStoryScreen(open.state, { width: 140, height: 36, wrapCache: createWrapCache() });
    Object.assign(open.state, lensFrame.derived);
    expect(clickText(open.state, lensFrame.lines, "tab next fact")).toEqual({ action: "cycle-fact-lens" });
  });

  test("clicking a visible lens row moves the tree cursor", async () => {
    const { source, state } = sourceAndState();
    state.map!.factLensFactId = "ama";
    state.map!.treeCursorId = "p13";
    const rendered = renderStoryScreen(state, { width: 140, height: 36, wrapCache: createWrapCache() });
    Object.assign(state, rendered.derived);
    const action = clickText(state, rendered.lines, "He called himself Ashe");
    expect(action).toEqual({
      action: "focus-index",
      index: state.map!.rowIds.indexOf("p7")
    });
    await dispatch(action!, state, source, createWrapCache(), () => undefined, async () => undefined, () => undefined);
    expect(state.map?.treeCursorId).toBe("p7");
  });
});

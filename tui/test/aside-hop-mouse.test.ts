/** Mouse activation for the Aside v2 hop strip. */
import { describe, expect, test } from "bun:test";
import type { AsideReadRequest, AsideReadResponse } from "../../shared/aside-transport.js";
import {
  createAsideSurface,
  isAsideV2,
  type AsideAnchorView,
  type AsideSessionAnchor
} from "../src/aside-surface.js";
import { asideHopEntries, asideHopRowId } from "../src/aside-hop.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { mouseToAction, captureMouseActionState } from "../src/mouse-actions.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import {
  reconcilePresentedMouseAction,
  type FrozenMouseEvent,
  type PresentedInteraction
} from "../src/presented-mouse-action.js";

const ANCHORS: readonly AsideAnchorView[] = [
  { partId: "part-1", takeId: "take-1", partNumber: 1, sessionCount: 1 },
  { partId: "part-2", takeId: "take-2", partNumber: 2, sessionCount: 2 },
  { partId: "part-3", takeId: "take-3", partNumber: 3, sessionCount: 1 },
  { partId: "part-4", takeId: "take-4", partNumber: 4, sessionCount: 1 },
  {
    partId: "__aside_unanchored__",
    takeId: "__aside_unanchored__",
    sessionCount: 2,
    unanchored: true
  }
];

const CURRENT: AsideSessionAnchor = { partId: "part-2", takeId: "take-2" };

function setup() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const surface = createAsideSurface(
    state.payload.id,
    state.payload.title,
    [{
      id: "session-current",
      title: "current",
      anchor: CURRENT,
      turns: [{ q: "Current?", a: "Current answer." }]
    }],
    null,
    null,
    { v2: true, anchor: CURRENT, anchors: ANCHORS }
  );
  if (!isAsideV2(surface)) throw new Error("expected v2 Aside surface");
  state.aside = surface;
  state.mode = "ASIDE";
  const reads: (AsideSessionAnchor | null)[] = [];
  const api = {
    ...source.api,
    getAsideV2: async (request: AsideReadRequest): Promise<AsideReadResponse> => {
      const anchor = request.anchor ?? null;
      reads.push(anchor);
      return {
        schemaVersion: 2,
        anchor,
        sessions: [{
          schemaVersion: 2,
          id: "session-target",
          title: "target",
          anchor,
          turns: [{ q: "Target?", a: "Target answer." }]
        }],
        anchors: ANCHORS.filter((entry) => entry.unanchored !== true).map((entry) => ({
          partId: entry.partId,
          takeId: entry.takeId,
          partNumber: entry.partNumber,
          sessionCount: entry.sessionCount
        })),
        unanchoredCount: 2
      };
    }
  } as typeof source.api;
  const app = { ...source, api };
  const context = {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: { width: 120, height: 24 } as never,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };
  return { app, state, surface, reads, context };
}

function clickForHop(
  state: ReturnType<typeof initialState>,
  rowId: string,
  width = 120,
  height = 24
): FrozenMouseEvent {
  const frame = renderStoryScreen(state, { width, height });
  state.hitRows = frame.derived.hitRows;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const action = mouseToAction({
        type: "down",
        button: 0,
        x,
        y,
        modifiers: { shift: false, alt: false, ctrl: false }
      }, state);
      if (action?.action === "aside-hop-to" && action.rowId === rowId) {
        return {
          type: "down",
          button: 0,
          x,
          y,
          modifiers: { shift: false, alt: false, ctrl: false }
        };
      }
    }
  }
  throw new Error(`hop target not rendered: ${rowId}`);
}

describe("Aside hop mouse", () => {
  test("a partially visible current hop label remains clickable", () => {
    const { state } = setup();
    const current = asideHopEntries(ANCHORS, CURRENT).find((entry) => entry.current);
    if (current === undefined) throw new Error("missing current hop");
    const click = clickForHop(state, asideHopRowId(current), 20, 24);
    expect(mouseToAction(click, state)).toEqual({
      action: "aside-hop-to",
      index: current.index,
      rowId: asideHopRowId(current)
    });
  });

  test("a height-clipped hop row keeps its visible labels clickable", () => {
    const { state } = setup();
    const current = asideHopEntries(ANCHORS, CURRENT).find((entry) => entry.current);
    if (current === undefined) throw new Error("missing current hop");
    const click = clickForHop(state, asideHopRowId(current), 80, 6);
    expect(mouseToAction(click, state)).toMatchObject({
      action: "aside-hop-to",
      rowId: asideHopRowId(current)
    });
  });

  test("clicking every visible hop target loads its exact session", async () => {
    const entries = asideHopEntries(ANCHORS, CURRENT);
    for (const entry of entries) {
      const { app, state, surface, reads, context } = setup();
      const click = clickForHop(state, asideHopRowId(entry));
      const action = mouseToAction(click, state);
      expect(action).toEqual({
        action: "aside-hop-to",
        index: entry.index,
        rowId: asideHopRowId(entry)
      });
      await handleOverlayAction(action!, state, app, context);
      await context.backend.settle();
      expect(state.mode).toBe("ASIDE");
      expect(state.aside).toBe(surface);
      if (entry.current) {
        expect(reads).toEqual([]);
        expect(surface.anchor).toEqual(CURRENT);
      } else {
        expect(reads).toEqual([entry.anchor.unanchored === true ? null : {
          partId: entry.anchor.partId,
          takeId: entry.anchor.takeId
        }]);
        expect(surface.anchor).toEqual(
          entry.anchor.unanchored === true ? null : {
            partId: entry.anchor.partId,
            takeId: entry.anchor.takeId
          }
        );
      }
    }
  });

  test("queued hop click rebases by stable anchor identity", async () => {
    const { app, state, surface, reads, context } = setup();
    const target = asideHopEntries(ANCHORS, CURRENT).find((entry) =>
      entry.anchor.partId === "part-4");
    if (target === undefined) throw new Error("missing target hop");
    const click = clickForHop(state, asideHopRowId(target));
    const action = mouseToAction(click, state);
    expect(action?.index).toBe(target.index);
    const captured: PresentedInteraction = {
      version: 1,
      frameToken: 1,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };

    // Presence refresh removes an earlier target, changing the index while
    // keeping the clicked anchor address alive.
    surface.anchors = surface.anchors.filter((entry) => entry.partId !== "part-1");
    state.hitRows = renderStoryScreen(state, { width: 120, height: 24 }).derived.hitRows;
    const presented: PresentedInteraction = {
      version: 2,
      frameToken: 2,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const rebased = reconcilePresentedMouseAction({
      action: action!,
      event: click,
      captured,
      presented,
      state
    });
    expect(rebased).toEqual({
      action: "aside-hop-to",
      index: 2,
      rowId: asideHopRowId(target)
    });
    await handleOverlayAction(rebased!, state, app, context);
    await context.backend.settle();
    expect(reads).toEqual([{ partId: "part-4", takeId: "take-4" }]);
    expect(state.mode).toBe("ASIDE");
    expect(surface.anchor).toEqual({ partId: "part-4", takeId: "take-4" });
  });

  test("hop click waits for an undoable delete commit", async () => {
    const { app, state, surface, reads, context } = setup();
    let deletes = 0;
    const source = {
      ...app,
      api: {
        ...app.api,
        deleteAsideTurn: async () => {
          deletes += 1;
          return {
            schemaVersion: 2 as const,
            id: "session-current",
            title: "current",
            anchor: CURRENT,
            turns: []
          };
        }
      }
    };
    await handleOverlayAction({ action: "aside-delete" }, state, source, context);
    await handleOverlayAction({ action: "aside-delete" }, state, source, context);
    expect(surface.deleteUndo).not.toBeNull();

    const target = asideHopEntries(ANCHORS, CURRENT).find((entry) =>
      entry.anchor.partId === "part-1");
    if (target === undefined) throw new Error("missing target hop");
    const action = mouseToAction(
      clickForHop(state, asideHopRowId(target)),
      state
    );
    expect(action).toMatchObject({ action: "aside-hop-to", index: target.index });
    await handleOverlayAction(action!, state, source, context);
    await context.backend.settle();

    expect(deletes).toBe(1);
    expect(reads).toEqual([{ partId: "part-1", takeId: "take-1" }]);
    expect(state.mode).toBe("ASIDE");
    expect(surface.anchor).toEqual({ partId: "part-1", takeId: "take-1" });
  });
});

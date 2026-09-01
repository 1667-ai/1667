import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { dispatch, handleKey, initialState } from "../src/app.js";
import { createAsideSurface } from "../src/aside-surface.js";
import { commandContext, commandMatches, type CommandId } from "../src/command-model.js";
import { createComposer, setComposerText } from "../src/composer-model.js";
import { attachDraftImage, draftImagesFor } from "../src/draft-image.js";
import { demoAppSource } from "../src/demo.js";
import { factsOpeningPartId, factsPaletteContext } from "../src/facts-command-context.js";
import { mapCursorNodeId, openMap } from "../src/map-actions.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { createGenerationRecordDetailCache } from "../src/generation-record-detail-cache.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { rememberedLeafId } from "../../shared/story-model.js";
import { unusedTakePruneSelection } from "../../shared/story-tree.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import type { AppMode } from "../src/keys.js";
import { publishCurrentSettingsModelDiscovery } from "../src/settings-model-discovery.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { editorHarness, key } from "./editor-harness.js";
import { openTextActions } from "../src/text-actions.js";
import { openActions } from "../src/story-actions.js";
import {
  deferred,
  openSettings as openSettingsForm,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { openRetakeComposer } from "../src/composer-ownership.js";
import { cancelSummary } from "../src/summary-action.js";
import { openAsideUseMenu } from "../src/aside-use.js";
import { openPlacementFromAside } from "../src/aside-placement.js";

const APP_MODES = Object.keys({
  NAV: true,
  COMPOSE: true,
  EDITOR: true,
  MAP: true,
  KEYS: true,
  TAG: true,
  LIBRARY: true,
  FACTS: true,
  COMMANDS: true,
  SUMMARY: true,
  SETTINGS: true,
  ACTIONS: true,
  CHAPTERS: true,
  SEARCH: true,
  REQUEST: true,
  CARD: true,
  ARCHIVE: true,
  IMAGE: true,
  LOG: true,
  PROBS: true,
  RECORD: true,
  ASIDE: true,
  PLACE: true
} satisfies Record<AppMode, true>) as AppMode[];

function ctrlP(): KeyEvent {
  return {
    name: "p",
    sequence: "\u0010",
    shift: false,
    ctrl: true,
    meta: false,
    option: false,
    super: false
  } as KeyEvent;
}

async function typeQuery(
  press: (event: ReturnType<typeof key>) => Promise<void>,
  query: string
): Promise<void> {
  for (const character of query) await press(key(character));
}

describe("global command palette", () => {
  for (const mode of ["PROBS", "RECORD"] as const) {
    test(`Fact palette entry points from ${mode} use the displayed take`, async () => {
      for (const query of ["new Fact from here", "new Fact State", "end Fact here"] as const) {
        const source = demoAppSource();
        const state = initialState(source, false);
        const cache = createWrapCache<ProseStyle>();
        const view = createStoryViewModel(state.payload);
        const stale = view.parts.at(-1);
        const displayed = view.parts[1];
        if (stale === undefined || displayed === undefined) throw new Error("demo story needs two parts");
        state.focusIndex = rowIndexForNode(view, stale.id);
        if (mode === "PROBS") {
          state.probs = {
            nodeId: displayed.id,
            tokenIndex: 0,
            altIndex: 0,
            expanded: false,
            record: null,
            loading: false,
            empty: null
          };
        } else {
          state.record = {
            nodeId: displayed.id,
            returnMode: "NAV",
            list: { status: "ready", summaries: [] },
            eventIndex: 0,
            entryIndex: 0,
            scrollTop: -1,
            detail: { status: "idle" },
            cache: createGenerationRecordDetailCache()
          };
        }
        state.mode = mode;

        expect(factsOpeningPartId(state)).toBe(displayed.id);
        await handleKey(
          ctrlP(), state, source, cache,
          () => undefined, async () => undefined, () => undefined
        );
        await typeQuery(
          (event) => handleKey(
            event, state, source, cache,
            () => undefined, async () => undefined, () => undefined
          ),
          query
        );
        await handleKey(
          key("return", { sequence: "\r" }), state, source, cache,
          () => undefined, async () => undefined, () => undefined
        );

        if (query === "new Fact from here") {
          expect(state.mode).toBe("EDITOR");
          expect(state.editor?.kind).toBe("fact");
          if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
          expect(state.editor.factAnchorPartId).toBe(displayed.id);
        } else {
          expect(state.mode).toBe("FACTS");
          expect(state.facts?.pendingFactAction).toEqual({
            kind: query === "new Fact State" ? "new-state" : "end",
            anchorPartId: displayed.id
          });
        }
      }
    });
  }

  test("Fact palette entry points from MAP use the visible tree cursor", async () => {
    for (const [query, kind] of [
      ["new Fact from here", "new"],
      ["new Fact State", "state"],
      ["end Fact here", "end"]
    ] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      state.focusIndex = rowIndexForNode(
        createStoryViewModel(state.payload),
        state.payload.path.at(-1)!.id
      );
      openMap(state);
      if (state.map === null) throw new Error("Map did not open");
      state.map.view = "tree";
      const mapCursorId = state.payload.path[0]!.id;
      state.map.treeCursorId = mapCursorId;

      await handleKey(
        ctrlP(), state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );
      await typeQuery(
        (event) => handleKey(
          event, state, source, cache,
          () => undefined, async () => undefined, () => undefined
        ),
        query
      );
      await handleKey(
        key("return", { sequence: "\r" }), state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );

      if (kind === "new") {
        expect(state.mode).toBe("EDITOR");
        expect(state.editor?.kind).toBe("fact");
        if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
        expect(state.editor.factAnchorPartId).toBe(mapCursorId);
        expect(state.editor.factScopeAnchorPartId).toBe(mapCursorId);
      } else {
        expect(state.mode).toBe("FACTS");
        await handleKey(
          key("return", { sequence: "\r" }), state, source, cache,
          () => undefined, async () => undefined, () => undefined
        );
        expect(state.mode).toBe("EDITOR");
        if (state.editor?.kind !== "fact") throw new Error("Fact State editor did not open");
        expect(state.editor.stateAnchorPartId).toBe(mapCursorId);
        expect(state.editor.stateCursorAnchorId).toBe(mapCursorId);
        expect(state.editor.stateIsEnd).toBe(kind === "end");
      }
    }
  });

  test("Fact palette entry points from MAP use path and mass visible cursors", async () => {
    for (const view of ["path", "mass"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      openMap(state);
      if (state.map === null) throw new Error("Map did not open");
      state.map.view = view;
      state.map.pathCursorId = state.payload.path[0]!.id;
      // Mass compresses a contiguous line into its visible endpoint row. The
      // stale tree cursor deliberately differs so this catches a direct
      // `treeCursorId` read in palette entry points.
      state.map.treeCursorId = state.payload.path[0]!.id;
      const anchor = mapCursorNodeId(state);
      expect(anchor).not.toBeNull();
      expect(factsOpeningPartId(state)).toBe(anchor);

      await handleKey(
        ctrlP(), state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );
      await typeQuery(
        (event) => handleKey(
          event, state, source, cache,
          () => undefined, async () => undefined, () => undefined
        ),
        "new Fact from here"
      );
      await handleKey(
        key("return", { sequence: "\r" }), state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );

      expect(state.mode).toBe("EDITOR");
      if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
      expect(state.editor.factAnchorPartId).toBe(anchor);
      expect(state.editor.factScopeAnchorPartId).toBe(anchor);
    }
  });

  test("MAP retake uses the visible cursor instead of stale story focus", async () => {
    const cases = [
      { view: "path", target: "p1" },
      { view: "tree", target: "p1" },
      { view: "mass", target: "p5-alt" }
    ] as const;

    for (const { view, target } of cases) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const storyView = createStoryViewModel(state.payload);
      state.focusIndex = rowIndexForNode(storyView, "p13");
      openMap(state);
      if (state.map === null) throw new Error("Map did not open");
      state.map.view = view;
      if (view === "path") state.map.pathCursorId = target;
      else state.map.treeCursorId = target;
      expect(mapCursorNodeId(state)).toBe(target);
      expect(storyView.rows[state.focusIndex]?.id).toBe("p13");

      const targets: unknown[] = [];
      source.api.continueStory = async (_storyId, _instruction, _genId, requestTarget) => {
        targets.push(requestTarget);
        return { payload: state.payload, droppedFacts: [] };
      };
      const press = (event: KeyEvent) => handleKey(
        event, state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );
      await press(ctrlP());
      await typeQuery(press, "retake");
      await press(key("return", { sequence: "\r" }));
      for (let waited = 0; (state.stream !== null || state.abort !== null) && waited < 100; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const targetParentId = source.payload.nodes.find(({ id }) => id === target)?.parentId;
      expect(targets).toEqual([{ parentId: targetParentId }]);
    }
  });

  test("MAP retake refuses a folded cold row without a paid call", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p13");
    openMap(state);
    if (state.map === null) throw new Error("Map did not open");
    state.map.view = "tree";
    state.map.treeCursorId = "p5-alt";
    expect(mapCursorNodeId(state)).toBeNull();

    let calls = 0;
    const continueStory = source.api.continueStory.bind(source.api);
    source.api.continueStory = async (...args) => {
      calls += 1;
      return continueStory(...args);
    };
    const press = (event: KeyEvent) => handleKey(
      event, state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );
    await press(ctrlP());
    await typeQuery(press, "retake");
    await press(key("return", { sequence: "\r" }));

    expect(calls).toBe(0);
    expect(state.mode).toBe("MAP");
    expect(state.map?.treeCursorId).toBe("p5-alt");
    expect(state.toast).toBe("select a visible story part before retaking it");
  });

  test("MAP tag-line palette command opens the visible Tree and Mass cursor", async () => {
    for (const view of ["tree", "mass"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      openMap(state);
      if (state.map === null) throw new Error("Map did not open");
      state.map.view = view;
      state.map.pathCursorId = state.payload.path.at(-2)!.id;
      state.map.treeCursorId = state.payload.path[0]!.id;
      const visibleId = mapCursorNodeId(state);
      expect(visibleId).not.toBeNull();
      expect(visibleId).not.toBe(state.map.pathCursorId);
      const expectedNodeId = rememberedLeafId(state.payload, visibleId!);

      const press = (event: KeyEvent) => handleKey(
        event, state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );
      await press(ctrlP());
      await typeQuery(press, "tag this line");
      await press(key("return", { sequence: "\r" }));

      expect(state.mode).toBe("TAG");
      expect(state.tag?.nodeId).toBe(expectedNodeId);
      expect(state.tag?.returnMode).toBe("MAP");
    }
  });

  test("MAP tag-line refuses a folded cold row without falling back to Path", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    openMap(state);
    if (state.map === null) throw new Error("Map did not open");
    state.map.view = "tree";
    const pathCursorId = state.payload.path.at(-1)!.id;
    state.map.pathCursorId = pathCursorId;
    // The demo's old alternate is a visible cold fold in Tree. It has no
    // single addressable take while folded, so do not tag the Path cursor.
    state.map.treeCursorId = "p5-alt";
    expect(mapCursorNodeId(state)).toBeNull();

    const press = (event: KeyEvent) => handleKey(
      event, state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );
    await press(ctrlP());
    await typeQuery(press, "tag this line");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("MAP");
    expect(state.tag).toBeNull();
    expect(state.map?.pathCursorId).toBe(pathCursorId);
    expect(state.toast).toBe("select a story part before tagging it");
  });

  test("new Fact palette commands from FACTS return to the same Facts context after cancel", async () => {
    for (const query of ["new unscoped fact", "new Fact from here", "new Fact from selection"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const facts = {
        cursor: 0,
        query: "Maren",
        chip: 2,
        selectedTag: "people",
        filtering: false,
        deleteArmedId: null,
        scopeFilter: "everywhere" as const,
        dossier: { factId: "fact-1", stateIndex: 0, diff: true }
      };
      state.facts = facts;
      state.mode = "FACTS";
      if (query === "new Fact from selection") {
        const node = state.payload.path.find(({ id }) => id === "p1")!;
        const text = node.text.slice(0, 5);
        state.storySelectionProjection = [...text].map((_, index) => ({
          key: "p1:text",
          text: node.text,
          start: index,
          end: index + 1
        }));
      }

      const renderer = query === "new Fact from selection"
        ? { identity: {}, text: "Maren", range: { start: 0, end: 5 }, backward: false }
        : null;
      await handleKey(
        ctrlP(), state, source, cache,
        () => undefined, async () => undefined, () => undefined,
        renderer as never
      );
      await typeQuery(
        (event) => handleKey(
          event, state, source, cache,
          () => undefined, async () => undefined, () => undefined
        ),
        query
      );
      await handleKey(
        key("return", { sequence: "\r" }), state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );

      expect(state.mode).toBe("EDITOR");
      expect(state.facts).toBe(facts);
      expect(state.editor?.kind).toBe("fact");
      expect(state.editor?.returnMode).toBe("FACTS");
      await handleKey(
        key("escape", { sequence: "\u001b" }), state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );
      expect(state.mode).toBe("FACTS");
      expect(state.facts).toBe(facts);
      expect(state.facts).toEqual({
        cursor: 0,
        query: "Maren",
        chip: 2,
        selectedTag: "people",
        filtering: false,
        deleteArmedId: null,
        scopeFilter: "everywhere",
        dossier: { factId: "fact-1", stateIndex: 0, diff: true }
      });
    }
  });

  test("new Fact palette commands from FACTS return to the same Facts context after save", async () => {
    for (const query of ["new unscoped fact", "new Fact from here", "new Fact from selection"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const facts = {
        cursor: 0,
        query: "Maren",
        chip: 2,
        selectedTag: "people",
        filtering: false,
        deleteArmedId: null,
        scopeFilter: "everywhere" as const,
        dossier: { factId: "fact-1", stateIndex: 0, diff: true }
      };
      state.facts = facts;
      state.mode = "FACTS";
      if (query === "new Fact from selection") {
        const node = state.payload.path.find(({ id }) => id === "p1")!;
        const text = node.text.slice(0, 5);
        state.storySelectionProjection = [...text].map((_, index) => ({
          key: "p1:text",
          text: node.text,
          start: index,
          end: index + 1
        }));
      }

      const renderer = query === "new Fact from selection"
        ? { identity: {}, text: "Maren", range: { start: 0, end: 5 }, backward: false }
        : null;
      await handleKey(
        ctrlP(), state, source, cache,
        () => undefined, async () => undefined, () => undefined,
        renderer as never
      );
      await typeQuery(
        (event) => handleKey(
          event, state, source, cache,
          () => undefined, async () => undefined, () => undefined
        ),
        query
      );
      await handleKey(
        key("return", { sequence: "\r" }), state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );

      if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
      if (query !== "new Fact from selection") setComposerText(state.editor.composer, "created from Facts");
      await handleKey(
        key("s", { sequence: String.fromCharCode(0x13), ctrl: true }),
        state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );

      expect(state.mode).toBe("FACTS");
      expect(state.facts).toBe(facts);
      expect(state.facts).toEqual({
        cursor: 0,
        query: "Maren",
        chip: 2,
        selectedTag: "people",
        filtering: false,
        deleteArmedId: null,
        scopeFilter: "everywhere",
        dossier: { factId: "fact-1", stateIndex: 0, diff: true }
      });
    }
  });

  test("selection-based Fact commands survive a rendered Facts frame", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const width = 100;
    const height = 24;

    // Build the real NAV projection first. This is the lifecycle path that a
    // mouse selection takes before the user opens Facts.
    const navFrame = renderStoryScreen(state, { width, height, wrapCache: cache });
    Object.assign(state, navFrame.derived);
    const projection = state.storySelectionProjection;
    const displayStart = projection?.findIndex((cell) => cell?.key.endsWith(":text")) ?? -1;
    const sourceCell = displayStart < 0 ? undefined : projection?.[displayStart];
    expect(sourceCell).toBeDefined();
    if (sourceCell == null) throw new Error("rendered story selection has no source cell");
    const selectedText = sourceCell.text.slice(sourceCell.start, sourceCell.start + 5);
    expect(displayStart).toBeGreaterThan(-1);

    const nativeSelection = {
      identity: {},
      text: selectedText,
      range: { start: displayStart, end: displayStart + selectedText.length },
      backward: false
    };
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => nativeSelection.text,
        selectedRenderables: [{ getSelection: () => nativeSelection.range }]
      }),
      clearSelection: () => undefined
    };

    state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null
    };
    state.mode = "FACTS";
    const factsFrame = renderStoryScreen(state, { width, height, wrapCache: cache });
    Object.assign(state, factsFrame.derived);
    expect(state.storySelectionProjection).not.toBeNull();

    const press = (event: KeyEvent) => handleKey(
      event,
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined,
      renderer as never
    );
    await press(ctrlP());
    expect(state.commands?.selection?.text).toBe(selectedText);

    // A palette frame replaces the visible page. Keep the Facts projection
    // through cancel so a second Ctrl-P can capture the same native range.
    Object.assign(state, renderStoryScreen(state, { width, height, wrapCache: cache }).derived);
    expect(state.storySelectionProjection).not.toBeNull();
    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("FACTS");
    Object.assign(state, renderStoryScreen(state, { width, height, wrapCache: cache }).derived);
    expect(state.storySelectionProjection).not.toBeNull();
    await press(ctrlP());
    expect(state.commands?.selection?.text).toBe(selectedText);

    await typeQuery(press, "new Fact from selection");
    expect(state.commands?.selectedId).toBe("new-fact-from-selection");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("fact");
    expect(state.editor?.composer.text).toBe(selectedText);
  });

  test("summary rows hide anchored Fact commands for matching, rendering, keyboard, and mouse", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const summaryIndex = createStoryViewModel(state.payload).rows
      .findIndex((row) => row.kind === "chapter-summary");
    expect(summaryIndex).toBeGreaterThan(-1);
    state.focusIndex = summaryIndex;
    expect(factsOpeningPartId(state)).toBeNull();

    const press = (event: KeyEvent) => handleKey(
      event,
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined
    );
    await press(ctrlP());
    await typeQuery(press, "new Fact from here");
    expect(state.commands?.selectedId).not.toBe("new-fact-from-here");

    const frame = renderStoryScreen(state, { width: 100, height: 24, wrapCache: cache });
    Object.assign(state, frame.derived);
    expect(frameText(frame.lines)).not.toContain("create a Fact scoped to the focused story part");
    expect(state.hitRows.some((hit) => hit?.target.kind === "list")).toBeFalse();
    expect(mouseToAction({
      type: "down",
      button: 0,
      x: 50,
      y: 10,
      modifiers: { shift: false, alt: false, ctrl: false }
    } as never, state)).toBeNull();

    await press(key("return", { sequence: "\r" }));
    expect(state.mode).toBe("COMMANDS");
    expect(state.editor).toBeNull();
  });

});

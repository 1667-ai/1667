import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { openArchiveImport } from "../src/archive-import-actions.js";
import { openCardImport } from "../src/card-import-actions.js";
import { dispatch, handleKey, initialState } from "../src/app.js";
import type { ActionContext } from "../src/action-context.js";
import { createAsideSurface } from "../src/aside-surface.js";
import { demoAppSource } from "../src/demo.js";
import {
  FROM_ASIDE_INSTRUCTION,
  openPlacementFromAside
} from "../src/aside-placement.js";
import { openAsideUseMenu } from "../src/aside-use.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { setComposerText } from "../src/composer-model.js";
import { draftImagesFor } from "../src/draft-image.js";
import { searchRows } from "../src/search-model.js";
import { openTag } from "../src/story-actions.js";
import { PNG_SIGNATURE } from "../../shared/png-text-chunk.js";
import type { ProseStyle } from "../src/wrap.js";
import { createWrapCache } from "../src/wrap.js";
import { openLibrary } from "../src/library-actions.js";
import { openGenerationRecordViewer } from "../src/generation-record-actions.js";
import { renderStoryScreen } from "../src/screens/story.js";

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function ctrlP(): KeyEvent {
  return key("p", { sequence: "\u0010", ctrl: true });
}

function key(
  name: string,
  options: { sequence?: string; ctrl?: boolean; shift?: boolean } = {}
): KeyEvent {
  return {
    name,
    sequence: options.sequence ?? name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: false,
    option: false,
    super: false
  } as KeyEvent;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function typeQuery(
  press: (event: KeyEvent) => Promise<void>,
  query: string
): Promise<void> {
  for (const character of query) await press(key(character));
}

function minimalPng(width = 64, height = 48): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set(PNG_SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function testHarness(renderer: ActionContext["renderer"] = null) {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const press = (event: KeyEvent) => handleKey(
    event,
    state,
    source,
    cache,
    () => undefined,
    async () => undefined,
    () => undefined,
    renderer,
    () => undefined,
    () => undefined,
    backend
  );
  const context = {
    backend,
    cache,
    repaint: () => undefined,
    renderer,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };
  return { source, state, press, context };
}

/** A NativeSelectionSnapshot in CliRenderer's clothing. The selection reader
 * treats this plain object as the captured renderer state. */
function stubSelectionRenderer(text: string): ActionContext["renderer"] {
  return { identity: {}, text, range: { start: 0, end: text.length }, backward: false } as never;
}

describe("palette async settlement", () => {
  test("keeps a palette opened during a same-story Search reroute", async () => {
    const { source, state, press } = testHarness();
    source.searchDebounceMs = 0;
    await press(key("/"));
    await typeQuery(press, "pantry");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const search = state.search;
    if (search === null || search.response === null) throw new Error("search did not settle");
    const hitRow = searchRows(search, state.payload).rows.find(
      (row) => row.kind === "hit"
        && !state.payload.path.some((node) => node.id === row.hit.targetId)
    );
    if (hitRow?.kind !== "hit") throw new Error("off-line Search hit did not appear");
    search.cursor = hitRow.select;

    const entered = deferred<void>();
    const release = deferred<void>();
    const switchLine = source.api.switchLine;
    source.api.switchLine = async (...args) => {
      entered.resolve();
      await release.promise;
      return switchLine(...args);
    };

    const opening = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    const palette = state.commands;
    expect(state.mode).toBe("COMMANDS");
    expect(palette?.returnMode).toBe("SEARCH");

    release.resolve();
    await opening;

    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(palette);
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.search).toBeNull();
    expect(state.focusIndex).toBe(rowIndexForNode(createStoryViewModel(state.payload), hitRow.hit.targetId));

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("keeps a palette opened during a same-story Map reroute", async () => {
    const { source, state, press } = testHarness();
    state.map = {
      view: "path",
      pathCursorId: "p5-alt",
      pathShowAllTakes: true,
      treeCursorId: state.payload.path.at(-1)?.id ?? "p13",
      rowIds: [],
      showSketches: true,
      openedColdFolds: new Set<string>(),
      massSort: "size"
    };
    state.mode = "MAP";

    const entered = deferred<void>();
    const release = deferred<void>();
    const switchLine = source.api.switchLine;
    source.api.switchLine = async (...args) => {
      entered.resolve();
      await release.promise;
      return switchLine(...args);
    };

    const opening = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    const palette = state.commands;
    expect(state.mode).toBe("COMMANDS");
    expect(palette?.returnMode).toBe("MAP");

    release.resolve();
    await opening;

    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(palette);
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.map).toBeNull();
    expect(state.payload.path.at(-1)?.id).toBe("p5-alt");
    expect(state.focusIndex).toBe(rowIndexForNode(createStoryViewModel(state.payload), "p5-alt"));

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("retake from PROBS uses the displayed take, not stale NAV focus", async () => {
    const { source, state, press } = testHarness();
    const view = createStoryViewModel(state.payload);
    const first = view.parts[0];
    const displayed = view.parts[1];
    if (first === undefined || displayed === undefined) throw new Error("demo story needs two parts");
    state.focusIndex = rowIndexForNode(view, first.id);
    let retakeTarget: unknown = null;
    source.api.continueStory = async (_storyId, _instruction, _genId, target) => {
      retakeTarget = target;
      return { payload: state.payload, droppedFacts: [] };
    };

    await press(key("l"));
    expect(state.mode).toBe("PROBS");
    await press(key("tab"));
    expect(state.probs?.nodeId).toBe(displayed.id);
    expect(state.focusIndex).toBe(rowIndexForNode(view, first.id));

    await press(ctrlP());
    await typeQuery(press, "retake");
    expect(state.commands?.selectedId).toBe("retake");
    await press(key("return", { sequence: "\r" }));

    expect(retakeTarget).toEqual({ parentId: displayed.node.parentId });
    expect(state.mode).toBe("NAV");
    expect(state.probs).toBeNull();
  });

  test("retake from RECORD uses the displayed take, not stale NAV focus", async () => {
    const { source, state, press, context } = testHarness();
    const view = createStoryViewModel(state.payload);
    const stale = view.parts.at(-1);
    const displayed = view.parts[1];
    if (stale === undefined || displayed === undefined) throw new Error("demo story needs two parts");
    state.focusIndex = rowIndexForNode(view, stale.id);
    state.map = {
      view: "path",
      pathCursorId: displayed.id,
      pathShowAllTakes: true,
      treeCursorId: stale.id,
      rowIds: [],
      showSketches: true,
      openedColdFolds: new Set<string>(),
      massSort: "size"
    };
    state.mode = "MAP";
    await openGenerationRecordViewer(state, source, context);
    const parentMap = state.map;
    expect(state.mode).toBe("RECORD");
    expect(state.record?.nodeId).toBe(displayed.id);
    expect(parentMap).not.toBeNull();
    expect(state.focusIndex).toBe(rowIndexForNode(view, stale.id));

    let retakeTarget: unknown = null;
    source.api.continueStory = async (_storyId, _instruction, _genId, target) => {
      retakeTarget = target;
      return { payload: state.payload, droppedFacts: [] };
    };

    await press(ctrlP());
    await typeQuery(press, "retake");
    expect(state.commands?.selectedId).toBe("retake");
    await press(key("return", { sequence: "\r" }));

    expect(retakeTarget).toEqual({ parentId: displayed.node.parentId });
    expect(state.mode).toBe("NAV");
    expect(state.record).toBeNull();
    expect(state.map).toBeNull();
  });

  test("does not retake after a Map reroute loses ownership", async () => {
    for (const interruption of ["escape", "palette"] as const) {
      const { source, state, press } = testHarness();
      state.map = {
        view: "path",
        pathCursorId: "p5-alt",
        pathShowAllTakes: true,
        treeCursorId: state.payload.path.at(-1)?.id ?? "p13",
        rowIds: [],
        showSketches: true,
        openedColdFolds: new Set<string>(),
        massSort: "size"
      };
      state.mode = "MAP";

      const entered = deferred<void>();
      const release = deferred<void>();
      const switchLine = source.api.switchLine;
      source.api.switchLine = async (...args) => {
        entered.resolve();
        await release.promise;
        return switchLine(...args);
      };
      let retakeCalls = 0;
      const payload = state.payload;
      source.api.continueStory = async () => {
        retakeCalls += 1;
        return { payload, droppedFacts: [] };
      };

      await press(ctrlP());
      await typeQuery(press, "retake");
      const pending = press(key("return", { sequence: "\r" }));
      await entered.promise;

      let newerPalette: typeof state.commands = null;
      if (interruption === "escape") {
        await press(key("escape", { sequence: "\u001b" }));
        expect(state.mode).toBe("NAV");
        expect(state.map).toBeNull();
      } else {
        await press(ctrlP());
        newerPalette = state.commands;
        expect(state.mode).toBe("COMMANDS");
        expect(newerPalette).not.toBeNull();
        expect(newerPalette?.returnMode).toBe("MAP");
      }

      release.resolve();
      await pending;

      // The switch response is still adopted, but it cannot buy a retake
      // after another interaction owns the landing surface.
      expect(state.payload.path.at(-1)?.id).toBe("p5-alt");
      expect(retakeCalls).toBe(0);
      if (interruption === "palette") {
        expect(state.mode).toBe("COMMANDS");
        expect(state.commands).toBe(newerPalette);
      } else {
        expect(state.mode).toBe("NAV");
        expect(state.map).toBeNull();
      }
    }
  });

  test("retakes after a render replaces the Map owner during reroute", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const repaint = () => {
      const frame = renderStoryScreen(state, {
        width: 100,
        height: 30,
        wrapCache: cache
      });
      Object.assign(state, frame.derived);
    };
    const backend = new ActionRuntime(state, repaint);
    const press = (event: KeyEvent) => handleKey(
      event, state, source, cache, repaint,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      () => undefined,
      backend
    );
    state.map = {
      view: "path",
      pathCursorId: "p5-alt",
      pathShowAllTakes: true,
      treeCursorId: state.payload.path.at(-1)?.id ?? "p13",
      rowIds: [],
      showSketches: true,
      openedColdFolds: new Set<string>(),
      massSort: "size"
    };
    state.mode = "MAP";
    const mapBeforeReroute = state.map;
    const entered = deferred<void>();
    const release = deferred<void>();
    const switchLine = source.api.switchLine;
    source.api.switchLine = async (...args) => {
      entered.resolve();
      await release.promise;
      return switchLine(...args);
    };
    const targets: unknown[] = [];
    source.api.continueStory = async (_storyId, _instruction, _genId, target) => {
      targets.push(target);
      return { payload: state.payload, droppedFacts: [] };
    };

    await press(ctrlP());
    await typeQuery(press, "retake");
    const pending = press(key("return", { sequence: "\r" }));
    await entered.promise;

    // ActionRuntime's task-start repaint commits renderMap's derived clone.
    expect(state.map).not.toBe(mapBeforeReroute);
    release.resolve();
    await pending;

    const targetParentId = source.payload.nodes.find(({ id }) => id === "p5-alt")?.parentId;
    expect(targets).toEqual([{ parentId: targetParentId }]);
    expect(state.mode).toBe("NAV");
    expect(state.map).toBeNull();
  });

  test("keeps a palette opened during a Fact dossier anchor reroute", async () => {
    const { source, state, press } = testHarness();
    const fact = {
      ...state.payload.facts[0]!,
      id: "fact-anchor-reroute",
      states: [
        { id: "fact-anchor-base", text: "base", createdAt: "now", updatedAt: "now" },
        {
          id: "fact-anchor-state",
          anchorPartId: "p5-alt",
          text: "anchored",
          createdAt: "now",
          updatedAt: "now"
        }
      ]
    };
    state.payload = { ...state.payload, facts: [fact] };
    const facts = state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null,
      scopeFilter: "everywhere" as const,
      dossier: { factId: fact.id, stateIndex: 1, diff: false }
    };
    state.mode = "FACTS";

    const entered = deferred<void>();
    const release = deferred<void>();
    const switchLine = source.api.switchLine;
    source.api.switchLine = async (...args) => {
      entered.resolve();
      await release.promise;
      const payload = await switchLine(...args);
      return { ...payload, facts: [fact] };
    };

    const opening = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    const palette = state.commands;
    expect(state.mode).toBe("COMMANDS");
    expect(palette?.returnMode).toBe("FACTS");

    release.resolve();
    await opening;

    expect(state.mode).toBe("COMMANDS");
    expect(state.commands).toBe(palette);
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.facts).toBeNull();
    expect(state.payload.path.at(-1)?.id).toBe("p5-alt");
    expect(state.focusIndex).toBe(rowIndexForNode(createStoryViewModel(state.payload), "p5-alt"));
    expect(facts.dossier).toEqual({ factId: fact.id, stateIndex: 1, diff: false });

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("keeps the palette visible after a Library create settles", async () => {
    const { source, state, press, context } = testHarness();
    await openLibrary(state, source, context);
    const library = state.library;
    if (library === null) throw new Error("library did not open");

    const entered = deferred<void>();
    const release = deferred<void>();
    const createStory = source.api.createStory;
    source.api.createStory = async (...args) => {
      entered.resolve();
      await release.promise;
      return createStory(...args);
    };

    const creating = press(key("n"));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("LIBRARY");
    state.commands!.selection = {
      text: "old story text",
      spans: [{ key: "p12:text", text: "old story text", start: 0, end: 15 }]
    };

    release.resolve();
    await creating;
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.commands?.selection ?? null).toBeNull();
    expect(state.library).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
  });

  test("keeps the palette visible after deleting the current Library story and adopting its fallback", async () => {
    const { source, state, press, context } = testHarness();
    await openLibrary(state, source, context);
    const library = state.library;
    if (library === null) throw new Error("library did not open");
    const current = library.stories.find(({ id }) => id === state.payload.id);
    if (current === undefined) throw new Error("current story is not in the library");
    library.cursor = library.stories.findIndex(({ id }) => id === current.id);
    await press(key("d", { sequence: "D", shift: true }));
    if (library.prompt?.kind !== "delete") throw new Error("delete prompt did not open");

    const fallback = {
      ...structuredClone(state.payload),
      id: "fallback-story",
      title: "Fallback story"
    };
    const entered = deferred<void>();
    const release = deferred<void>();
    source.api.deleteStory = async () => {
      entered.resolve();
      await release.promise;
      return { ok: true };
    };
    source.api.listStories = async () => [{
      id: fallback.id,
      title: fallback.title,
      updatedAt: fallback.updatedAt,
      partCount: fallback.nodes.length,
      words: fallback.path.reduce((total, node) => total + node.text.length, 0),
      forked: false,
      lineCount: 1
    }];
    source.api.loadStory = async (storyId) => {
      expect(storyId).toBe(fallback.id);
      return fallback;
    };
    library.prompt.value = current.title;

    const deleting = press(key("return", { sequence: "\r" }));
    await entered.promise;
    await press(ctrlP());
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("LIBRARY");
    state.commands!.selection = {
      text: "old story text",
      spans: [{ key: "p12:text", text: "old story text", start: 0, end: 15 }]
    };

    release.resolve();
    await deleting;
    expect(state.payload.id).toBe(fallback.id);
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.returnMode).toBe("NAV");
    expect(state.commands?.selection ?? null).toBeNull();
    expect(state.library).toBeNull();

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.commands).toBeNull();
    expect(state.payload.id).toBe(fallback.id);
  });});

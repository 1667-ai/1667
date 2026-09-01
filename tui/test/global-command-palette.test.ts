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
  test("Ctrl+P opens from every app mode, remains idempotent, and Escape restores the owner", async () => {
    for (const mode of APP_MODES) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const press = (event: KeyEvent) => handleKey(
        event,
        state,
        source,
        cache,
        () => undefined,
        async () => undefined,
        () => undefined
      );

      if (mode === "COMMANDS") {
        state.mode = "COMMANDS";
        state.commands = {
          query: "facts",
          cursor: 2,
          selectedId: "facts",
          view: "commands",
          returnMode: "ASIDE"
        };
        const existing = state.commands;
        await press(ctrlP());
        expect(state.commands).toBe(existing);
        expect(state.commands.query).toBe("facts");
        expect(state.commands.returnMode).toBe("ASIDE");
        continue;
      }

      state.mode = mode;
      await press(ctrlP());
      expect(state.mode).toBe("COMMANDS");
      expect(state.commands?.returnMode).toBe(mode);
      await press(ctrlP());
      expect(state.commands?.returnMode).toBe(mode);
      await press(key("escape", { sequence: "\u001b" }));
      expect(state.mode).toBe(mode);
      expect(state.commands).toBeNull();
    }
  });

  test("every Fact workflow has a contextual command", () => {
    const state = initialState(demoAppSource(), false);
    const base = {
      connectionDown: false,
      requestActive: false,
      canRewriteSelection: false,
      hasStoryPart: true,
      hasStorySelection: true
    };
    const contexts = [
      base,
      { ...base, factsPanel: true, factsSelected: true, factsCanMoveUp: true, factsCanMoveDown: true },
      { ...base, factsPanel: true, factsFiltering: true },
      { ...base, factsPanel: true, factsDossier: true, factsSelected: true },
      {
        ...base,
        factEditor: true,
        factEditorStateful: true,
        factEditorHasState: true,
        factEditorStateCreating: false,
        factEditorCanOpenAnchor: true,
        factEditorCanDeleteState: true
      },
      { ...base, mapTree: true, mapFactLens: false },
      { ...base, mapTree: true, mapFactLens: true }
    ];
    const available = new Set<CommandId>();
    for (const context of contexts) {
      for (const { command } of commandMatches("", false, commandContext(state.payload, context))) {
        available.add(command.id);
      }
    }

    const factCommands: CommandId[] = [
      "facts",
      "new-fact",
      "new-fact-from-here",
      "new-fact-from-selection",
      "edit-fact",
      "new-fact-state",
      "end-fact-here",
      "facts-open-selected",
      "facts-filter",
      "facts-cycle-tag",
      "facts-clear-filter",
      "facts-cycle-scope",
      "facts-delete",
      "facts-move-up",
      "facts-move-down",
      "facts-open-anchor",
      "facts-edit-state",
      "facts-dossier-previous-state",
      "facts-dossier-next-state",
      "facts-toggle-diff",
      "fact-editor-toggle-view",
      "fact-editor-previous-state",
      "fact-editor-next-state",
      "fact-editor-new-state",
      "fact-editor-open-anchor",
      "fact-editor-reanchor-state",
      "fact-editor-convert-state",
      "fact-editor-delete-state",
      "map-open-fact-lens",
      "map-cycle-fact-lens",
      "map-close-fact-lens",
      "map-open-fact-lens-anchor",
      "map-edit-fact-lens",
      "facts-budget"
    ];
    expect(factCommands.filter((id) => !available.has(id))).toEqual([]);
  });

  test("palette destinations release the suspended transient owner", async () => {
    const first = editorHarness();
    await first.press(key("x"));
    await first.press(ctrlP());
    await typeQuery(first.press, "facts overview");
    await first.press(key("return", { sequence: "\r" }));
    expect(first.state.mode).toBe("FACTS");
    expect(first.state.actions).toBeNull();

    const second = editorHarness();
    await second.press(key("f"));
    await second.press(ctrlP());
    await typeQuery(second.press, "chapters");
    await second.press(key("return", { sequence: "\r" }));
    expect(second.state.mode).toBe("CHAPTERS");
    expect(second.state.facts).toBeNull();
    expect(second.state.chapters).not.toBeNull();
  });

  test("same-mode palette destinations clear an open text-actions menu", async () => {
    const { source, state, cache, press } = editorHarness();
    state.mode = "COMPOSE";
    const composer = state.composer;
    openTextActions(state);
    expect(state.textActions).not.toBeNull();

    await press(ctrlP());
    // The transient menu stays captured for Escape restoration. Select the
    // destination through the palette's normal dispatch path.
    if (state.commands === null) throw new Error("palette did not open");
    state.commands.query = "direct take";
    state.commands.cursor = 0;
    await dispatch(
      { action: "open-selected" }, state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.mode).toBe("COMPOSE");
    expect(state.composer).toBe(composer);
    expect(state.textActions).toBeNull();
  });

  test("read-only palette commands preserve an ACTIONS owner for Escape", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    openActions(state, state.focusIndex);
    const actions = state.actions;
    if (actions === null) throw new Error("Actions menu did not open");
    const press = (event: KeyEvent) => handleKey(
      event, state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );

    await press(ctrlP());
    await typeQuery(press, "open story folder");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("ACTIONS");
    expect(state.actions).toBe(actions);
    expect(state.toast).toBe(source.storyFolder);

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.actions).toBeNull();
  });

  test("MAP palette destinations keep the exact Map owner for child return routes", async () => {
    for (const destination of ["generation records", "tag this line"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      openMap(state);
      if (state.map === null) throw new Error("Map did not open");
      const map = state.map;

      const press = (event: KeyEvent) => handleKey(
        event, state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );
      await press(ctrlP());
      await typeQuery(press, destination);
      await press(key("return", { sequence: "\r" }));

      expect(state.map).toBe(map);
      expect(state.mode).toBe(destination === "generation records" ? "RECORD" : "TAG");
      if (destination === "generation records") expect(state.record?.returnMode).toBe("MAP");
      else expect(state.tag?.returnMode).toBe("MAP");

      await press(key("escape", { sequence: "\u001b" }));
      expect(state.mode).toBe("MAP");
      expect(state.map).toBe(map);
    }
  });

  test("a Placement-held Aside draft blocks palette destinations and survives cancel", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "answer to place" }],
      null,
      state.payload.path.at(-1)?.id ?? null
    );
    setComposerText(surface.composer, "keep this unsent question");
    state.aside = surface;
    state.mode = "ASIDE";
    expect(openAsideUseMenu(surface, 0, 0)).toBeTrue();
    expect(openPlacementFromAside(state)).toBeTrue();
    const placement = state.placement;
    expect(placement?.returnAside).toBe(surface);

    const press = (event: KeyEvent) => handleKey(
      event, state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );
    await press(ctrlP());
    await typeQuery(press, "facts overview");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("PLACE");
    expect(state.commands).toBeNull();
    expect(state.placement).toBe(placement);
    expect(state.placement?.returnAside.composer.text).toBe("keep this unsent question");
    expect(state.toast).toBe("finish or cancel current input first");

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("ASIDE");
    expect(state.aside).toBe(surface);
    expect(state.aside?.composer.text).toBe("keep this unsent question");
  });

  test("Summary paints above a dormant Facts panel during provider streaming", async () => {
    const { source, state, press } = editorHarness();
    await press(key("f"));
    await press(ctrlP());
    await typeQuery(press, "summary take");

    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => { release = resolve; });
    source.api.createSummaryTake = async () => {
      entered();
      await providerGate;
      return null;
    };

    const pending = press(key("return", { sequence: "\r" }));
    await providerEntered;
    expect(state.mode).toBe("SUMMARY");
    expect(state.summary).not.toBeNull();
    const frame = renderStoryScreen(state, { width: 100, height: 24 });
    expect(frameText(frame.lines)).toContain("summary take");
    expect(frameText(frame.lines)).not.toContain("Facts manager");
    release();
    await pending;
  });

  test("Summary settlement keeps the palette open and releases its owner", async () => {
    for (const outcome of ["success", "failure", "cancel"] as const) {
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
        null,
        () => undefined,
        () => undefined,
        backend
      );
      let entered!: () => void;
      const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const providerGate = new Promise<void>((resolve) => { release = resolve; });
      const leafId = state.payload.path.at(-1)!.id;
      source.api = {
        ...source.api,
        createSummaryTake: async () => {
          entered();
          await providerGate;
          if (outcome === "failure") throw new Error("summary failed");
          return outcome === "cancel" ? null : { nodeId: leafId, narrowedTo: null };
        }
      };

      await press(ctrlP());
      await typeQuery(press, "summary take");
      const running = press(key("return", { sequence: "\r" }));
      await providerEntered;
      expect(state.mode).toBe("SUMMARY");
      expect(state.summary).not.toBeNull();

      await press(ctrlP());
      expect(state.mode).toBe("COMMANDS");
      expect(state.commands?.returnMode).toBe("SUMMARY");
      if (outcome === "cancel") {
        cancelSummary(state);
        expect(state.mode).toBe("COMMANDS");
        expect(state.commands?.returnMode).toBe("NAV");
      }

      release();
      await running;
      expect(state.mode).toBe("COMMANDS");
      expect(state.commands?.returnMode).toBe("NAV");
      expect(state.summary).toBeNull();

      await press(key("escape", { sequence: "\u001b" }));
      expect(state.mode).toBe("NAV");
      expect(state.commands).toBeNull();
    }
  });

  test("Aside palette interaction preserves question restoration after null or failed Ask", async () => {
    for (const outcome of ["null", "failure"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const backend = new ActionRuntime(state, () => undefined);
      const aside = createAsideSurface(state.payload.id, state.payload.title);
      state.aside = aside;
      state.mode = "ASIDE";
      setComposerText(aside.composer, "restore this question");
      let finish!: (outcome: "null" | "failure") => void;
      const pendingAsk = new Promise<null>((resolve, reject) => {
        finish = (outcome) => outcome === "null"
          ? resolve(null)
          : reject(new Error("Aside failed"));
      });
      source.api = {
        ...source.api,
        askAside: async () => await pendingAsk
      };
      const press = (event: KeyEvent) => handleKey(
        event,
        state,
        source,
        cache,
        () => undefined,
        async () => undefined,
        () => undefined,
        null,
        () => undefined,
        () => undefined,
        backend
      );

      await press(key("return", { sequence: "\r" }));
      expect(aside.busy).toBeTrue();
      await press(ctrlP());
      expect(state.mode).toBe("COMMANDS");
      expect(state.commands?.returnMode).toBe("ASIDE");
      await press(key("x"));
      await press(key("down"));
      await press(key("escape", { sequence: "\u001b" }));
      expect(state.mode).toBe("ASIDE");
      expect(aside.composer.text).toBe("");

      finish(outcome);
      await backend.whenIdle();
      expect(aside.composer.text).toBe("restore this question");
      expect(aside.busy).toBeFalse();
    }
  });

  test("the palette paints over Aside and restores its draft", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    state.mode = "ASIDE";
    state.aside = createAsideSurface(state.payload.id, state.payload.title);
    setComposerText(state.aside.composer, "Keep this question");
    const aside = state.aside;

    await handleKey(
      ctrlP(), state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );
    const frame = renderStoryScreen(state, { width: 100, height: 24, wrapCache: cache });
    Object.assign(state, frame.derived);
    expect(frameText(frame.lines)).toContain("Search");
    expect(frameText(frame.lines)).toContain("COMMANDS");

    await handleKey(
      key("escape", { sequence: "\u001b" }), state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );
    expect(state.mode).toBe("ASIDE");
    expect(state.aside).toBe(aside);
    expect(state.aside.composer.text).toBe("Keep this question");
  });

  test("contextual commands belong only to the surface behind the palette", () => {
    const state = initialState(demoAppSource(), false);
    state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null,
      scopeFilter: "everywhere",
      dossier: null
    };
    state.mode = "COMMANDS";
    state.commands = {
      query: "",
      cursor: 0,
      selectedId: null,
      view: "commands",
      returnMode: "ASIDE"
    };

    expect(factsPaletteContext(state)).toEqual({
      factsPanel: false,
      factsDossier: false,
      factsFiltering: false,
      factsHasFilter: false,
      factsSelected: false,
      factsCanMoveUp: false,
      factsCanMoveDown: false,
      mapTree: false,
      mapFactLens: false
    });
  });

  test("a new Fact State context exposes the re-anchor command", () => {
    const state = initialState(demoAppSource(), false);
    const context = commandContext(state.payload, {
      connectionDown: false,
      requestActive: false,
      canRewriteSelection: false,
      factEditor: true,
      factEditorStateful: true,
      factEditorHasState: false,
      factEditorStateCreating: true
    });

    expect(commandMatches("reanchor state", false, context)
      .map(({ command }) => command.id))
      .toEqual(["fact-editor-reanchor-state"]);
  });

});


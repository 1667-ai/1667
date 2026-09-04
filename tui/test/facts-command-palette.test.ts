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
  PLACE: true,
  "FACT-CONSISTENCY": true
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
  test("a mouse click runs a contextual Facts command through the existing reducer", async () => {
    const { source, state, cache, press } = editorHarness();
    await press(key("f"));
    await press(ctrlP());
    await typeQuery(press, "filter facts");
    expect(state.commands?.selectedId).toBe("facts-filter");

    const frame = renderStoryScreen(state, { width: 100, height: 24, wrapCache: cache });
    Object.assign(state, frame.derived);
    const selected = state.hitRows
      .flatMap((hit, y) => [
        ...(hit?.target.kind === "list" && hit.target.selected === true
          ? [{ left: hit.left, y }]
          : []),
        ...(hit?.overrides ?? [])
          .filter((region) => region.target.kind === "list" && region.target.selected === true)
          .map((region) => ({ left: region.left, y }))
      ])
      .at(0);
    expect(selected).toBeDefined();
    const action = mouseToAction({
      type: "down",
      button: 0,
      x: selected!.left + 2,
      y: selected!.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    } as never, state);
    expect(action).toEqual({ action: "open-selected" });
    await dispatch(
      action!, state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );
    expect(state.mode).toBe("FACTS");
    expect(state.facts?.filtering).toBeTrue();
  });

  test("the re-anchor command operates the suspended Fact editor without replacing its draft", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
    const editor = state.editor;
    editor.stateAnchorPartId = null;
    editor.stateCursorAnchorId = state.payload.path.at(-1)?.id ?? null;

    await press(ctrlP());
    await typeQuery(press, "reanchor state");
    expect(state.commands?.selectedId).toBe("fact-editor-reanchor-state");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.stateAnchorPartId).toBe(editor.stateCursorAnchorId);
  });

  test("the re-anchor command operates a newly creating Fact State", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
    const editor = state.editor;
    editor.chromeFocus = "state";
    await press(key("s"));
    expect(editor.stateCreating).toBeTrue();
    expect(editor.stateId).toBeNull();
    const cursorAnchor = editor.stateCursorAnchorId;
    expect(cursorAnchor).not.toBeNull();
    editor.stateAnchorPartId = null;

    await press(ctrlP());
    await typeQuery(press, "reanchor state");
    expect(state.commands?.selectedId).toBe("fact-editor-reanchor-state");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.stateCreating).toBeTrue();
    expect(editor.stateId).toBeNull();
    expect(editor.stateAnchorPartId).toBe(cursorAnchor);
  });

  test("contextual Fact editor commands release a captured text menu", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
    const editor = state.editor;
    openTextActions(state);
    expect(state.textActions).not.toBeNull();

    await press(ctrlP());
    await typeQuery(press, "toggle Fact editor view");
    expect(state.commands?.selectedId).toBe("fact-editor-toggle-view");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(state.textActions).toBeNull();
    // Tab now reaches the Fact editor's view-controlled fields. Before the
    // cleanup, the captured text menu swallowed this key as a no-op.
    await press(key("tab"));
    expect(editor.focus).toBe("name");
  });

  test("contextual Facts and Map commands release captured text menus", async () => {
    {
      const { state, press } = editorHarness();
      await press(key("f"));
      openTextActions(state, undefined, null, undefined, true);
      expect(state.textActions).not.toBeNull();

      await press(ctrlP());
      await typeQuery(press, "filter Facts");
      expect(state.commands?.selectedId).toBe("facts-filter");
      await press(key("return", { sequence: "\r" }));

      expect(state.mode).toBe("FACTS");
      expect(state.facts?.filtering).toBeTrue();
      expect(state.textActions).toBeNull();
      await press(key("m"));
      expect(state.facts?.query).toBe("m");
    }

    {
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
      openMap(state);
      if (state.map === null) throw new Error("Map did not open");
      state.map.view = "tree";
      openTextActions(state, undefined, null, undefined, true);
      expect(state.textActions).not.toBeNull();

      await press(ctrlP());
      await typeQuery(press, "open Fact lens");
      expect(state.commands?.selectedId).toBe("map-open-fact-lens");
      await press(key("return", { sequence: "\r" }));

      expect(state.mode).toBe("MAP");
      expect(state.map?.factLensFactId).not.toBeNull();
      expect(state.textActions).toBeNull();
    }
  });

  test("dirty Settings refuse a palette destination and keep the draft owner", async () => {
    const { state, press } = settingsHarness();
    await openSettingsForm(press);
    await selectRow(press, state, "model");
    await press(key("return"));
    await press(key("x"));
    const settings = state.settings;

    await press(ctrlP());
    await typeQuery(press, "facts overview");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("SETTINGS");
    expect(state.settings).toBe(settings);
    expect(state.settings?.edit?.composer.text).toBe("x");
    expect(state.toast).toBe("save or cancel Settings changes first");
  });

  test("dirty non-Settings palette owners refuse destinations and preserve their input", async () => {
    const cases = [
      {
        name: "Aside question",
        mode: "ASIDE" as const,
        setup: (state: ReturnType<typeof initialState>) => {
          state.aside = createAsideSurface(state.payload.id, state.payload.title);
          setComposerText(state.aside.composer, "keep this question");
          state.mode = "ASIDE";
          return {
            owner: state.aside,
            input: () => state.aside?.composer.text
          };
        }
      },
      {
        name: "Card path",
        mode: "CARD" as const,
        setup: (state: ReturnType<typeof initialState>) => {
          state.card = {
            path: "/tmp/character-card.json",
            storyId: state.payload.id,
            candidates: [],
            error: null,
            returnMode: "NAV"
          };
          state.mode = "CARD";
          return {
            owner: state.card,
            input: () => state.card?.path
          };
        }
      },
      {
        name: "Archive path",
        mode: "ARCHIVE" as const,
        setup: (state: ReturnType<typeof initialState>) => {
          state.archive = {
            path: "/tmp/story.story",
            storyId: state.payload.id,
            candidates: [],
            error: null,
            returnMode: "NAV"
          };
          state.mode = "ARCHIVE";
          return {
            owner: state.archive,
            input: () => state.archive?.path
          };
        }
      },
      {
        name: "Image path",
        mode: "IMAGE" as const,
        setup: (state: ReturnType<typeof initialState>) => {
          state.image = {
            path: "/tmp/reference.png",
            storyId: state.payload.id,
            candidates: [],
            error: null,
            returnMode: "NAV"
          };
          state.mode = "IMAGE";
          return {
            owner: state.image,
            input: () => state.image?.path
          };
        }
      },
      {
        name: "Library rename",
        mode: "LIBRARY" as const,
        setup: (state: ReturnType<typeof initialState>) => {
          const target = state.payload;
          state.library = {
            stories: [{
              id: target.id,
              title: target.title,
              updatedAt: target.updatedAt,
              partCount: target.nodes.length,
              words: target.path.reduce((total, node) => total + node.text.length, 0),
              forked: false,
              lineCount: 1
            }],
            cursor: 0,
            query: "",
            prompt: {
              kind: "rename",
              composer: createComposer(`${target.title} draft`),
              targetId: target.id
            }
          };
          state.mode = "LIBRARY";
          return {
            owner: state.library,
            input: () => state.library?.prompt?.kind === "rename"
              ? state.library.prompt.composer.text
              : undefined
          };
        }
      }
    ];

    for (const scenario of cases) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const cache = createWrapCache<ProseStyle>();
      const retained = scenario.setup(state);
      await handleKey(
        ctrlP(), state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );
      await typeQuery(
        (event) => handleKey(
          event, state, source, cache,
          () => undefined, async () => undefined, () => undefined
        ),
        "chapters"
      );
      await handleKey(
        key("return", { sequence: "\r" }), state, source, cache,
        () => undefined, async () => undefined, () => undefined
      );

      expect(state.mode).toBe(scenario.mode);
      expect(state.commands).toBeNull();
      expect(state.library ?? state.aside ?? state.card ?? state.archive ?? state.image)
        .toBe(retained.owner);
      expect(retained.input()).not.toBe("");
      expect(state.toast).toBe("finish or cancel current input first");
    }
  });

  test("dirty COMPOSE drafts refuse palette destinations and preserve their owner", async () => {
    const cases = [
      {
        setup: (state: ReturnType<typeof initialState>) => {
          state.mode = "COMPOSE";
          setComposerText(state.composer, "keep this Direct draft");
          return {
            composer: state.composer,
            retake: null,
            text: state.composer.text,
            images: draftImagesFor(state.composer).length
          };
        }
      },
      {
        setup: (state: ReturnType<typeof initialState>) => {
          const target = state.payload.path.find((node) => node.id === "p12");
          if (target === undefined) throw new Error("demo target did not load");
          const prompt = openRetakeComposer(
            state, target.id, target.instruction, { kind: "retake" }
          );
          // Keep this case about the retake owner itself, not its seeded text.
          setComposerText(state.composer, "");
          return {
            composer: state.composer,
            retake: prompt,
            text: state.composer.text,
            images: draftImagesFor(state.composer).length
          };
        }
      },
      {
        setup: (state: ReturnType<typeof initialState>) => {
          state.mode = "COMPOSE";
          attachDraftImage(state.composer, {
            leaseId: "a".repeat(64),
            attachment: {
              objectId: "b".repeat(64),
              mediaType: "image/png",
              width: 64,
              height: 48,
              byteLength: 4_096
            }
          });
          return {
            composer: state.composer,
            retake: null,
            text: state.composer.text,
            images: draftImagesFor(state.composer).length
          };
        }
      }
    ];

    for (const scenario of cases) {
      for (const destination of ["switch story", "import archive"] as const) {
        const source = demoAppSource();
        const state = initialState(source, false);
        const cache = createWrapCache<ProseStyle>();
        const retained = scenario.setup(state);
        const press = (event: KeyEvent) => handleKey(
          event, state, source, cache,
          () => undefined, async () => undefined, () => undefined
        );

        await press(ctrlP());
        await typeQuery(press, destination);
        await press(key("return", { sequence: "\r" }));

        expect(state.mode).toBe("COMPOSE");
        expect(state.commands).toBeNull();
        expect(state.composer).toBe(retained.composer);
        expect(state.retakePrompt).toBe(retained.retake);
        expect(state.composer.text).toBe(retained.text);
        expect(draftImagesFor(state.composer)).toHaveLength(retained.images);
        expect(state.toast).toBe("finish or cancel current input first");
      }
    }
  });

  test("a dirty CHAPTERS rename refuses a palette destination and preserves its draft", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    const chapterBreak = state.payload.chapterBreaks[0]!;
    const rename = {
      breakId: chapterBreak.id,
      composer: createComposer(`${chapterBreak.title} draft`)
    };
    state.chapters = { cursor: 0, rename, deleteArmedId: null };
    state.mode = "CHAPTERS";

    await handleKey(
      ctrlP(), state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );
    await typeQuery(
      (event) => handleKey(
        event, state, source, cache,
        () => undefined, async () => undefined, () => undefined
      ),
      "facts overview"
    );
    await handleKey(
      key("return", { sequence: "\r" }), state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.mode).toBe("CHAPTERS");
    expect(state.chapters?.rename).toBe(rename);
    expect(state.chapters?.rename?.composer.text).toBe(`${chapterBreak.title} draft`);
    expect(state.toast).toBe("finish or cancel current input first");
  });

  test("dirty non-Settings input still allows a non-destination read-only command", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    state.aside = createAsideSurface(state.payload.id, state.payload.title);
    setComposerText(state.aside.composer, "keep this question");
    state.mode = "ASIDE";
    const aside = state.aside;

    await handleKey(
      ctrlP(), state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );
    await typeQuery(
      (event) => handleKey(
        event, state, source, cache,
        () => undefined, async () => undefined, () => undefined
      ),
      "open story folder"
    );
    await handleKey(
      key("return", { sequence: "\r" }), state, source, cache,
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.mode).toBe("ASIDE");
    expect(state.aside).toBe(aside);
    expect(state.aside?.composer.text).toBe("keep this question");
    expect(state.toast).toBe(source.storyFolder);
  });

  test("read-only palette commands keep a suspended EDITOR draft", async () => {
    for (const query of ["open story folder", "theme: graphite", "export markdown"]) {
      const { source, state, press } = editorHarness();
      await press(key("f"));
      await press(key("return"));
      if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
      const editor = state.editor;
      setComposerText(editor.composer, "keep this Fact draft");
      if (query === "export markdown") source.exportDirectory = "/tmp";

      await press(ctrlP());
      await typeQuery(press, query);
      await press(key("return", { sequence: "\r" }));

      expect(state.mode).toBe("EDITOR");
      expect(state.editor).toBe(editor);
      expect(editor.composer.text).toBe("keep this Fact draft");
    }
  });

  test("a dirty editor blocks prune when its abandoned leaf is prunable", async () => {
    const { source, state, cache, press } = editorHarness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    // Move to an abandoned leaf, open its editor, then make another take
    // active. The open editor now owns a real target that prune would remove.
    await press(key("left"));
    expect(state.payload.path.at(-1)?.id).toBe("p12-t2");
    await press(key("e"));
    if (state.editor?.kind !== "document") throw new Error("part editor did not open");
    const editor = state.editor;
    setComposerText(editor.composer, "keep this abandoned draft");
    const targetId = editor.target.kind === "part" ? editor.target.node.id : null;
    expect(targetId).toBe("p12-t2");

    const activePayload = await source.api.switchLine(
      state.payload.id,
      "p12",
      { stopAtNode: true }
    );
    adoptSameStoryPayload(state, activePayload, cache);
    expect(unusedTakePruneSelection(state.payload).takeIds).toContain(targetId);

    await press(ctrlP());
    await typeQuery(press, "prune");
    expect(state.commands?.selectedId).toBe("prune");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.composer.text).toBe("keep this abandoned draft");
    expect(state.prune).toBeNull();
    expect(state.toast).toBe("finish or cancel current input first");

    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.editor).toBeNull();
  });

  test("payload adoption clears a story selection retained by Facts and its palette", async () => {
    const { source, state, cache, press } = editorHarness();
    const selection = {
      text: "selected prose",
      spans: [{ key: "p1:text", text: "selected prose", start: 0, end: 8 }]
    };
    const facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null,
      scopeFilter: "everywhere" as const,
      dossier: null,
      storySelection: selection
    };
    state.facts = facts;
    state.mode = "FACTS";
    await press(ctrlP());
    const palette = state.commands;
    expect(palette?.returnMode).toBe("FACTS");
    expect(palette?.selection).toBe(selection);

    adoptSameStoryPayload(
      state,
      { ...state.payload, title: "updated story" },
      cache
    );

    expect(state.facts).toBe(facts);
    expect(state.facts?.storySelection).toBeNull();
    expect(palette?.selection).toBeNull();

    await typeQuery(press, "new Fact from selection");
    expect(state.commands?.selectedId).not.toBe("new-fact-from-selection");
  });

  test("same-story adoption preserves selection for a non-Facts palette owner", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const selection = {
      text: "selected prose",
      spans: [{ key: "p1:text", text: "selected prose", start: 0, end: 8 }]
    };
    state.mode = "COMMANDS";
    state.commands = {
      query: "",
      cursor: 0,
      selectedId: null,
      view: "commands",
      returnMode: "NAV",
      selection
    };

    adoptSameStoryPayload(
      state,
      { ...state.payload, title: "updated story" },
      createWrapCache<ProseStyle>()
    );

    expect(state.commands?.selection).toBe(selection);
  });

});

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
  test("palette prune returns from Facts to a visible confirmation before D can remove takes", async () => {
    const { state, cache, press } = editorHarness();
    await press(key("f"));
    const facts = state.facts;
    if (facts === null) throw new Error("Facts did not open");

    await press(ctrlP());
    await typeQuery(press, "prune");
    expect(state.commands?.selectedId).toBe("prune");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("NAV");
    expect(state.facts).toBeNull();
    expect(state.prune).not.toBeNull();
    const frame = frameText(renderStoryScreen(state, {
      width: 100,
      height: 24,
      wrapCache: cache
    }).lines);
    expect(frame).toContain("PRUNE");
    expect(frame).toContain("D confirms · esc keeps");

    await press(key("d", { sequence: "D", shift: true }));
    expect(state.prune).toBeNull();
    expect(state.toast).toContain("pruned");
  });

  test("clean file prompts still allow a palette destination", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const cache = createWrapCache<ProseStyle>();
    state.card = {
      path: "",
      storyId: state.payload.id,
      candidates: [],
      error: null,
      returnMode: "NAV"
    };
    state.mode = "CARD";
    const card = state.card;

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

    expect(state.mode).toBe("CHAPTERS");
    expect(state.card).toBeNull();
    expect(state.chapters).not.toBeNull();
    expect(card).not.toBe(state.card);
  });

  test("Direct can resume a dirty Direct composer", async () => {
    const { source, state, press } = editorHarness();
    state.mode = "COMPOSE";
    setComposerText(state.composer, "keep this Direct draft");

    await press(ctrlP());
    await typeQuery(press, "direct");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("COMPOSE");
    expect(state.commands).toBeNull();
    expect(state.composer.text).toBe("keep this Direct draft");
    expect(state.toast).toBe("");
  });

  test("staged Settings refuse a palette destination and restore Settings", async () => {
    const { state, press } = settingsHarness();
    await openSettingsForm(press);
    if (state.settings === null) throw new Error("Settings did not open");
    const settings = state.settings;
    if (!settings.view.editable) throw new Error("Settings are not editable");
    settings.view = { ...settings.view, pendingRevision: settings.view.activeRevision + 1 };

    await press(ctrlP());
    await typeQuery(press, "chapters");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("SETTINGS");
    expect(state.settings).toBe(settings);
    expect(state.toast).toBe("save or cancel Settings changes first");
  });

  test("active Generation Profile file transfer refuses a palette destination and keeps its path", async () => {
    const { state, press } = settingsHarness();
    await openSettingsForm(press);
    await selectRow(press, state, "profile");
    await press(key("i"));
    await press(key("down"));
    await press(key("down"));
    await press(key("down"));
    await press(key("return", { sequence: "\r" }));

    const settings = state.settings;
    if (settings === null || settings.profileTransfer?.phase !== "file") {
      throw new Error("Generation Profile file transfer did not open");
    }
    const transfer = settings.profileTransfer;
    const path = "/tmp/profile-export.json";
    for (const character of path) await press(key(character));

    await press(ctrlP());
    await typeQuery(press, "facts overview");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("SETTINGS");
    expect(state.settings).toBe(settings);
    expect(state.settings?.profileTransfer).toBe(transfer);
    expect(transfer.path).toBe(path);
    expect(state.toast).toBe("save or cancel Settings changes first");
  });

  test("active Settings model picker refuses a palette destination and keeps its query", async () => {
    const { state, press } = settingsHarness();
    await openSettingsForm(press);
    if (state.settings === null) throw new Error("Settings did not open");
    const settings = state.settings;
    settings.draft = {
      ...settings.draft,
      generation: { ...settings.draft.generation, model: "model-01" }
    };
    publishCurrentSettingsModelDiscovery(settings, {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: Array.from({ length: 9 }, (_, index) => ({
        remoteId: `model-${String(index + 1).padStart(2, "0")}`,
        name: `Model ${String(index + 1).padStart(2, "0")}`,
        contextWindow: 32_768,
        maxOutputTokens: null,
        source: "openai-models" as const
      }))
    });

    await selectRow(press, state, "model");
    await press(key("return"));
    const picker = settings.modelPicker;
    if (picker === null) throw new Error("Settings model picker did not open");
    await typeQuery(press, "private-preview-model");
    expect(picker.query).toBe("private-preview-model");

    await press(ctrlP());
    await typeQuery(press, "chapters");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("SETTINGS");
    expect(state.settings).toBe(settings);
    expect(state.settings?.modelPicker).toBe(picker);
    expect(picker.query).toBe("private-preview-model");
    expect(state.toast).toBe("save or cancel Settings changes first");
  });

  test("settled export cleanup keeps Settings and a newer palette session", async () => {
    const { source, state, press } = settingsHarness();
    await openSettingsForm(press);
    if (state.settings === null) throw new Error("Settings did not open");
    const settings = state.settings;
    if (!settings.view.editable) throw new Error("Settings are not editable");
    settings.view = { ...settings.view, pendingRevision: settings.view.activeRevision + 1 };
    source.exportDirectory = "/tmp";

    const entered = deferred<void>();
    const release = deferred<void>();
    source.api.exportMarkdown = async () => {
      entered.resolve();
      await release.promise;
      return { markdown: "# exported", fidelity: [] };
    };

    await press(ctrlP());
    await typeQuery(press, "export markdown");
    const exporting = press(key("return", { sequence: "\r" }));
    await entered.promise;

    await press(ctrlP());
    const newerPalette = state.commands;
    expect(state.mode).toBe("COMMANDS");
    expect(newerPalette?.returnMode).toBe("SETTINGS");

    release.resolve();
    await exporting;

    expect(state.settings).toBe(settings);
    expect(state.commands).toBe(newerPalette);
    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("SETTINGS");
    expect(state.settings).toBe(settings);
  });

  test("settled export keeps a Settings prompt editor owned by Settings", async () => {
    const { source, state, press } = settingsHarness();
    await openSettingsForm(press);
    if (state.settings === null) throw new Error("Settings did not open");
    const settings = state.settings;
    source.exportDirectory = "/tmp";

    const entered = deferred<void>();
    const release = deferred<void>();
    source.api.exportMarkdown = async () => {
      entered.resolve();
      await release.promise;
      return { markdown: "# exported", fidelity: [] };
    };

    await press(ctrlP());
    await typeQuery(press, "export markdown");
    const exporting = press(key("return", { sequence: "\r" }));
    await entered.promise;

    // The old palette command has returned control to Settings while its
    // export request is pending. Opening a prompt now makes the Settings
    // overlay the live owner of a document editor.
    await selectRow(press, state, "default-author-brief");
    await press(key("return", { sequence: "\r" }));
    const editor = state.editor;
    if (editor?.kind !== "document" || editor.target.kind !== "settings-prompt") {
      throw new Error("global Settings prompt did not open");
    }
    setComposerText(editor.composer, "preserved Settings prompt");

    release.resolve();
    await exporting;

    expect(state.settings).toBe(settings);
    expect(state.editor).toBe(editor);
    expect(editor.target.owner).toBe(settings);

    // Ctrl+S commits the document editor into Settings. Plain s then saves
    // the Settings draft through the normal Settings mutation.
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("SETTINGS");
    expect(state.settings).toBe(settings);
    expect(state.settings?.draft.document?.writing.defaultAuthorBrief)
      .toBe("preserved Settings prompt");
    await press(key("s"));
    const savedDocument = source.settingsView.document;
    if (savedDocument === null) throw new Error("saved Settings document is missing");
    expect(savedDocument.writing.defaultAuthorBrief)
      .toBe("preserved Settings prompt");
  });

  test("dirty TAG input and status block palette destinations", async () => {
    for (const dirty of ["name", "status"] as const) {
      const { state, press } = editorHarness();
      await press(key("t"));
      const prompt = state.tag;
      if (prompt === null) throw new Error("Tag prompt did not open");
      const baselineName = prompt.name;
      await press(key("l"));
      if (dirty === "status") {
        await press(key("return", { sequence: "\r" }));
        await press(key("right"));
      }

      await press(ctrlP());
      await typeQuery(press, "chapters");
      await press(key("return", { sequence: "\r" }));

      expect(state.mode).toBe("TAG");
      expect(state.tag).toBe(prompt);
      expect(state.tag?.name).toBe(`${baselineName}l`);
      if (dirty === "status") expect(state.tag?.choosingStatus).toBeTrue();
      expect(state.toast).toBe("finish or cancel current input first");
    }
  });

  test("palette cleanup does not clear a replacement owner created while awaiting", async () => {
    const { source, state, press } = editorHarness();
    await press(key("f"));
    const originalFacts = state.facts;
    if (originalFacts === null) throw new Error("Facts did not open");

    const entered = deferred<void>();
    const release = deferred<void>();
    source.api.listStories = async () => {
      entered.resolve();
      await release.promise;
      return source.stories;
    };

    await press(ctrlP());
    await typeQuery(press, "switch story");
    const pending = press(key("return", { sequence: "\r" }));
    await entered.promise;
    const replacementFacts = { ...originalFacts };
    state.facts = replacementFacts;
    release.resolve();
    await pending;

    expect(state.mode).toBe("LIBRARY");
    expect(state.facts).toBe(replacementFacts);
  });

  test("End Fact here from the Facts list arms and opens the pending End State picker", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    const facts = state.facts;
    if (facts === null) throw new Error("Facts did not open");

    await press(ctrlP());
    await typeQuery(press, "end Fact here");
    expect(state.commands?.selectedId).toBe("end-fact-here");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("FACTS");
    expect(state.facts).toBe(facts);
    expect(state.facts?.pendingFactAction?.kind).toBe("end");
    await press(key("return", { sequence: "\r" }));
    expect(state.mode).toBe("EDITOR");
    if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
    expect(state.editor.stateIsEnd).toBeTrue();
    expect(state.editor.composer.text).toBe("");
  });

  test("new Fact State from an active Facts filter arms the pending state picker", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    const facts = state.facts;
    if (facts === null) throw new Error("Facts did not open");

    await press(key("/"));
    await typeQuery(press, "Maren");
    expect(facts.filtering).toBeTrue();
    expect(facts.query).toBe("Maren");

    await press(ctrlP());
    await typeQuery(press, "new Fact State");
    expect(state.commands?.selectedId).toBe("new-fact-state");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("FACTS");
    expect(state.facts).toBe(facts);
    expect(facts.filtering).toBeFalse();
    expect(facts.query).toBe("Maren");
    expect(facts.pendingFactAction?.kind).toBe("new-state");

    await press(key("return", { sequence: "\r" }));
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("fact");
    expect(facts.query).toBe("Maren");
  });

  test("clear Facts filter clears query and tag through the canonical reducer", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    if (state.facts === null) throw new Error("Facts did not open");
    state.facts.query = "Maren";
    state.facts.selectedTag = "people";
    state.facts.filtering = false;

    await press(ctrlP());
    await typeQuery(press, "clear Facts filter");
    expect(state.commands?.selectedId).toBe("facts-clear-filter");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("FACTS");
    expect(state.facts?.query).toBe("");
    expect(state.facts?.selectedTag).toBeNull();
    expect(state.facts?.filtering).toBeFalse();
  });

  test("reconnect refuses a dirty Fact editor and preserves its draft", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
    const editor = state.editor;
    setComposerText(editor.composer, "keep this unsaved Fact");

    await press(ctrlP());
    await typeQuery(press, "reconnect");
    expect(state.commands?.selectedId).toBe("reconnect");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.composer.text).toBe("keep this unsaved Fact");
    expect(state.toast).toBe("close the current editor before running this command");
  });

  test("reconnect refuses dirty Settings changes and preserves the Settings owner", async () => {
    const { state, press } = settingsHarness();
    await openSettingsForm(press);
    if (state.settings === null) throw new Error("Settings did not open");
    const settings = state.settings;
    if (!settings.view.editable) throw new Error("Settings are not editable");
    settings.view = { ...settings.view, pendingRevision: settings.view.activeRevision + 1 };

    await press(ctrlP());
    await typeQuery(press, "reconnect");
    expect(state.commands?.selectedId).toBe("reconnect");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("SETTINGS");
    expect(state.settings).toBe(settings);
    expect(state.toast).toBe("save or cancel Settings changes first");
  });

  test("reconnect remains available from a clean owner", async () => {
    const { state, press } = editorHarness();
    state.mode = "COMPOSE";

    await press(ctrlP());
    await typeQuery(press, "reconnect");
    expect(state.commands?.selectedId).toBe("reconnect");
    await press(key("return", { sequence: "\r" }));

    expect(state.mode).toBe("COMPOSE");
    expect(state.commands).toBeNull();
    expect(state.composer.text).toBe("");
    expect(state.toast).toBe("reconnected · demo fixture");
  });

  test("contextual Fact mutations carry the generation guard metadata", () => {
    const state = initialState(demoAppSource(), false);
    const matches = commandMatches("", false, commandContext(state.payload, {
      connectionDown: false,
      requestActive: false,
      canRewriteSelection: false,
      factsPanel: true,
      factsSelected: true,
      factsCanMoveUp: true,
      factsCanMoveDown: true
    }));
    for (const id of ["facts-delete", "facts-move-up", "facts-move-down"] as const) {
      expect(matches.find(({ command }) => command.id === id)?.command.mutating).toBeTrue();
    }
  });});

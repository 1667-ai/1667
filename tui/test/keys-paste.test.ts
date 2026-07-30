import { expect, test } from "bun:test";
import { createComposer } from "../src/composer-model.js";
import { pasteInto } from "../src/keys.js";

test("paste inserts at the composer cursor and flattens single-line prompts", () => {
  const base = {
    composer: createComposer("ab"), tag: null, library: null, facts: null, commands: null,
    editor: null, settings: null,
    prune: null, chapterDeleteArmedId: null, actions: null, retakePrompt: null,
    composerScrollTop: 0, history: [] as string[], historyIndex: 0, historyDraft: null,
    pendingGenerationDraft: null, composerClaimEpoch: 0
  };
  base.composer.cursor = 1;
  const compose = { ...base, mode: "COMPOSE" as const };
  expect(pasteInto(compose, "line one\r\nline two")).toBeTrue();
  expect(compose.composer.text).toBe("aline one\nline twob");
  const naming = {
    ...base,
    composer: createComposer(),
    mode: "TAG" as const,
    tag: { choosingStatus: false, name: "" }
  };
  expect(pasteInto(naming, "storm\ncanon")).toBeTrue();
  expect(naming.tag.name).toBe("storm canon");
  const facts = {
    ...base,
    composer: createComposer(),
    mode: "FACTS" as const,
    facts: { filtering: true, query: "", cursor: 6 }
  };
  expect(pasteInto(facts, "storm\ncanon")).toBeTrue();
  expect(facts.facts).toEqual({ filtering: true, query: "storm canon", cursor: 0 });
  const library = {
    ...base,
    composer: createComposer(),
    mode: "LIBRARY" as const,
    library: {
      stories: [],
      cursor: 6,
      query: "",
      prompt: {
        kind: "filter" as const,
        initial: { query: "", cursor: 6, storyId: null }
      }
    }
  };
  expect(pasteInto(library, "winter\norchard")).toBeTrue();
  expect(library.library).toEqual({
    stories: [],
    cursor: 0,
    query: "winter orchard",
    prompt: {
      kind: "filter",
      initial: { query: "", cursor: 6, storyId: null }
    }
  });
  const settingsComposer = createComposer("ab");
  settingsComposer.cursor = 1;
  const settings = {
    ...base,
    mode: "SETTINGS" as const,
    settings: {
      edit: {
        kind: "inline" as const,
        row: "model" as const,
        mode: "text" as const,
        composer: settingsComposer,
        initial: "ab",
        cutConfirmation: null
      },
      conflict: null
    }
  };
  expect(pasteInto(settings, "line one\r\nline two")).toBeTrue();
  expect(settingsComposer.text).toBe("aline one line twob");
  const editorComposer = createComposer("ab");
  editorComposer.cursor = 1;
  const editor = {
    ...base,
    mode: "EDITOR" as const,
    composer: createComposer(),
    editor: {
      kind: "fact" as const,
      target: { kind: "fact" as const, factId: null, base: null },
      composer: editorComposer,
      tag: createComposer(""),
      focus: "body" as const,
      initialFact: { tag: null, text: "ab" },
      title: "edit fact",
      placeholder: "fact text…",
      returnMode: "FACTS" as const,
      conflict: { message: "changed", resolution: "overwrite" as const, armed: true },
      cutConfirmation: null,
      tagCutConfirmation: null
    }
  };
  expect(pasteInto(editor, "line one\r\nline two")).toBeTrue();
  expect(editorComposer.text).toBe("aline one\nline twob");
  expect(editor.editor.conflict.armed).toBeFalse();
  const directComposer = createComposer("kept ");
  const retakeComposer = createComposer("old retake prompt");
  const nav = {
    ...base,
    mode: "NAV" as const,
    composer: retakeComposer,
    retakePrompt: {
      nodeId: "old-retake",
      composer: retakeComposer,
      composerScrollTop: 0,
      returnState: {
        composer: directComposer,
        composerScrollTop: 0,
        historyIndex: 0,
        historyDraft: null,
        historyWasLive: true
      }
    }
  };
  expect(pasteInto(nav, "make it rain")).toBeTrue();
  expect(nav.mode).toBe("COMPOSE");
  expect(nav.composer.text).toBe("kept make it rain");
  expect(nav.retakePrompt).toBe(null);
  const pruning = {
    ...base, mode: "NAV" as const, composer: createComposer(), prune: { kind: "branch" }
  };
  expect(pasteInto(pruning, "dangerous draft")).toBeFalse();
  expect(pruning.mode).toBe("NAV");
  expect(pruning.composer.text).toBe("");
  const deletingChapter = {
    ...base, mode: "NAV" as const, composer: createComposer(), chapterDeleteArmedId: "break-1"
  };
  expect(pasteInto(deletingChapter, "hidden draft")).toBeFalse();
  expect(deletingChapter.mode).toBe("NAV");
  expect(deletingChapter.composer.text).toBe("");
  const actionMenu = {
    ...base, mode: "NAV" as const, composer: createComposer(), actions: { cursor: 0 }
  };
  expect(pasteInto(actionMenu, "hidden menu draft")).toBeFalse();
  expect(actionMenu.mode).toBe("NAV");
  expect(actionMenu.composer.text).toBe("");
  expect(pasteInto({
    ...base,
    mode: "MAP" as const,
    composer: createComposer()
  }, "text")).toBeFalse();
});

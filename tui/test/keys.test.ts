import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { createComposer } from "../src/composer-model.js";
import { pasteInto, resolveKey, sanitizePastedText } from "../src/keys.js";
import {
  KEYS_MODAL_MODEL,
  renderKeysOverlay
} from "../src/screens/keys-modal.js";
import { frameText } from "../src/screens/story/frame.js";

function key(
  name: string,
  options: {
    sequence?: string;
    shift?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    super?: boolean;
  } = {}
): KeyEvent {
  return {
    name,
    sequence: options.sequence ?? name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: options.meta ?? false,
    super: options.super ?? false
  } as KeyEvent;
}

describe("arrow-first key routing", () => {
  test("NAV uses arrows for parts and takes; h/j/k/l are unbound", () => {
    expect(resolveKey(key("down"), "NAV").action).toBe("focus-next");
    expect(resolveKey(key("up"), "NAV").action).toBe("focus-previous");
    expect(resolveKey(key("right"), "NAV").action).toBe("take-next");
    expect(resolveKey(key("left"), "NAV").action).toBe("take-previous");
    for (const dead of ["h", "j", "k", "l"]) {
      expect(resolveKey(key(dead), "NAV").action).toBe("none");
    }
  });

  test("map path uses arrows, applies with Enter, and cycles with m", () => {
    const path = { mapView: "path" as const };
    expect(resolveKey(key("down"), "MAP", path).action).toBe("focus-next");
    expect(resolveKey(key("up"), "MAP", path).action).toBe("focus-previous");
    expect(resolveKey(key("right"), "MAP", path).action).toBe("take-next");
    expect(resolveKey(key("left"), "MAP", path).action).toBe("take-previous");
    expect(resolveKey(key("return"), "MAP", path).action).toBe("apply");
    expect(resolveKey(key("m"), "MAP", path).action).toBe("cycle-map-view");
    expect(resolveKey(key("a"), "MAP", path).action).toBe("toggle-path-takes");
    expect(resolveKey(key("t"), "MAP", path).action).toBe("none");
    for (const dead of ["h", "j", "k", "l"]) {
      expect(resolveKey(key(dead), "MAP", path).action).toBe("none");
    }
  });

  test("tree and mass reserve l for follow/open; horizontal arrows stay idle", () => {
    for (const mapView of ["tree", "mass"] as const) {
      const options = { mapView };
      expect(resolveKey(key("down"), "MAP", options).action).toBe("focus-next");
      expect(resolveKey(key("up"), "MAP", options).action).toBe("focus-previous");
      expect(resolveKey(key("l"), "MAP", options).action).toBe("map-follow");
      expect(resolveKey(key("left"), "MAP", options).action).toBe("none");
      expect(resolveKey(key("right"), "MAP", options).action).toBe("none");
      expect(resolveKey(key("s"), "MAP", options).action).toBe("map-cycle-sort");
      for (const dead of ["h", "j", "k"]) {
        expect(resolveKey(key(dead), "MAP", options).action).toBe("none");
      }
    }
  });

  test("list and menu surfaces use arrows rather than j/k", () => {
    for (const mode of ["ACTIONS", "CHAPTERS", "LIBRARY", "FACTS", "COMMANDS", "SETTINGS"] as const) {
      expect(resolveKey(key("down"), mode).action).toBe("focus-next");
      expect(resolveKey(key("up"), mode).action).toBe("focus-previous");
      expect(resolveKey(key("j"), mode).action).not.toBe("focus-next");
      expect(resolveKey(key("k"), mode).action).not.toBe("focus-previous");
    }
  });

  test("keys overlay suppresses NAV and escape peels it", () => {
    expect(resolveKey(key("down"), "KEYS").action).toBe("none");
    expect(resolveKey(key("escape"), "KEYS").action).toBe("cancel");
  });

  test("prune confirmation accepts only d or escape", () => {
    expect(resolveKey(key("d"), "MAP", { confirmingPrune: true }).action).toBe("prune");
    expect(resolveKey(key("d", { ctrl: true }), "MAP", { confirmingPrune: true }).action).toBe("none");
    expect(resolveKey(key("d", { meta: true }), "MAP", { confirmingPrune: true }).action).toBe("none");
    expect(resolveKey(key("d", { shift: true }), "MAP", { confirmingPrune: true }).action).toBe("none");
    expect(resolveKey(key("down"), "MAP", { confirmingPrune: true }).action).toBe("none");
    expect(resolveKey(key("escape"), "MAP", { confirmingPrune: true }).action).toBe("cancel");
  });
});

describe("key map", () => {
  test("renders four ordered groups and every advertised binding resolves", () => {
    const frame = frameText(renderKeysOverlay(
      Array.from({ length: 36 }, () => []), Array.from({ length: 36 }, () => null), 120, 36
    ).lines);
    const groups = KEYS_MODAL_MODEL.bandGroups.map((group) => group.band);
    expect(groups).toEqual(["MOVE", "WRITE", "SHAPE", "OPEN"]);
    expect(groups.map((group) => frame.indexOf(group))).toEqual(
      groups.map((group) => frame.indexOf(group)).sort((left, right) => left - right)
    );
    for (const binding of KEYS_MODAL_MODEL.bindings) {
      const event = key(binding.name, {
        sequence: binding.sequence,
        shift: binding.shift,
        ctrl: binding.ctrl
      });
      expect(resolveKey(event, binding.mode, { mapView: binding.mapView }).action).toBe(binding.action);
    }
    const escape = KEYS_MODAL_MODEL.bindings.find((binding) =>
      binding.name === "escape" && binding.mode === "KEYS")!;
    expect(frame).toContain("esc");
    expect(resolveKey(key(escape.name), escape.mode).action).toBe(escape.action);
    expect(frame).toContain("↑↓");
    expect(frame).toContain("←→");
  });

  test("h/j/k caps are inactive while map-follow l and sketches a stay lit", () => {
    const caps = new Map(KEYS_MODAL_MODEL.capRows.flat().map((item) => [item.key, item]));
    for (const dead of ["h", "j", "k"]) {
      expect(caps.get(dead)?.band).toBe("INACTIVE");
      expect(caps.get(dead)?.bindings).toHaveLength(0);
    }
    expect(caps.get("l")?.band).not.toBe("INACTIVE");
    expect(caps.get("l")?.bindings.some((binding) => binding.action === "map-follow")).toBeTrue();
    expect(caps.get("a")?.band).not.toBe("INACTIVE");
    expect(caps.get("a")?.bindings.some((binding) => binding.action === "toggle-sketches")).toBeTrue();
    expect(KEYS_MODAL_MODEL.discoveries.some((item) =>
      item.token === "R" && item.bindings.some((binding) => binding.action === "retake-with-prompt")
    )).toBeTrue();
  });
});

describe("text surfaces and palette", () => {
  test("paste sanitization strips terminal controls but keeps editor whitespace", () => {
    expect(sanitizePastedText("one\r\ntwo\t\u001b]52;c;bad\u0007\u007f"))
      .toBe("one\ntwo\t]52;c;bad");
  });

  test("compose owns cursor, newline, fullscreen, and explicit history keys", () => {
    expect(resolveKey(key("left"), "COMPOSE").action).toBe("cursor-left");
    expect(resolveKey(key("right"), "COMPOSE").action).toBe("cursor-right");
    expect(resolveKey(key("up"), "COMPOSE").action).toBe("cursor-up");
    expect(resolveKey(key("down"), "COMPOSE").action).toBe("cursor-down");
    expect(resolveKey(key("return", { shift: true }), "COMPOSE").action).toBe("newline");
    expect(resolveKey(key("f", { ctrl: true }), "COMPOSE").action).toBe("toggle-compose-fullscreen");
    expect(resolveKey(key("up", { ctrl: true }), "COMPOSE").action).toBe("history-previous");
    expect(resolveKey(key("down", { ctrl: true }), "COMPOSE").action).toBe("history-next");
    expect(resolveKey(key("?"), "COMPOSE")).toEqual({ action: "input", text: "?" });
  });

  test("inline editor owns multiline input and saves only with Ctrl+S", () => {
    expect(resolveKey(key("return"), "EDITOR").action).toBe("newline");
    expect(resolveKey(key("s"), "EDITOR")).toEqual({ action: "input", text: "s" });
    expect(resolveKey(key("s", { sequence: "\u0013", ctrl: true }), "EDITOR").action).toBe("save-edit");
    expect(resolveKey(key("escape"), "EDITOR").action).toBe("cancel");
    expect(resolveKey(key("R", { sequence: "R", shift: true }), "EDITOR")).toEqual({ action: "input", text: "R" });
    expect(resolveKey(key("left", { shift: true }), "EDITOR"))
      .toEqual({ action: "select-left" });
  });

  test("inline Settings fields preserve shifted keyboard selection", () => {
    const typing = { overlayTyping: true };
    expect(resolveKey(key("p"), "SETTINGS").action).toBe("detect-context");
    expect(resolveKey(key("p"), "SETTINGS", typing))
      .toEqual({ action: "input", text: "p" });
    expect(resolveKey(key("left", { shift: true }), "SETTINGS", typing).action)
      .toBe("select-left");
    expect(resolveKey(key("right", { shift: true }), "SETTINGS", typing).action)
      .toBe("select-right");
    expect(resolveKey(key("home", { shift: true }), "SETTINGS", typing).action)
      .toBe("select-line-start");
    expect(resolveKey(key("end", { shift: true }), "SETTINGS", typing).action)
      .toBe("select-line-end");
    expect(resolveKey(key("v", { ctrl: true }), "SETTINGS", typing).action)
      .toBe("paste-clipboard");
    expect(resolveKey(key("v", { super: true }), "SETTINGS", typing).action)
      .toBe("paste-clipboard");
    expect(resolveKey(key("v", { ctrl: true }), "SETTINGS").action)
      .toBe("paste-clipboard");
    expect(resolveKey(key("v", { super: true }), "SETTINGS").action)
      .toBe("paste-clipboard");
  });

  test("inline editor exposes selection, word navigation, clipboard, and deletion chords", () => {
    expect(resolveKey(key("left", { shift: true }), "EDITOR").action).toBe("select-left");
    expect(resolveKey(key("right", { ctrl: true }), "EDITOR").action).toBe("cursor-word-right");
    expect(resolveKey(key("b", { ctrl: true }), "EDITOR").action).toBe("cursor-left");
    expect(resolveKey(key("left", { ctrl: true, shift: true }), "EDITOR").action).toBe("select-word-left");
    expect(resolveKey(key("c", { ctrl: true }), "EDITOR").action).toBe("copy-selection");
    expect(resolveKey(key("x", { ctrl: true }), "EDITOR").action).toBe("cut-selection");
    expect(resolveKey(key("v", { ctrl: true }), "EDITOR").action).toBe("paste-clipboard");
    expect(resolveKey(key("backspace", { meta: true }), "EDITOR").action).toBe("delete-word-left");
    expect(resolveKey(key("backspace", { ctrl: true }), "EDITOR").action).toBe("delete-word-left");
    expect(resolveKey(key("k", { ctrl: true }), "EDITOR").action).toBe("delete-line-end");
    expect(resolveKey(key("a", { ctrl: true }), "EDITOR").action).toBe("cursor-line-start");
    expect(resolveKey(key("home", { shift: true }), "EDITOR").action).toBe("select-line-start");
    expect(resolveKey(key("home", { ctrl: true, shift: true }), "EDITOR").action).toBe("select-buffer-start");
    expect(resolveKey(key("end"), "EDITOR").action).toBe("cursor-line-end");
    expect(resolveKey(key("end", { ctrl: true }), "EDITOR").action).toBe("cursor-buffer-end");
    expect(resolveKey(key("z", { ctrl: true }), "EDITOR").action).toBe("undo-edit");
    expect(resolveKey(key("z", { ctrl: true, shift: true }), "EDITOR").action).toBe("redo-edit");
  });

  test("Ctrl+P and colon open commands; Ctrl+G opens context details", () => {
    expect(resolveKey(key("p", { ctrl: true }), "NAV").action).toBe("open-commands");
    expect(resolveKey(key(":"), "NAV").action).toBe("open-commands");
    expect(resolveKey(key("g", { ctrl: true }), "NAV").action).toBe("toggle-context-meter");
    expect(resolveKey(key("g", { ctrl: true }), "COMPOSE").action).toBe("toggle-context-meter");
    expect(resolveKey(key("/"), "NAV").action).toBe("none");
    expect(resolveKey(key("/"), "LIBRARY").action).toBe("filter");
  });

  test("unknown ctrl/meta letter chords never fall through to NAV hotkeys", () => {
    for (const name of ["f", "e", "n", "w", "q"]) {
      expect(resolveKey(key(name, { ctrl: true }), "NAV").action).toBe("none");
      expect(resolveKey(key(name, { meta: true }), "NAV").action).toBe("none");
    }
    expect(resolveKey(key("d", { ctrl: true }), "NAV").action).toBe("scroll-down");
    expect(resolveKey(key("u", { ctrl: true }), "NAV").action).toBe("scroll-up");
    expect(resolveKey(key("n", { ctrl: true }), "LIBRARY").action).toBe("none");
    expect(resolveKey(key("x", { ctrl: true }), "FACTS").action).toBe("none");
    expect(resolveKey(key("e", { ctrl: true }), "SETTINGS").action).toBe("none");
  });

  test("only declared capital commands survive terminal shift encodings", () => {
    const shifted = (letter: string): KeyEvent[] => {
      const upper = letter.toUpperCase();
      return [
        key(letter, { sequence: upper, shift: true }),
        key(upper, { sequence: upper, shift: true }),
        key(upper, { sequence: upper })
      ];
    };
    const declared = new Map([
      ["c", "create-chapter"],
      ["f", "toggle-rail"],
      ["g", "leaf"],
      ["r", "retake-with-prompt"],
      ["y", "copy-line"]
    ]);
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      for (const event of shifted(letter)) {
        expect(resolveKey(event, "NAV").action).toBe(declared.get(letter) ?? "none");
      }
    }

    const destructiveRoutes = [
      resolveKey(shifted("d")[0]!, "MAP", { mapView: "path" }),
      resolveKey(shifted("d")[0]!, "CHAPTERS"),
      resolveKey(shifted("d")[0]!, "LIBRARY"),
      resolveKey(shifted("x")[0]!, "FACTS"),
      resolveKey(shifted("x")[0]!, "COMMANDS", { commandsBookmarks: true }),
      resolveKey(shifted("x")[0]!, "BOOKMARK", { bookmarkChoosingLabel: true })
    ];
    expect(destructiveRoutes.map(({ action }) => action)).toEqual(
      Array.from({ length: destructiveRoutes.length }, () => "none")
    );
    for (const event of shifted("x")) {
      expect(resolveKey(event, "BOOKMARK")).toEqual({ action: "input", text: "X" });
    }
  });

  test("d is a name character while typing, delete only during label choice", () => {
    expect(resolveKey(key("d"), "BOOKMARK")).toEqual({ action: "input", text: "d" });
    expect(resolveKey(key("d"), "BOOKMARK", { bookmarkChoosingLabel: true }).action).toBe("delete-bookmark");
  });

  test("NAV Enter directs, Space continues, and n starts a new story", () => {
    expect(resolveKey(key("return"), "NAV").action).toBe("compose");
    expect(resolveKey(key("i"), "NAV").action).toBe("compose");
    expect(resolveKey(key("space", { sequence: " " }), "NAV").action).toBe("continue");
    expect(resolveKey(key("n"), "NAV").action).toBe("new-item");
    expect(resolveKey(key("m"), "NAV").action).toBe("open-map");
    expect(resolveKey(key("t"), "NAV").action).toBe("none");
    expect(resolveKey(key("r"), "NAV").action).toBe("regenerate");
    expect(resolveKey(key("R"), "NAV").action).toBe("retake-with-prompt");
    expect(resolveKey(key("c"), "NAV").action).toBe("open-chapters");
    expect(resolveKey(key("C"), "NAV").action).toBe("create-chapter");
    expect(resolveKey(key("["), "NAV").action).toBe("chapter-previous");
    expect(resolveKey(key("]"), "NAV").action).toBe("chapter-next");
  });

  test("chapters owns TOC actions and rename text", () => {
    expect(resolveKey(key("s"), "CHAPTERS").action).toBe("summarize-chapter");
    expect(resolveKey(key("e"), "CHAPTERS").action).toBe("rename-item");
    expect(resolveKey(key("d"), "CHAPTERS").action).toBe("delete-item");
    expect(resolveKey(key("n"), "CHAPTERS").action).toBe("new-item");
    expect(resolveKey(key("e"), "CHAPTERS", { overlayTyping: true })).toEqual({ action: "input", text: "e" });
  });
  test("overlay text prompts own letters that are otherwise hotkeys", () => {
    const typing = { overlayTyping: true };
    for (const letter of ["j", "k", "n", "r", "d", "x", "e", "/"]) {
      expect(resolveKey(key(letter), "LIBRARY", typing)).toEqual({ action: "input", text: letter });
    }
    expect(resolveKey(key("down"), "LIBRARY", typing).action).toBe("focus-next");
    expect(resolveKey(key("d"), "LIBRARY").action).toBe("delete-item");
  });

  test("offline retry never steals capital R from a text owner", () => {
    const offline = { connectionDown: true };
    const shiftedR = [
      key("r", { sequence: "R", shift: true }),
      key("R", { sequence: "R", shift: true }),
      key("R", { sequence: "R" })
    ];
    for (const event of shiftedR) {
      expect(resolveKey(event, "NAV", offline).action).toBe("retry");
      expect(resolveKey(event, "COMPOSE", offline)).toEqual({ action: "input", text: "R" });
      expect(resolveKey(event, "COMMANDS", offline)).toEqual({ action: "input", text: "R" });
      expect(resolveKey(event, "BOOKMARK", offline)).toEqual({ action: "input", text: "R" });
    }
    expect(resolveKey(key("R", { shift: true }), "LIBRARY", {
      ...offline, overlayTyping: true
    })).toEqual({ action: "input", text: "R" });
    expect(resolveKey(key("R", { shift: true }), "CHAPTERS", {
      ...offline, overlayTyping: true
    })).toEqual({ action: "input", text: "R" });
    expect(resolveKey(key("R", { shift: true }), "COMMANDS", {
      ...offline, commandsBookmarks: true
    }).action).toBe("retry");
  });

  test("palette query accepts d and e; d deletes only in bookmarks", () => {
    expect(resolveKey(key("d"), "COMMANDS")).toEqual({ action: "input", text: "d" });
    expect(resolveKey(key("e"), "COMMANDS")).toEqual({ action: "input", text: "e" });
    expect(resolveKey(key("d"), "COMMANDS", { commandsBookmarks: true }).action).toBe("delete-item");
  });

  test("paste inserts at the composer cursor and flattens single-line prompts", () => {
    const base = {
      composer: createComposer("ab"), bookmark: null, library: null, facts: null, commands: null,
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
      mode: "BOOKMARK" as const,
      bookmark: { choosingLabel: false, name: "" }
    };
    expect(pasteInto(naming, "storm\ncanon")).toBeTrue();
    expect(naming.bookmark.name).toBe("storm canon");
    const facts = {
      ...base,
      composer: createComposer(),
      mode: "FACTS" as const,
      facts: { filtering: true, query: "", cursor: 6 }
    };
    expect(pasteInto(facts, "storm\ncanon")).toBeTrue();
    expect(facts.facts).toEqual({ filtering: true, query: "storm canon", cursor: 0 });
    const settingsComposer = createComposer("ab");
    settingsComposer.cursor = 1;
    const settings = {
      ...base,
      mode: "SETTINGS" as const,
      settings: { edit: { composer: settingsComposer } }
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
        target: { kind: "fact" as const, factId: null, base: null },
        composer: editorComposer,
        initial: "ab",
        title: "edit fact",
        placeholder: "fact text…",
        returnMode: "FACTS" as const,
        conflict: { message: "changed", resolution: "overwrite" as const, armed: true },
        cutConfirmation: null
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
    expect(pasteInto({ ...base, mode: "MAP" as const, composer: createComposer() }, "text")).toBeFalse();
  });
});

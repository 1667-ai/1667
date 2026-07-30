import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  resolveKey,
  sanitizePastedText,
  type KeyAction
} from "../src/keys.js";
import { textSurfaceKey } from "../src/keys-text-surface.js";
import {
  COMPOSER_SURFACES,
  composerChangedThroughSurface,
  resolveComposerSurface,
  surfaceActions,
  textSurfaceKeyMatrix
} from "./keys-contract-fixture.js";

function key(
  name: string,
  options: {
    sequence?: string;
    shift?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    option?: boolean;
    super?: boolean;
  } = {}
): KeyEvent {
  return {
    name,
    sequence: options.sequence ?? name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: options.meta ?? false,
    option: options.option ?? false,
    super: options.super ?? false
  } as KeyEvent;
}

const DECLARED_DIVERGENCES = [
  { label: "ctrl+alt+b", event: key("b", { ctrl: true, meta: true }),
    actions: ["cursor-word-left", "cursor-left", "cursor-word-left"],
    shadowsShared: (event: KeyEvent) => event.name.toLowerCase() === "b"
      && event.ctrl === true && (event.meta === true || event.option === true) },
  { label: "ctrl+alt+f", event: key("f", { ctrl: true, meta: true }),
    actions: ["toggle-compose-fullscreen", "cursor-right", "cursor-word-right"],
    shadowsShared: (event: KeyEvent) => event.name.toLowerCase() === "f"
      && event.ctrl === true && (event.meta === true || event.option === true) },
  { label: "ctrl+cmd+a", event: key("a", { ctrl: true, super: true }),
    actions: ["cursor-line-start", "select-all", "select-all"],
    shadowsShared: (event: KeyEvent) => event.name.toLowerCase() === "a"
      && event.super === true
      && (event.ctrl === true || event.meta === true || event.option === true) },
  { label: "ctrl+f", event: key("f", { ctrl: true }),
    actions: ["toggle-compose-fullscreen", "cursor-right", "none"] },
  { label: "ctrl+b", event: key("b", { ctrl: true }),
    actions: ["none", "cursor-left", "none"] },
  { label: "return", event: key("return"),
    actions: ["send", "newline", "commit-field"] },
  { label: "shift+return", event: key("return", { shift: true }),
    actions: ["newline", "newline", "commit-field"] },
  { label: "ctrl+s", event: key("s", { ctrl: true }),
    actions: ["none", "save-edit", "commit-field"] },
  { label: "ctrl+o", event: key("o", { sequence: "\u000f", ctrl: true }),
    actions: ["none", "save-edit-inplace", "none"] },
  { label: "ctrl+shift+s", event: key("s", { ctrl: true, shift: true }),
    // Settings field commit still treats ctrl+s (with or without shift) as keep.
    actions: ["none", "save-edit-inplace", "commit-field"] },
  { label: "ctrl+c", event: key("c", { ctrl: true }),
    actions: ["none", "copy-selection", "none"] },
  { label: "ctrl+x", event: key("x", { ctrl: true }),
    actions: ["none", "cut-selection", "none"] },
  { label: "ctrl+v", event: key("v", { ctrl: true }),
    actions: ["none", "paste-clipboard", "paste-clipboard"] },
  { label: "cmd+v", event: key("v", { super: true }),
    actions: ["input", "input", "paste-clipboard"] },
  { label: "cmd+a", event: key("a", { super: true }),
    actions: ["input", "select-all", "select-all"] },
  { label: "ctrl+d", event: key("d", { ctrl: true }),
    actions: ["none", "delete-forward", "none"] },
  { label: "ctrl+shift+d", event: key("d", { ctrl: true, shift: true }),
    actions: ["none", "delete-line", "none"] },
  { label: "ctrl+z", event: key("z", { ctrl: true }),
    actions: ["none", "undo-edit", "none"] },
  { label: "ctrl+shift+z", event: key("z", { ctrl: true, shift: true }),
    actions: ["none", "redo-edit", "none"] },
  { label: "up", event: key("up"), actions: ["cursor-up", "cursor-up", "none"] },
  { label: "down", event: key("down"), actions: ["cursor-down", "cursor-down", "none"] },
  { label: "ctrl+up", event: key("up", { ctrl: true }),
    actions: ["history-previous", "cursor-up", "none"] },
  { label: "ctrl+down", event: key("down", { ctrl: true }),
    actions: ["history-next", "cursor-down", "none"] }
] satisfies readonly {
  label: string;
  event: KeyEvent;
  actions: readonly [KeyAction, KeyAction, KeyAction];
  shadowsShared?: (event: KeyEvent) => boolean;
}[];

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

  test("shifted arrows keep NAV scrolling and MAP focus semantics", () => {
    expect(resolveKey(key("up", { shift: true }), "NAV").action).toBe("scroll-line-up");
    expect(resolveKey(key("down", { shift: true }), "NAV").action).toBe("scroll-line-down");
    for (const mapView of ["path", "tree", "mass"] as const) {
      expect(resolveKey(key("up", { shift: true }), "MAP", { mapView }).action)
        .toBe("focus-previous");
      expect(resolveKey(key("down", { shift: true }), "MAP", { mapView }).action)
        .toBe("focus-next");
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
    expect(resolveKey(key("t"), "MAP", path).action).toBe("tag");
    expect(resolveKey(key("b"), "MAP", path).action).toBe("none");
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
    expect(resolveKey(key("return"), "FACTS").action).toBe("edit");
    expect(resolveKey(key("return"), "FACTS", { overlayTyping: true }).action)
      .toBe("open-selected");
  });

  test("keys overlay scrolls, suppresses NAV, and escape peels it", () => {
    expect(resolveKey(key("down"), "KEYS").action).toBe("focus-next");
    expect(resolveKey(key("up"), "KEYS").action).toBe("focus-previous");
    expect(resolveKey(key("pagedown"), "KEYS").action).toBe("scroll-down");
    expect(resolveKey(key("pageup"), "KEYS").action).toBe("scroll-up");
    expect(resolveKey(key("space"), "KEYS").action).toBe("scroll-down");
    // Story hotkeys stay inert behind the panel: `d` must not prune, and the
    // scroll vocabulary must not leak the letters that mean something in NAV.
    for (const inert of ["d", "n", "r", "j", "k", "return"]) {
      expect(resolveKey(key(inert), "KEYS").action).toBe("none");
    }
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

describe("text surfaces and palette", () => {
  test("composer-backed surfaces preserve shared key precedence unless the divergence table declares it", () => {
    for (const event of textSurfaceKeyMatrix()) {
      const shared = textSurfaceKey(event);
      if (shared === null) continue;
      const actual = surfaceActions(event);
      const declared = DECLARED_DIVERGENCES.find(
        (entry) => entry.shadowsShared?.(event) === true
      );
      expect(actual).toEqual(
        declared?.actions ?? COMPOSER_SURFACES.map(() => shared.action)
      );
    }
    for (const declared of DECLARED_DIVERGENCES) {
      expect({
        label: declared.label,
        actions: surfaceActions(declared.event)
      }).toEqual({
        label: declared.label,
        actions: declared.actions
      });
    }
  });

  test("every emitted composer edit changes state through the surface's real reducer", async () => {
    const events = [
      ...textSurfaceKeyMatrix(),
      ...DECLARED_DIVERGENCES.map((entry) => entry.event)
    ];
    const editingActions = new Set<KeyAction>(["select-all", "delete-line"]);
    for (const event of textSurfaceKeyMatrix()) {
      const shared = textSurfaceKey(event);
      if (shared !== null) editingActions.add(shared.action);
    }
    for (const surface of COMPOSER_SURFACES) {
      const emitted = new Map<KeyAction, ReturnType<typeof resolveComposerSurface>>();
      for (const event of events) {
        const resolved = resolveComposerSurface(surface, event);
        if (editingActions.has(resolved.action) && !emitted.has(resolved.action)) {
          emitted.set(resolved.action, resolved);
        }
      }
      for (const [action, resolved] of emitted) {
        expect({
          surface,
          action,
          changed: await composerChangedThroughSurface(surface, resolved)
        }).toEqual({ surface, action, changed: true });
      }
    }
  });

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
    // OpenTUI raw LF / Ctrl+J insert a line; they never send the draft.
    expect(resolveKey(key("linefeed", { sequence: "\n" }), "COMPOSE").action).toBe("newline");
    expect(resolveKey(key("j", { sequence: "\n", ctrl: true }), "COMPOSE").action).toBe("newline");
    expect(resolveKey(key("f", { ctrl: true }), "COMPOSE").action).toBe("toggle-compose-fullscreen");
    expect(resolveKey(key("up", { ctrl: true }), "COMPOSE").action).toBe("history-previous");
    expect(resolveKey(key("down", { ctrl: true }), "COMPOSE").action).toBe("history-next");
    expect(resolveKey(key("?"), "COMPOSE")).toEqual({ action: "input", text: "?" });
  });

  test("compose moves and deletes by word, as the editor does", () => {
    // The writer who learned these in the full-screen editor keeps them here.
    expect(resolveKey(key("left", { ctrl: true }), "COMPOSE"))
      .toEqual({ action: "cursor-word-left" });
    expect(resolveKey(key("right", { meta: true }), "COMPOSE"))
      .toEqual({ action: "cursor-word-right" });
    // Compose spells an extended selection as a flag; the editor spells it as
    // its own action. Pin the flag so the two encodings cannot silently swap.
    expect(resolveKey(key("left", { ctrl: true, shift: true }), "COMPOSE"))
      .toEqual({ action: "cursor-word-left", extendSelection: true });

    expect(resolveKey(key("backspace"), "COMPOSE").action).toBe("backspace");
    expect(resolveKey(key("delete"), "COMPOSE").action).toBe("delete-forward");
    // Terminals send a bare BS byte for ctrl+backspace, so the modifier that
    // reaches us is alt/option — and ctrl+w is the delete that always lands.
    expect(resolveKey(key("backspace", { meta: true }), "COMPOSE").action)
      .toBe("delete-word-left");
    expect(resolveKey(key("delete", { ctrl: true }), "COMPOSE").action)
      .toBe("delete-word-right");
    expect(resolveKey(key("w", { ctrl: true }), "COMPOSE").action).toBe("delete-word-left");
    expect(resolveKey(key("k", { ctrl: true }), "COMPOSE").action).toBe("delete-line-end");
    expect(resolveKey(key("u", { ctrl: true }), "COMPOSE").action).toBe("delete-line-start");
    // Plain letters are still prose.
    expect(resolveKey(key("w"), "COMPOSE")).toEqual({ action: "input", text: "w" });
    expect(resolveKey(key("k"), "COMPOSE")).toEqual({ action: "input", text: "k" });
  });

  test("inline editor owns multiline input and saves with Ctrl+S / Ctrl+O", () => {
    expect(resolveKey(key("return"), "EDITOR").action).toBe("newline");
    // Linefeed must resolve as newline, not as input that bypasses Fact-tag guards.
    expect(resolveKey(key("linefeed", { sequence: "\n" }), "EDITOR").action).toBe("newline");
    expect(resolveKey(key("j", { sequence: "\n", ctrl: true }), "EDITOR").action).toBe("newline");
    expect(resolveKey(key("s"), "EDITOR")).toEqual({ action: "input", text: "s" });
    expect(resolveKey(key("s", { sequence: "\u0013", ctrl: true }), "EDITOR").action).toBe("save-edit");
    // Portable same-take chord: classic terminals deliver ctrl+o as 0x0f.
    expect(resolveKey(key("o", { sequence: "\u000f", ctrl: true }), "EDITOR").action)
      .toBe("save-edit-inplace");
    // Enhanced terminals may still report ctrl+shift+s distinctly.
    expect(resolveKey(key("s", { ctrl: true, shift: true }), "EDITOR").action).toBe("save-edit-inplace");
    // Without a shift bit, ctrl+shift+s collapses to the fork chord.
    expect(resolveKey(key("s", { sequence: "\u0013", ctrl: true, shift: false }), "EDITOR").action)
      .toBe("save-edit");
    expect(resolveKey(key("escape"), "EDITOR").action).toBe("cancel");
    expect(resolveKey(key("R", { sequence: "R", shift: true }), "EDITOR")).toEqual({ action: "input", text: "R" });
    expect(resolveKey(key("left", { shift: true }), "EDITOR"))
      .toEqual({ action: "cursor-left", extendSelection: true });
  });

  test("inline Settings fields preserve shifted keyboard selection", () => {
    const typing = { overlayTyping: true };
    expect(resolveKey(key("p"), "SETTINGS").action).toBe("detect-context");
    expect(resolveKey(key("p"), "SETTINGS", typing))
      .toEqual({ action: "input", text: "p" });
    expect(resolveKey(key("left", { shift: true }), "SETTINGS", typing))
      .toEqual({ action: "cursor-left", extendSelection: true });
    expect(resolveKey(key("right", { shift: true }), "SETTINGS", typing))
      .toEqual({ action: "cursor-right", extendSelection: true });
    expect(resolveKey(key("home", { shift: true }), "SETTINGS", typing))
      .toEqual({ action: "cursor-line-start", extendSelection: true });
    expect(resolveKey(key("end", { shift: true }), "SETTINGS", typing))
      .toEqual({ action: "cursor-line-end", extendSelection: true });
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
    expect(resolveKey(key("left", { shift: true }), "EDITOR"))
      .toEqual({ action: "cursor-left", extendSelection: true });
    expect(resolveKey(key("right", { ctrl: true }), "EDITOR").action).toBe("cursor-word-right");
    expect(resolveKey(key("b", { ctrl: true }), "EDITOR").action).toBe("cursor-left");
    expect(resolveKey(key("left", { ctrl: true, shift: true }), "EDITOR"))
      .toEqual({ action: "cursor-word-left", extendSelection: true });
    expect(resolveKey(key("c", { ctrl: true }), "EDITOR").action).toBe("copy-selection");
    expect(resolveKey(key("x", { ctrl: true }), "EDITOR").action).toBe("cut-selection");
    expect(resolveKey(key("v", { ctrl: true }), "EDITOR").action).toBe("paste-clipboard");
    expect(resolveKey(key("backspace", { meta: true }), "EDITOR").action).toBe("delete-word-left");
    expect(resolveKey(key("backspace", { ctrl: true }), "EDITOR").action).toBe("delete-word-left");
    expect(resolveKey(key("k", { ctrl: true }), "EDITOR").action).toBe("delete-line-end");
    expect(resolveKey(key("a", { ctrl: true }), "EDITOR").action).toBe("cursor-line-start");
    expect(resolveKey(key("home", { shift: true }), "EDITOR"))
      .toEqual({ action: "cursor-line-start", extendSelection: true });
    expect(resolveKey(key("home", { ctrl: true, shift: true }), "EDITOR"))
      .toEqual({ action: "cursor-buffer-start", extendSelection: true });
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
    expect(resolveKey(key("G", { ctrl: true, shift: true }), "COMPOSE").action)
      .toBe("toggle-context-meter");
    expect(resolveKey(key("up", { ctrl: true, shift: true }), "COMPOSE").action)
      .toBe("history-previous");
    expect(resolveKey(key("/"), "NAV").action).toBe("open-search");
    expect(resolveKey(key("?", { shift: true }), "NAV").action).toBe("open-keys");
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
      resolveKey(shifted("x")[0]!, "COMMANDS", { commandsTags: true }),
      resolveKey(shifted("x")[0]!, "TAG", { tagChoosingStatus: true })
    ];
    expect(destructiveRoutes.map(({ action }) => action)).toEqual(
      Array.from({ length: destructiveRoutes.length }, () => "none")
    );
    for (const event of shifted("x")) {
      expect(resolveKey(event, "TAG")).toEqual({ action: "input", text: "X" });
    }
  });

  test("d is a name character while typing, delete only during status choice", () => {
    expect(resolveKey(key("d"), "TAG")).toEqual({ action: "input", text: "d" });
    expect(resolveKey(key("d"), "TAG", { tagChoosingStatus: true }).action).toBe("delete-tag");
  });

  test("NAV Enter directs, Space continues, and n starts a new story", () => {
    expect(resolveKey(key("return"), "NAV").action).toBe("compose");
    expect(resolveKey(key("i"), "NAV").action).toBe("compose");
    expect(resolveKey(key("space", { sequence: " " }), "NAV").action).toBe("continue");
    expect(resolveKey(key("n"), "NAV").action).toBe("new-item");
    expect(resolveKey(key("m"), "NAV").action).toBe("open-map");
    expect(resolveKey(key("t"), "NAV").action).toBe("tag");
    expect(resolveKey(key("b"), "NAV").action).toBe("none");
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
      expect(resolveKey(event, "TAG", offline)).toEqual({ action: "input", text: "R" });
    }
    expect(resolveKey(key("R", { shift: true }), "LIBRARY", {
      ...offline, overlayTyping: true
    })).toEqual({ action: "input", text: "R" });
    expect(resolveKey(key("R", { shift: true }), "CHAPTERS", {
      ...offline, overlayTyping: true
    })).toEqual({ action: "input", text: "R" });
    expect(resolveKey(key("R", { shift: true }), "COMMANDS", {
      ...offline, commandsTags: true
    }).action).toBe("retry");
  });

  test("palette query accepts d and e; d deletes only in tags", () => {
    expect(resolveKey(key("d"), "COMMANDS")).toEqual({ action: "input", text: "d" });
    expect(resolveKey(key("e"), "COMMANDS")).toEqual({ action: "input", text: "e" });
    expect(resolveKey(key("d"), "COMMANDS", { commandsTags: true }).action).toBe("delete-item");
  });
});

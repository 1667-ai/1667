import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { dispatch, initialState } from "../src/app.js";
import { commandContext, commandMatches } from "../src/command-model.js";
import { setComposerText } from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { openPartEditor } from "../src/editor-action.js";
import { hitAt } from "../src/hit.js";
import { resolveKey, type AppMode, type KeyAction, type ResolveOptions } from "../src/keys.js";
import {
  captureMouseActionState,
  createFactDoubleClickGate,
  mouseToAction
} from "../src/mouse-actions.js";
import { createStoryViewModel, rowPart } from "../src/model.js";
import {
  beginSettingsRowEdit,
  initialSettingsOverlay
} from "../src/settings-overlay-model.js";
import {
  TAGS_FOOTER_ACTIONS, CHAPTERS_FOOTER_ACTIONS, COMMANDS_FOOTER_ACTIONS,
  FACTS_FOOTER_ACTIONS, LIBRARY_FOOTER_ACTIONS, SETTINGS_FOOTER_ACTIONS
} from "../src/screens/panels.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine, visibleWidth } from "../src/screens/story/frame.js";
import { createWrapCache } from "../src/wrap.js";
import { openTextActions } from "../src/text-actions.js";

const STREAM_STARTED_AT = "2026-07-22T00:00:00.000Z";

/** The hit map is rebuilt by rendering, so it has to be tested through a real
 *  frame — hand-built rows would not catch drift between the two. */
function render(state: ReturnType<typeof initialState>, width = 120, height = 30) {
  const rendered = renderStoryScreen(state, { width, height, wrapCache: createWrapCache() });
  Object.assign(state, rendered.derived);
  return rendered.lines;
}

const click = (x: number, y: number, button = 0) => ({
  type: "down", button, x, y, modifiers: { shift: false, alt: false, ctrl: false }
}) as never;

const key = (name: string): KeyEvent => ({
  name, sequence: name, shift: false, ctrl: false, meta: false
}) as KeyEvent;

type State = ReturnType<typeof initialState>;
type Source = ReturnType<typeof demoAppSource>;
type FooterActions = ReadonlyArray<{ token: string; action: KeyAction }>;

function showMap(state: State, view: "path" | "tree" | "mass" = "path", cursorId = "p12") {
  state.mode = "MAP";
  state.map = {
    view,
    pathCursorId: cursorId,
    pathShowAllTakes: true,
    treeCursorId: cursorId,
    rowIds: [],
    showSketches: false,
    openedColdFolds: new Set(),
    massSort: "size"
  };
}

interface FooterCase {
  name: string;
  mode: AppMode;
  actions: FooterActions;
  keys: KeyEvent[];
  options?: ResolveOptions;
  setup: (state: State, source: Source) => void;
}

const footerCases: FooterCase[] = [
  { name: "facts", mode: "FACTS", actions: FACTS_FOOTER_ACTIONS,
    keys: [key("up"), key("down"), key("tab"), key("return"), key("/"), key("e"), key("n"), key("x"), key("escape")],
    setup: (state) => { state.mode = "FACTS"; state.facts = { cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null }; } },
  { name: "library", mode: "LIBRARY", actions: LIBRARY_FOOTER_ACTIONS,
    keys: [key("up"), key("down"), key("return"), key("n"), key("r"), key("/"), key("d"), key("escape")],
    setup: (state, source) => { state.mode = "LIBRARY"; state.library = { stories: source.stories, cursor: 0, query: "", prompt: null }; } },
  { name: "chapters", mode: "CHAPTERS", actions: CHAPTERS_FOOTER_ACTIONS,
    keys: [key("return"), key("s"), key("e"), key("n"), key("d"), key("escape")],
    setup: (state) => { state.mode = "CHAPTERS"; state.chapters = { cursor: 0, rename: null, deleteArmedId: null }; } },
  { name: "commands", mode: "COMMANDS", actions: COMMANDS_FOOTER_ACTIONS,
    keys: [key("return"), key("up"), key("down"), key("escape")],
    setup: (state) => { state.mode = "COMMANDS"; state.commands = { query: "", cursor: 0, selectedId: null, view: "commands", returnMode: "NAV" }; } },
  { name: "tag manager", mode: "COMMANDS", actions: TAGS_FOOTER_ACTIONS,
    keys: [key("up"), key("down"), key("x"), key("escape")], options: { commandsTags: true },
    setup: (state) => { state.mode = "COMMANDS"; state.commands = { query: "", cursor: 0, selectedId: null, view: "tags", returnMode: "NAV" }; } },
  { name: "settings", mode: "SETTINGS", actions: SETTINGS_FOOTER_ACTIONS,
    keys: [
      key("up"), key("down"), key("left"), key("right"),
      key("return"), key("s"), key("c"), key("escape")
    ],
    setup: (state, source) => {
      state.mode = "SETTINGS";
      state.settings = initialSettingsOverlay(source.settingsView, state.config);
    } }
];

function clickText(frame: ReturnType<typeof render>, state: ReturnType<typeof initialState>, text: string) {
  const row = frame.findIndex((line) => plainLine(line).includes(text));
  expect(row).toBeGreaterThan(-1);
  const rendered = plainLine(frame[row]!);
  const left = visibleWidth(rendered.slice(0, rendered.indexOf(text)));
  return mouseToAction(click(left + Math.floor(visibleWidth(text) / 2), row), state);
}

describe("hit map from rendered frames", () => {
  test("rendering returns presentation state without committing it", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    const hitRows = [{ target: { kind: "panel" as const }, left: 1, right: 2 }];
    showMap(state);
    const map = state.map!;
    map.rowIds = ["previous-row"];
    state.hitRows = hitRows;
    state.lastViewportStart = -1;

    const rendered = renderStoryScreen(state, { width: 120, height: 30, wrapCache: createWrapCache() });

    expect(state.hitRows).toBe(hitRows);
    expect(state.map).toBe(map);
    expect(map.rowIds).toEqual(["previous-row"]);
    expect(state.lastViewportStart).toBe(-1);
    expect(rendered.derived.hitRows).not.toBe(hitRows);
    expect(rendered.derived.map).not.toBe(map);
    expect(rendered.derived.map?.rowIds).toContain("p12");
  });

  test("a presented map frame keeps its own cursor rows when live state advances", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    showMap(state, "path", "p12");
    render(state);
    const selectedIndex = state.map!.rowIds.indexOf("p12");
    const row = state.hitRows.findIndex((hit) => hit?.target.kind === "list"
      && hit.target.index === selectedIndex);
    expect(row).toBeGreaterThan(-1);
    const x = state.hitRows[row]!.left + 2;
    const presented = captureMouseActionState(state);

    // A later reducer/frame may mutate the live row index before the native
    // click arrives. The event must still resolve against what was painted.
    state.map!.rowIds.splice(0, state.map!.rowIds.length, "new-frame-row");
    expect(mouseToAction(click(x, row), presented)).toEqual({ action: "open-selected" });
    expect(mouseToAction(click(x, row), state)).toEqual({ action: "focus-index", index: selectedIndex });
  });

  test("command clicks use the selection painted after a live Suggested reorder", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = { targetId: "p13", parentId: "p12", append: true,
      startedAt: STREAM_STARTED_AT, instruction: "", text: "" };
    state.abort = {
      kind: "generation",
      controller: new AbortController(),
      stopInteractionVersion: null
    };
    const active = commandMatches("", state.demo, commandContext(state.payload, {
      connectionDown: false, requestActive: true, canRewriteSelection: false
    }));
    const staleCursor = active.findIndex(({ command }) => command.id === "switch-story");
    state.mode = "COMMANDS";
    state.commands = {
      query: "", cursor: staleCursor, selectedId: "switch-story", view: "commands",
      returnMode: "NAV"
    };

    state.stream = null;
    state.abort = null;
    const settled = commandMatches("", state.demo, commandContext(state.payload, {
      connectionDown: false, requestActive: false, canRewriteSelection: false
    }));
    const exportCursor = settled.findIndex(({ command }) => command.id === "export");
    const switchCursor = settled.findIndex(({ command }) => command.id === "switch-story");
    expect(staleCursor).not.toBe(switchCursor);
    const frame = render(state);

    expect(clickText(frame, state, "switch story")).toEqual({ action: "open-selected" });
    const exportClick = clickText(frame, state, "export markdown");
    expect(exportClick).toEqual({ action: "focus-index", index: exportCursor });
    await dispatch(exportClick!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.commands?.selectedId).toBe("export");
  });

  test("non-generation backend work keeps palette paint and reducer order identical", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const leafId = state.payload.path.at(-1)?.id;
    state.payload = {
      ...state.payload,
      tags: state.payload.tags.filter(({ nodeId }) => nodeId !== leafId)
    };
    const ready = commandMatches("", state.demo, commandContext(state.payload, {
      connectionDown: false, requestActive: false, canRewriteSelection: false
    }));
    state.backendTask = {
      id: 41, kind: "connection-reconcile", label: "reloading after reconnect",
      storyId: state.payload.id
    };
    state.mode = "COMMANDS";
    state.commands = {
      query: "",
      cursor: ready.findIndex(({ command }) => command.id === "summary"),
      selectedId: "summary",
      view: "commands",
      returnMode: "NAV"
    };

    const frame = render(state);
    const exportCursor = ready.findIndex(({ command }) => command.id === "export");
    const exportClick = clickText(frame, state, "export markdown");
    expect(exportClick).toEqual({ action: "focus-index", index: exportCursor });
    await dispatch(exportClick!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.commands?.selectedId).toBe("export");

    await dispatch(
      { action: "focus-previous" }, state, source, createWrapCache(),
      () => {}, async () => {}, () => {}
    );
    expect(state.commands?.selectedId).toBe("tag-line");
  });

  test("prose rows resolve to the part that drew them", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    render(state);
    const parts = state.hitRows
      .map((row) => row?.target)
      .filter((target): target is { kind: "part"; index: number; rowId: string } => target?.kind === "part");
    expect(parts.length).toBeGreaterThan(5);
    // Parts appear in reading order, never interleaved.
    const indexes = parts.map((target) => target.index);
    expect([...indexes].sort((left, right) => left - right)).toEqual(indexes);
  });

  test("clicking a prompt expands its full selectable text and clicking again collapses it", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    const target = rowPart(createStoryViewModel(state.payload), state.focusIndex)!;
    const instruction = "Keep the lantern low while Maren crosses the flooded gallery, then reveal the final prompt token.";
    state.payload = {
      ...state.payload,
      path: state.payload.path.map((node) => node.id === target.id ? { ...node, instruction } : node)
    };
    source.payload = state.payload;

    render(state, 80, 24);
    const promptHit = state.hitRows.flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .find(({ hit }) => hit.target.kind === "prompt" && hit.target.index === state.focusIndex);
    expect(promptHit).toBeDefined();
    const expand = mouseToAction(click(promptHit!.hit.left + 2, promptHit!.y), state);
    expect(expand).toEqual({
      action: "toggle-prompt",
      index: state.focusIndex,
      rowId: target.id
    });

    await dispatch(expand!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    const expanded = render(state, 80, 24);
    expect(expanded.map(plainLine).join("\n")).toContain("final prompt token.");
    expect(state.expandedPromptIds).toContain(target.id);
    const expandedHits = state.hitRows.flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .filter(({ hit }) => hit.target.kind === "prompt" && hit.target.index === state.focusIndex);
    expect(expandedHits.length).toBeGreaterThan(1);
    expect(mouseToAction({
      type: "down", button: 0, x: expandedHits[0]!.hit.left + 2, y: expandedHits[0]!.y,
      modifiers: { shift: true, alt: false, ctrl: false }
    } as never, state)).toBe(null);

    const collapse = mouseToAction(click(expandedHits[0]!.hit.left + 2, expandedHits[0]!.y), state);
    await dispatch(collapse!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.expandedPromptIds).not.toContain(target.id);
  });

  test("the status row is inert and the composer is clickable", () => {
    const state = initialState(demoAppSource(), false);
    render(state, 120, 30);
    expect(hitAt(state.hitRows, 5, 29)).toBe(null);
    expect(state.hitRows.some((row) => row?.target.kind === "composer")).toBeTrue();
  });

  test("an open list panel makes everything outside it scrim", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.mode = "LIBRARY";
    state.library = { stories: demoAppSource().stories, cursor: 0, query: "", prompt: null };
    render(state);
    // No story part survives underneath an open panel.
    expect(state.hitRows.some((row) => row?.target.kind === "part")).toBeFalse();
    expect(hitAt(state.hitRows, 2, 1)).toEqual({ kind: "scrim" });
    expect(mouseToAction(click(2, 1), state)).toEqual({ action: "cancel" });
  });

  test("the profile source modal owns page hits and makes its rows clickable", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.settings.profileTransfer = { phase: "source", cursor: 0, error: null };
    render(state);

    expect(state.hitRows.some((row) => row?.target.kind === "settings-row")).toBeFalse();
    expect(hitAt(state.hitRows, 2, 1)).toEqual({ kind: "scrim" });
    expect(mouseToAction(click(2, 1), state)).toEqual({ action: "cancel" });

    const sourceRow = state.hitRows.flatMap((entry, row) => entry?.overrides?.map((hit) => ({ hit, row })) ?? [])
      .find(({ hit }) => hit.target.kind === "list" && hit.target.index === 1);
    expect(sourceRow).toBeDefined();
    expect(hitAt(state.hitRows, sourceRow!.hit.left, sourceRow!.row))
      .toEqual({ kind: "list", index: 1, selected: false });
    const focus = mouseToAction(click(sourceRow!.hit.left, sourceRow!.row), state);
    expect(focus).toEqual({ action: "focus-index", index: 1 });
    await dispatch(focus!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.settings.profileTransfer?.phase).toBe("source");
    expect(state.settings.profileTransfer?.cursor).toBe(1);

    render(state);
    const selectedRow = state.hitRows.flatMap((entry, row) => entry?.overrides?.map((hit) => ({ hit, row })) ?? [])
      .find(({ hit }) => hit.target.kind === "list" && hit.target.index === 1);
    expect(mouseToAction(click(selectedRow!.hit.left, selectedRow!.row), state))
      .toEqual({ action: "open-selected" });
  });

  test("connection retry does not leak across shared panel hit rows", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.mode = "LIBRARY";
    state.library = { stories: demoAppSource().stories, cursor: 0, query: "", prompt: null };
    state.connection = { ...state.connection, down: true };
    render(state);
    const frame = render(state);
    expect(clickText(frame, state, "R retries now")).toEqual({ action: "retry" });
    expect(mouseToAction(click(2, 0), state)).toEqual({ action: "cancel" });
    expect(mouseToAction(click(2, 0, 2), state)).toEqual({ action: "cancel" });
    const scrim = state.hitRows.findIndex((row, index) => index > 0 && row?.target.kind === "scrim");
    expect(scrim).toBeGreaterThan(0);
    expect(mouseToAction(click(2, scrim), state)).toEqual({ action: "cancel" });
  });

  test("offline banner click retries through an open part menu", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    let retries = 0;
    source.connection = {
      api: source.api,
      state: () => ({ down: false, attempt: 0, nextRetryAt: null, error: null }),
      retryNow: async () => { retries += 1; return true; },
      subscribe: () => () => undefined,
      dispose: () => undefined
    };
    state.connection = { down: true, attempt: 1, nextRetryAt: null, error: "offline" };
    state.actions = {
      partId: state.payload.path.at(-1)!.id,
      cursor: 0,
      selectionText: null
    };
    const menu = state.actions;
    const frame = render(state);
    const retry = clickText(frame, state, "R retries now");
    expect(retry).toEqual({ action: "retry" });

    await dispatch(retry!, state, source, createWrapCache(), () => {}, async () => {}, () => {});

    expect(retries).toBe(1);
    expect(state.actions).toBe(menu);
    expect(state.connection.down).toBeFalse();
  });

  test("offline text entry keeps retry clickable without advertising R", () => {
    const source = demoAppSource();
    const compose = initialState(source, false);
    compose.mode = "COMPOSE";
    const settings = initialState(source, false);
    settings.mode = "SETTINGS";
    settings.settings = initialSettingsOverlay(source.settingsView, settings.config);
    // Row 1 is "system-prompt" by default (simple mode), which
    // beginSettingsRowEdit refuses (it opens the full-screen editor
    // instead). Move to "provider", an ordinary inline row, so this state
    // actually owns text like the other two surfaces under test.
    settings.settings.cursor = 2;
    beginSettingsRowEdit(settings.settings, settings.config);
    const editor = initialState(source, false);
    openPartEditor(editor, false);

    for (const state of [compose, settings, editor]) {
      state.stream = null;
      state.connection = { ...state.connection, down: true };
      openTextActions(state);
      const frame = render(state);
      const banner = plainLine(frame[0]!);
      expect(banner).toContain("retry now");
      expect(banner).not.toContain("R retries now");
      expect(clickText(frame, state, "retry now")).toEqual({ action: "retry" });
    }
  });

  test("non-list modal panels also own every page hit", () => {
    const source = demoAppSource();
    const states = [
      Object.assign(initialState(source, false), { mode: "KEYS" as const }),
      Object.assign(initialState(source, false), {
        mode: "SETTINGS" as const,
        settings: initialSettingsOverlay(source.settingsView, source.config)
      }),
      Object.assign(initialState(source, false), {
        mode: "SUMMARY" as const,
        summary: { start: 1, end: 2, totalParts: 2, text: "", controller: new AbortController() }
      })
    ];
    for (const state of states) {
      state.stream = null;
      render(state);
      expect(hitAt(state.hitRows, 2, 1)).toEqual({ kind: "scrim" });
      expect(mouseToAction(click(2, 1), state)).toEqual({ action: "cancel" });
    }
  });

  test("panel rows only answer within the panel's own columns", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.mode = "LIBRARY";
    state.library = { stories: demoAppSource().stories, cursor: 0, query: "", prompt: null };
    render(state);
    const located = state.hitRows.flatMap((entry, row) => entry?.overrides?.map((hit) => ({ hit, row })) ?? [])
      .find(({ hit }) => hit.target.kind === "list");
    expect(located).toBeDefined();
    expect(hitAt(state.hitRows, located!.hit.left + 2, located!.row)?.kind).toBe("list");
    const outside = Math.max(0, located!.hit.left - 2);
    expect(hitAt(state.hitRows, outside, located!.row)).toEqual({ kind: "scrim" });
    expect(mouseToAction(click(outside, located!.row), state)).toEqual({ action: "cancel" });
  });

  test("panel chrome is inert — only outside clicks dismiss", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.mode = "LIBRARY";
    state.library = { stories: demoAppSource().stories, cursor: 0, query: "", prompt: null };
    render(state);
    const located = state.hitRows.flatMap((entry, row) => entry?.overrides?.map((hit) => ({ hit, row })) ?? [])
      .find(({ hit }) => hit.target.kind === "list");
    expect(located).toBeDefined();
    // The title sits two rows above the first list row.
    expect(hitAt(state.hitRows, located!.hit.left + 4, located!.row - 2)).toEqual({ kind: "panel" });
    expect(mouseToAction(click(located!.hit.left + 4, located!.row - 2), state)).toBe(null);
  });

  test("a click outside the right-click actions menu dismisses it", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.actions = {
      cursor: 0,
      partId: createStoryViewModel(state.payload).rows[state.focusIndex]!.id,
      selectionText: null
    };
    state.mode = "ACTIONS";
    render(state);
    expect(hitAt(state.hitRows, 1, 1)).toEqual({ kind: "scrim" });
    expect(mouseToAction(click(1, 1), state)).toEqual({ action: "cancel" });
  });

  test("inline footer and focused-part controls dispatch their named actions", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    const frame = render(state, 160);
    expect(clickText(frame, state, "r retake")).toEqual({ action: "regenerate" });
    expect(clickText(frame, state, "R reprompt")).toEqual({ action: "retake-with-prompt" });
    expect(clickText(frame, state, "w write")).toEqual({ action: "write" });
    expect(clickText(frame, state, "e edit")).toEqual({ action: "edit" });
    expect(clickText(frame, state, "↵ direct")).toEqual({ action: "compose" });
    expect(clickText(frame, state, "enter direct")).toEqual({ action: "compose" });
    expect(clickText(frame, state, "space continues")).toEqual({ action: "continue" });
    expect(clickText(frame, state, "a aside")).toEqual({ action: "open-aside" });
    expect(clickText(frame, state, "n note")).toEqual({ action: "open-authors-note" });
    expect(clickText(frame, state, "? keys")).toEqual({ action: "open-keys" });
  });

  test("part controls and rail facts are inert while direction entry owns input", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.mode = "COMPOSE";
    const frame = render(state, 150, 30);
    expect(clickText(frame, state, "r retake")).toBe(null);
    expect(clickText(frame, state, "R reprompt")).toBe(null);
    expect(clickText(frame, state, "w write")).toBe(null);
    const fact = state.hitRows.flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .find(({ hit }) => hit.target.kind === "fact");
    expect(fact).toBeDefined();
    expect(mouseToAction(click(fact!.hit.left + 1, fact!.y), state)).toBe(null);
  });

  test("stream stop labels remain active in NAV and direction entry", () => {
    const state = initialState(demoAppSource(), false);
    const focused = createStoryViewModel(state.payload).parts.at(-2)!;
    state.focusIndex = createStoryViewModel(state.payload).rows.findIndex((row) => row.id === focused.id);
    state.stream = { targetId: focused.id, parentId: focused.node.parentId, append: true,
      startedAt: STREAM_STARTED_AT, instruction: "", text: " arriving" };
    expect(clickText(render(state), state, "esc stops")).toEqual({ action: "cancel" });
    state.mode = "COMPOSE";
    expect(clickText(render(state), state, "esc stops")).toEqual({ action: "cancel" });
    state.mode = "NAV";
    const narrow = render(state, 80, 24);
    expect(clickText(narrow, state, "esc stops")).toEqual({ action: "cancel" });
    const boundaryRow = narrow.findIndex((line) => plainLine(line).includes("esc stops"));
    const boundaryText = plainLine(narrow[boundaryRow]!);
    const writing = visibleWidth(boundaryText.slice(0, boundaryText.indexOf("writing"))) + 1;
    expect(mouseToAction(click(writing, boundaryRow), state)?.action).not.toBe("cancel");
  });

  test("a fresh one-line direct stream exposes its wide stop action immediately", () => {
    const state = initialState(demoAppSource(), false);
    const parent = state.payload.path[5]!;
    state.stream = {
      targetId: "short-direct-stream",
      parentId: parent.id,
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "Turn toward the rain.",
      text: "Ink.",
      partNumber: 7
    };
    const view = createStoryViewModel(state.payload, state.stream);
    state.focusIndex = view.rows.findIndex((row) => row.id === state.stream!.targetId);

    const frame = render(state, 120, 30);
    expect(clickText(frame, state, "esc stops"))
      .toEqual({ action: "cancel" });
    const proseRow = frame.findIndex((line) => plainLine(line).includes("Ink."));
    const stopRow = frame.findIndex((line) => plainLine(line).includes("esc stops"));
    expect(frame[proseRow]!.some((part) => part.text === "▏")).toBeTrue();
    expect(frame[stopRow]!.some((part) => part.text === "▏")).toBeFalse();
  });

  test("a wrapped stream owns every gutter row without leaking part verbs", () => {
    const state = initialState(demoAppSource(), false);
    const parent = state.payload.path[5]!;
    state.stream = {
      targetId: "wrapped-direct-stream",
      parentId: parent.id,
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "Hold the rain against the window.",
      text: "Rain crossed the window in deliberate silver lines while the room held its breath. ".repeat(5),
      partNumber: 7
    };
    const view = createStoryViewModel(state.payload, state.stream);
    state.focusIndex = view.rows.findIndex((row) => row.id === state.stream!.targetId);

    const frame = render(state, 120, 30);
    const streamRows = frame.filter((_line, row) => {
      const target = state.hitRows[row]?.target;
      return target?.kind === "part" && target.index === state.focusIndex;
    });
    const proseRows = streamRows.filter((line) => line.some((part) => part.role === "streaming" && part.text !== ""));
    const gutterActions = streamRows.flatMap((line) => line.flatMap((part) => part.hit?.kind === "inline-action"
      ? [{ text: part.text, action: part.hit.action }]
      : []));

    expect(proseRows.length).toBeGreaterThan(2);
    expect(streamRows.some((line) => plainLine(line).includes("writing"))).toBeTrue();
    expect(streamRows.some((line) => plainLine(line).includes("esc stops"))).toBeTrue();
    expect(gutterActions).toEqual([{ text: "esc stops", action: "cancel" }]);
  });

  test("all map views own a full-bleed screen without story or scrim hits", () => {
    for (const view of ["path", "tree", "mass"] as const) {
      const state = initialState(demoAppSource(), false);
      state.stream = null;
      showMap(state, view, view === "path" ? "p12" : state.payload.path.at(-1)!.id);
      const frame = render(state);
      expect(plainLine(frame[0]!)).toContain("map ·");
      expect(state.hitRows.some((row) => row?.target.kind === "list")).toBeTrue();
      expect(state.hitRows.some((row) => row?.target.kind === "part" || row?.target.kind === "composer"
        || row?.target.kind === "scrim")).toBeFalse();
      expect(hitAt(state.hitRows, 1, 0)).toBe(null);
      expect(mouseToAction(click(1, 0), state)).toBe(null);
    }
  });

  test("offline and chapter controls dispatch every displayed action", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.connection = { ...state.connection, down: true };
    expect(clickText(render(state), state, "R retries")).toEqual({ action: "retry" });

    state.connection = { ...state.connection, down: false };
    const rows = createStoryViewModel(state.payload).rows;
    const summaryIndex = rows.findIndex((row) => row.kind === "chapter-summary");
    expect(summaryIndex).toBeGreaterThan(-1);
    state.focusIndex = summaryIndex;
    let frame = render(state);
    expect(clickText(frame, state, "enter expands")).toEqual({ action: "compose" });
    expect(clickText(frame, state, "e edit")).toEqual({ action: "edit" });
    const summaryRow = rows[summaryIndex]!;
    expect(clickText(frame, state, summaryRow.kind === "chapter-summary" && summaryRow.chapter.stale
      ? "r refresh" : "r re-summarize")).toEqual({ action: "regenerate" });

    const dividerIndex = rows.findIndex((row) => row.kind === "chapter-divider");
    expect(dividerIndex).toBeGreaterThan(-1);
    state.focusIndex = dividerIndex;
    frame = render(state);
    expect(clickText(frame, state, "e rename")).toEqual({ action: "edit" });
    expect(clickText(frame, state, "d remove")).toEqual({ action: "prune" });
    expect(clickText(frame, state, "r summarize chapter above")).toEqual({ action: "regenerate" });
  });

  test("right-clicking an inline part control keeps the part-row action menu", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    const frame = render(state);
    const row = frame.findIndex((line) => plainLine(line).includes("r retake"));
    const rendered = plainLine(frame[row]!);
    const left = visibleWidth(rendered.slice(0, rendered.indexOf("r retake")));
    expect(mouseToAction(click(left + 2, row, 2), state)).toEqual({
      action: "open-actions",
      index: state.focusIndex,
      rowId: rowPart(createStoryViewModel(state.payload), state.focusIndex)?.id
    });
  });

  test("clicking a rail fact opens that exact fact", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    render(state, 150, 30);
    const located = state.hitRows.flatMap((row, y) => row === null ? [] : [row, ...(row.overrides ?? [])]
      .map((hit) => ({ hit, y })))
      .find(({ hit }) => hit.target.kind === "fact" && hit.target.index === 1);
    expect(located).toBeDefined();
    const resolved = mouseToAction(click(located!.hit.left + 1, located!.y), state);
    expect(resolved).toEqual({ action: "open-facts", index: 1 });
    expect(mouseToAction(click(located!.hit.left + 1, located!.y, 2), state)).toBe(null);
    await dispatch(resolved!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.mode).toBe("FACTS");
    expect(state.facts?.cursor).toBe(1);
  });

  test("keyboard facts open selects the first Fact without an editor", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    await dispatch({ action: "open-facts" }, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.mode).toBe("FACTS");
    expect(state.facts?.cursor).toBe(0);
  });

  test("a Fact row requires two clicks and then opens its editor", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "FACTS";
    state.facts = {
      cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null
    };
    render(state);
    const located = state.hitRows.flatMap((row, y) => row === null
      ? []
      : [row, ...row.overrides ?? []].map((hit) => ({ hit, y })))
      .find(({ hit }) => hit.target.kind === "list" && hit.target.index === 0)!;
    const event = click(located.hit.left + 2, located.y);
    let now = 1_000;
    for (const interruption of ["drag", "scroll"] as const) {
      const interrupted = createFactDoubleClickGate(() => now);
      expect(interrupted.resolve(event, mouseToAction(event, state), state)).toBe(null);
      interrupted.resolve({
        type: interruption,
        button: 0,
        x: located.hit.left + 2,
        y: located.y,
        modifiers: { shift: false, alt: false, ctrl: false }
      } as never, null, state);
      now += 120;
      expect(interrupted.resolve(event, mouseToAction(event, state), state)).toBe(null);
    }

    const gate = createFactDoubleClickGate(() => now);
    expect(gate.resolve(event, mouseToAction(event, state), state)).toBe(null);
    now += 120;
    const edit = gate.resolve(event, mouseToAction(event, state), state);
    expect(edit).toEqual({
      action: "edit",
      index: 0,
      rowId: source.payload.facts[0]!.id
    });
    await dispatch(edit!, state, source, createWrapCache(), () => {}, async () => {}, () => {});

    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("fact");
    if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
    expect(state.editor.target).toMatchObject({ kind: "fact", factId: source.payload.facts[0]!.id });
  });

  test("clicking the selected map row reroutes rather than re-selecting", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    showMap(state, "path", state.payload.path[11]!.id);
    render(state);
    const selectedIndex = state.map!.rowIds.indexOf(state.map!.pathCursorId);
    const selected = state.hitRows
      .map((hit, index) => ({ hit, index }))
      .find((entry) => entry.hit?.target.kind === "list" && entry.hit.target.index === selectedIndex);
    expect(selected).toBeDefined();
    expect(mouseToAction(click(selected!.hit!.left + 4, selected!.index), state)).toEqual({ action: "open-selected" });
  });

  test("map cursor rows come from the rendered window, not a fresh layout", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    showMap(state, "path", state.payload.path[11]!.id);
    // A short terminal renders fewer map rows than the layout default.
    render(state, 120, 12);
    expect(state.map!.rowIds.length).toBeLessThan(13);
    expect(state.map!.rowIds).toContain(state.map!.pathCursorId);
  });

  test("facts filter keeps reducer, highlight, and first-click selection aligned", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const fact = state.payload.facts[0]!;
    state.payload.facts = [
      { ...fact, id: "match-1", text: "Match 01\nfirst" },
      { ...fact, id: "match-2", text: "Match 02\nsecond" },
      ...Array.from({ length: 6 }, (_, index) => ({
        ...fact, id: `other-${index}`, text: `Other ${index}\nbody`
      }))
    ];
    state.mode = "FACTS";
    state.facts = {
      cursor: 6, query: "", chip: 0, selectedTag: null, filtering: true, deleteArmedId: null
    };

    await dispatch(
      { action: "input", text: "match" }, state, source, createWrapCache(),
      () => {}, async () => {}, () => {}
    );
    expect(state.facts.cursor).toBe(1);
    let frame = render(state, 80, 24);
    expect(clickText(frame, state, "Match 02")).toEqual({ action: "open-selected" });

    await dispatch(
      { action: "focus-previous" }, state, source, createWrapCache(),
      () => {}, async () => {}, () => {}
    );
    frame = render(state, 80, 24);
    expect(state.facts.cursor).toBe(0);
    expect(plainLine(frame.find((line) => plainLine(line).includes("Match 01"))!)).toContain("▸ Match 01");

    await dispatch(
      { action: "input", text: "zzzz" }, state, source, createWrapCache(),
      () => {}, async () => {}, () => {}
    );
    await dispatch(
      { action: "focus-next" }, state, source, createWrapCache(),
      () => {}, async () => {}, () => {}
    );
    expect(state.facts.cursor).toBe(0);
  });

  test("fact edits re-bound the active tag and first-click selection", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: ["Alpha", "Bravo", "Charlie"].map((name, index) => ({
        ...template, id: `world-${index}`, tag: "world", text: `${name}\nbody`
      }))
    };
    source.api.patchFact = async (_storyId, factId, patch) => ({
      ...state.payload,
      facts: state.payload.facts.map((fact) => fact.id === factId
        ? { ...fact, tag: patch.tag ?? null, text: patch.text ?? fact.text }
        : fact)
    });
    state.mode = "FACTS";
    state.facts = {
      cursor: 2, query: "", chip: 1, selectedTag: "world", filtering: false, deleteArmedId: null
    };
    await dispatch(
      { action: "edit" }, state, source, createWrapCache(),
      () => {}, async () => {}, () => {}
    );
    if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
    setComposerText(state.editor.tag, "");
    setComposerText(state.editor.composer, "new prose\n");
    await dispatch(
      { action: "save-edit" }, state, source, createWrapCache(),
      () => {}, async () => {}, () => {}
    );

    expect(state.facts).toMatchObject({ chip: 1, cursor: 1 });
    const frame = render(state, 80, 24);
    expect(clickText(frame, state, "Bravo")).toEqual({ action: "open-selected" });
  });
});

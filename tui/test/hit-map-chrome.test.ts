import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { dispatch, initialState } from "../src/app.js";
import { createComposer, setComposerText } from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { openFactEditor } from "../src/editor-action.js";
import {
  FACT_ACTIVATION_COMPOSER_SOURCE,
  FACT_BODY_COMPOSER_SOURCE,
  FACT_KEYS_COMPOSER_SOURCE,
  FACT_TAG_COMPOSER_SOURCE,
  setFactEditorFocus
} from "../src/fact-editor-policy.js";
import { hitAt, type HitTarget } from "../src/hit.js";
import { GUTTER_VERBS } from "../src/screens/story/gutter.js";
import { resolveKey, type AppMode, type KeyAction, type ResolveOptions } from "../src/keys.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import {
  beginSettingsRowEdit,
  initialSettingsOverlay,
  SETTINGS_ROW_IDS,
  settingsRowIndex
} from "../src/settings-overlay-model.js";
import { publishCurrentSettingsModelDiscovery } from "../src/settings-model-discovery.js";
import { currentPartActions, openActions } from "../src/story-actions.js";
import {
  ACTIONS_FOOTER_ACTIONS, TAGS_FOOTER_ACTIONS, CHAPTERS_FOOTER_ACTIONS,
  COMMANDS_FOOTER_ACTIONS, FACTS_FOOTER_ACTIONS, LIBRARY_FOOTER_ACTIONS,
  SETTINGS_FOOTER_ACTIONS
} from "../src/screens/panels.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine, visibleWidth } from "../src/screens/story/frame.js";
import type { FactEditorSession } from "../src/state.js";
import { createWrapCache } from "../src/wrap.js";

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

function currentFactEditor(state: State): FactEditorSession {
  if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
  return state.editor;
}

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
    keys: [key("up"), key("down"), key("tab"), key("return"), key("/"), key("e"), key("n"), key("D"), key("escape")],
    setup: (state) => { state.mode = "FACTS"; state.facts = { cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null }; } },
  { name: "library", mode: "LIBRARY", actions: LIBRARY_FOOTER_ACTIONS,
    keys: [key("up"), key("down"), key("return"), key("n"), key("e"), key("/"), key("D"), key("escape")],
    setup: (state, source) => { state.mode = "LIBRARY"; state.library = { stories: source.stories, cursor: 0, query: "", prompt: null }; } },
  { name: "chapters", mode: "CHAPTERS", actions: CHAPTERS_FOOTER_ACTIONS,
    keys: [key("return"), key("s"), key("e"), key("n"), key("D"), key("escape")],
    setup: (state) => { state.mode = "CHAPTERS"; state.chapters = { cursor: 0, rename: null, deleteArmedId: null }; } },
  { name: "commands", mode: "COMMANDS", actions: COMMANDS_FOOTER_ACTIONS,
    keys: [key("up"), key("down"), key("return"), key("escape")],
    setup: (state) => { state.mode = "COMMANDS"; state.commands = { query: "", cursor: 0, selectedId: null, view: "commands", returnMode: "NAV" }; } },
  { name: "tag manager", mode: "COMMANDS", actions: TAGS_FOOTER_ACTIONS,
    keys: [key("up"), key("down"), key("D"), key("escape")], options: { commandsTags: true },
    setup: (state) => { state.mode = "COMMANDS"; state.commands = { query: "", cursor: 0, selectedId: null, view: "tags", returnMode: "NAV" }; } },
  { name: "part actions", mode: "ACTIONS", actions: ACTIONS_FOOTER_ACTIONS,
    keys: [key("up"), key("down"), key("return"), key("escape")],
    setup: (state) => {
      state.mode = "ACTIONS";
      state.actions = {
        cursor: 0,
        partId: createStoryViewModel(state.payload, state.stream).rows[state.focusIndex]!.id
      };
    } },
  { name: "settings", mode: "SETTINGS", actions: SETTINGS_FOOTER_ACTIONS.map((entry) =>
      entry.action === "toggle-view-mode" ? { ...entry, token: "m simple" } : entry),
    keys: [
      key("up"), key("down"), key("left"), key("right"),
      key("return"), key("s"), key("c"), key("m"), key("escape")
    ],
    setup: (state, source) => {
      state.mode = "SETTINGS";
      // Advanced mode selects the `m simple` footer. Row 0 is "theme", a
      // cycler that selects the choice footer.
      state.config = { ...state.config, settingsViewMode: "advanced" };
      state.settings = initialSettingsOverlay(source.settingsView, state.config);
    } }
];

function installModelChoices(state: State, remoteIds: readonly string[]): void {
  const overlay = state.settings!;
  overlay.draft = {
    ...overlay.draft,
    generation: {
      ...overlay.draft.generation,
      model: remoteIds[0] ?? ""
    }
  };
  publishCurrentSettingsModelDiscovery(overlay, {
    observedAt: "2026-01-01T00:00:00.000Z",
    models: remoteIds.map((remoteId) => ({
      remoteId,
      name: remoteId,
      contextWindow: null,
      maxOutputTokens: null,
      source: "openai-models" as const
    }))
  });
}

function clickText(frame: ReturnType<typeof render>, state: ReturnType<typeof initialState>, text: string) {
  const row = frame.findIndex((line) => plainLine(line).includes(text));
  expect(row).toBeGreaterThan(-1);
  const rendered = plainLine(frame[row]!);
  const left = visibleWidth(rendered.slice(0, rendered.indexOf(text)));
  return mouseToAction(click(left + Math.floor(visibleWidth(text) / 2), row), state);
}

const GUTTER_TOKEN_KEYS: Record<string, string> = {
  "␠": "space", "↵": "return", "r": "r", "R": "R", "w": "w", "e": "e"
};

describe("gutter verbs stay true to the keymap", () => {
  test("every advertised gutter token resolves to the action it names", () => {
    // The gutter is a menu: a verb that names a key the keymap no longer binds
    // is a lie. This caught `↵ continue` after enter was rebound to direct.
    for (const row of GUTTER_VERBS) {
      for (const verb of row) {
        if (verb.token === null) continue;
        const name = GUTTER_TOKEN_KEYS[verb.token];
        expect(name).toBeDefined();
        expect(resolveKey({ name: name!, sequence: name!, shift: false, ctrl: false, meta: false } as never, "NAV").action)
          .toBe(verb.action);
      }
    }
  });
});

describe("hit map clickable chrome", () => {
  test("map views advertise only their live arrow navigation", () => {
    const expected = {
      path: { up: "focus-previous", down: "focus-next", left: "take-previous", right: "take-next", l: "none" },
      // `←→` jump lanes in the tree now (doc "10a"), same as path's takes.
      tree: { up: "focus-previous", down: "focus-next", left: "take-previous", right: "take-next", l: "map-follow" },
      mass: { up: "focus-previous", down: "focus-next", left: "none", right: "none", l: "map-follow" }
    } as const;
    for (const view of ["path", "tree", "mass"] as const) {
      for (const [name, action] of Object.entries(expected[view])) {
        expect(resolveKey(key(name), "MAP", { mapView: view }).action).toBe(action);
      }
      expect(resolveKey(key("h"), "MAP", { mapView: view }).action).toBe("open-records");
      for (const dead of ["j", "k"]) {
        expect(resolveKey(key(dead), "MAP", { mapView: view }).action).toBe("none");
      }
    }
  });

  test("map header tabs and sketch reveal rows are clickable", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    showMap(state, "path", "p12");
    let frame = render(state);

    for (const [view, x] of [["path", 10], ["tree", 17], ["mass", 24]] as const) {
      expect(hitAt(state.hitRows, x, 0)).toEqual({ kind: "map-view", view });
      const resolved = mouseToAction(click(x, 0), state);
      expect(resolved).toEqual({ action: "set-map-view", view });
      await dispatch(resolved!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
      expect(state.map?.view).toBe(view);
    }

    state.map!.view = "path";
    const narrowFrame = render(state, 80, 24);
    expect(clickText(narrowFrame, state, "a branch")).toEqual({ action: "toggle-path-takes" });
    frame = render(state);
    const branches = clickText(frame, state, "a branches");
    expect(branches).toEqual({ action: "toggle-path-takes" });
    await dispatch(branches!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.map?.pathShowAllTakes).toBeFalse();

    state.map!.view = "tree";
    frame = render(state);
    // The fold row states what it holds and names no key; `a` is advertised in
    // the keyline (C-06). Both still answer a click.
    expect(clickText(frame, state, "sketches")).toEqual({ action: "toggle-sketches" });
    const reveal = clickText(frame, state, "a sketches");
    expect(reveal).toEqual({ action: "toggle-sketches" });
    await dispatch(reveal!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.map?.showSketches).toBeTrue();
  });

  test("facts chip overrides win over the panel row and gaps remain inert", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    footerCases[0]!.setup(state, source);
    render(state);
    const rowIndex = state.hitRows.findIndex((row) => row?.overrides?.some((span) => span.target.kind === "chip"));
    const row = state.hitRows[rowIndex]!;
    const chips = row.overrides!.filter((span) => span.target.kind === "chip");
    expect(chips).toHaveLength(5);
    for (const [index, span] of chips.entries()) {
      expect(hitAt(state.hitRows, span.left, rowIndex)).toEqual({ kind: "chip", index });
    }
    expect(hitAt(state.hitRows, chips[0]!.right, rowIndex)).toEqual({ kind: "panel" });
    state.facts!.cursor = 2;
    const resolved = mouseToAction(click(chips[3]!.left, rowIndex), state)!;
    await dispatch(resolved, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.facts).toMatchObject({ chip: 3, cursor: 0 });
  });

  test("every declared footer token is rendered, clickable, and accepted by its handler", () => {
    for (const item of footerCases) {
      const source = demoAppSource();
      const state = initialState(source, false);
      state.stream = null;
      item.setup(state, source);
      const frame = render(state);
      const footerRow = state.hitRows.findIndex((row) =>
        row?.overrides?.filter((region) => region.target.kind === "action").length === item.actions.length);
      expect(footerRow).toBeGreaterThan(-1);
      const line = plainLine(frame[footerRow]!);
      let offset = 0;
      for (const [index, action] of item.actions.entries()) {
        const tokenIndex = line.indexOf(action.token, offset);
        expect(tokenIndex).toBeGreaterThan(-1);
        const x = visibleWidth(line.slice(0, tokenIndex));
        expect(hitAt(state.hitRows, x, footerRow))
          .toEqual({ kind: "action", action: action.action });
        expect(resolveKey(item.keys[index]!, item.mode, item.options).action)
          .toBe(action.action);
        offset = tokenIndex + action.token.length;
      }
    }
  });

  test("every map footer key is clickable and runs what it advertises", () => {
    // The map is full-bleed, so this footer is its only advertised keymap.
    // Only `a branches` used to answer a click; the rest were painted text.
    const expected = {
      path: [["m tree", "cycle-map-view"], ["a branches", "toggle-path-takes"],
        ["enter reroute", "apply"], ["esc writes", "cancel"]],
      tree: [["m mass", "cycle-map-view"], ["a sketches", "toggle-sketches"],
        ["l follow", "map-follow"], ["tab path", "map-hide-lanes"],
        ["enter reroute", "apply"], ["esc writes", "cancel"]],
      mass: [["m path", "cycle-map-view"], ["s sort", "map-cycle-sort"],
        ["a sketches", "toggle-sketches"],
        ["l open line", "map-follow"], ["enter reroute", "apply"], ["esc writes", "cancel"]]
    } as const;
    for (const view of ["path", "tree", "mass"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      state.stream = null;
      showMap(state, view, view === "path" ? "p12" : state.payload.path.at(-1)!.id);
      const frame = render(state, 140, 30);
      for (const [token, action] of expected[view]) {
        expect(clickText(frame, state, token)).toEqual({ action });
        // The click and the key it advertises must reach the same action.
        const named = token.split(" ")[0]!;
        const keyName = named === "enter" ? "return" : named === "esc" ? "escape" : named;
        expect(resolveKey(key(keyName), "MAP", { mapView: view }).action).toBe(action);
      }
      // The glyph pair splits into its two halves rather than one vague target.
      const footer = frame.length - 1;
      const line = plainLine(frame[footer]!);
      const arrows = visibleWidth(line.slice(0, line.indexOf("↑↓")));
      expect(hitAt(state.hitRows, arrows, footer)).toEqual({ kind: "action", action: "focus-previous" });
      expect(hitAt(state.hitRows, arrows + 1, footer)).toEqual({ kind: "action", action: "focus-next" });
      if (view === "tree") {
        // `←→` jumps lanes: its own glyph pair, split the same way `↑↓` is.
        const lanes = visibleWidth(line.slice(0, line.indexOf("←→")));
        expect(hitAt(state.hitRows, lanes, footer)).toEqual({ kind: "action", action: "take-previous" });
        expect(hitAt(state.hitRows, lanes + 1, footer)).toEqual({ kind: "action", action: "take-next" });
      }
    }
  });

  test("the composer footer is clickable while directing and while retaking", async () => {
    // The retake footer used to render as one plain notice string, so it named
    // four keys and answered none of them — and clipped to `esc cance…`.
    for (const [entry, send] of [["i", "enter send"], ["R", "enter retakes with this prompt"]] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      state.stream = null;
      await dispatch(resolveKey(key(entry === "i" ? "i" : "R"), "NAV"), state, source,
        createWrapCache(), () => {}, async () => {}, () => {});
      const frame = render(state, 120, 30);
      expect(plainLine(frame.find((line) => plainLine(line).includes(send))!)).not.toContain("…");
      expect(clickText(frame, state, send)).toEqual({ action: "send" });
      expect(clickText(frame, state, "⇧enter newline")).toEqual({ action: "newline" });
      expect(clickText(frame, state, entry === "i" ? "esc nav" : "esc cancels"))
        .toEqual({ action: "cancel" });
    }
  });

  test("the composer footer is clickable while rewriting a highlighted passage", async () => {
    // The rewrite counterpart of the retake case above — its own tri-state
    // promptKind value, asserted nowhere else in this file.
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    const node = state.payload.path.find((candidate) => candidate.id === "p12")!;
    const needle = "the brass compass";
    const start = node.text.indexOf(needle);
    const end = start + needle.length;
    const span = { key: "p12:text", text: node.text, start, end } as const;
    const index = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    openActions(state, index, node.text.slice(start, end), [span]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await dispatch(resolveKey(key("return"), "ACTIONS"), state, source,
      createWrapCache(), () => {}, async () => {}, () => {});

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    const frame = render(state, 120, 30);
    expect(plainLine(frame.find((line) => plainLine(line).includes("enter rewrites in place"))!))
      .not.toContain("…");
    expect(clickText(frame, state, "enter rewrites in place")).toEqual({ action: "send" });
    // The composer's other destination (issue #319) — its own click target,
    // distinct from "enter" above, so clicking it cannot send in place.
    expect(clickText(frame, state, "⌃s as take")).toEqual({ action: "send-as-take" });
    expect(clickText(frame, state, "⇧enter newline")).toEqual({ action: "newline" });
    expect(clickText(frame, state, "esc cancels")).toEqual({ action: "cancel" });
  });

  test("the fullscreen composer harvests its footer keys like the inline one", async () => {
    // Fullscreen builds its own hit map; it used to skip the harvest entirely,
    // so every key it drew was inert.
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    await dispatch(resolveKey(key("i"), "NAV"), state, source,
      createWrapCache(), () => {}, async () => {}, () => {});
    state.composer.fullscreen = true;
    const frame = render(state, 120, 30);
    expect(clickText(frame, state, "enter send")).toEqual({ action: "send" });
    expect(clickText(frame, state, "⌃f exit")).toEqual({ action: "toggle-compose-fullscreen" });
    expect(clickText(frame, state, "esc inline")).toEqual({ action: "cancel" });
  });

  test("the editor's status bar withholds the settings links", () => {
    // Opening settings does not close an editor session, so a click here would
    // strand `state.editor` behind a panel that returns to NAV. EDITOR spends
    // every letter on text, so the keyboard cannot reach it either. The COMPOSE
    // case is covered by the ownership test below.
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    state.mode = "EDITOR";
    const node = state.payload.path.at(-1)!;
    state.editor = {
      kind: "document",
      target: {
        kind: "part",
        node,
        pathIndex: state.payload.path.length - 1,
        savedNode: null
      },
      title: "edit ¶ 13",
      placeholder: "",
      composer: createComposer("prose"),
      initial: "prose",
      returnMode: "NAV",
      conflict: null
    };
    const frame = render(state, 120, 30);
    const row = frame.findIndex((line) => plainLine(line).includes(state.model));
    expect(row).toBeGreaterThan(-1);
    const rendered = plainLine(frame[row]!);
    const left = visibleWidth(rendered.slice(0, rendered.indexOf(state.model)));
    const target = hitAt(state.hitRows, left, row);
    expect(target === null || target.kind !== "settings-row").toBeTrue();
  });

  test("the facts rail header opens the facts panel it names", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    const frame = render(state, 150, 30);
    const resolved = clickText(frame, state, "facts · 5");
    expect(resolved).toEqual({ action: "open-facts" });
    await dispatch(resolved!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.mode).toBe("FACTS");
  });

  test("map take glyphs and arrows resolve exact takes with wrapped ends", () => {
    const targetsAt = (cursorId: string) => {
      const state = initialState(demoAppSource(), false);
      state.stream = null;
      showMap(state, "path", cursorId);
      state.map!.showSketches = true;
      const frame = render(state);
      const rowIndex = state.hitRows.findIndex((row) =>
        row?.overrides?.filter((span) => span.target.kind === "take").length === 7);
      const overrides = state.hitRows[rowIndex]!.overrides!.filter((span) => span.target.kind === "take");
      for (const span of overrides) expect(hitAt(state.hitRows, span.left, rowIndex)).toEqual(span.target);
      return { overrides, line: plainLine(frame[rowIndex]!) };
    };
    const middle = targetsAt("p12");
    expect(middle.overrides.slice(0, 5).map((span) => (span.target as { take: number }).take)).toEqual([1, 2, 3, 4, 5]);
    expect(middle.overrides.slice(-2).map((span) => (span.target as { take: number }).take)).toEqual([2, 4]);
    expect([...middle.line][middle.overrides.at(-2)!.left]).toBe("‹");
    expect([...middle.line][middle.overrides.at(-1)!.left]).toBe("›");
    expect(targetsAt("p12-t1").overrides.slice(-2).map((span) => (span.target as { take: number }).take)).toEqual([5, 2]);
    expect(targetsAt("p12-t5").overrides.slice(-2).map((span) => (span.target as { take: number }).take)).toEqual([4, 1]);
  });

  test("text prompts replace mutating panel footer clicks with apply/cancel only", () => {
    const cases = [
      (state: State, source: Source) => {
        state.mode = "LIBRARY";
        state.library = {
          stories: source.stories, cursor: 0, query: "",
          prompt: { kind: "rename" as const, composer: createComposer("new title"), targetId: source.payload.id }
        };
      },
      (state: State) => {
        state.mode = "FACTS";
        state.facts = { cursor: 0, query: "mar", chip: 0, selectedTag: null, filtering: true, deleteArmedId: null };
      }
    ];
    for (const setup of cases) {
      const source = demoAppSource();
      const state = initialState(source, false);
      state.stream = null;
      setup(state, source);
      render(state);
      const actions = state.hitRows.flatMap((row) => row?.overrides ?? [])
        .flatMap((region) => region.target.kind === "action" ? [region.target.action] : []);
      expect(new Set(actions)).toEqual(new Set(["open-selected", "cancel"]));
      expect(actions).not.toContain("new-item");
      expect(actions).not.toContain("delete-item");
    }
  });

  test("a short focused part still offers all six gutter verbs", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    // One short line of prose: the verbs must not depend on wrap count.
    state.payload = { ...state.payload, path: state.payload.path.map((node) => ({ ...node, text: "Short." })) };
    state.focusIndex = 0;
    render(state);
    const actions = new Set(state.hitRows.flatMap((row) => (row?.target.kind === "part" ? (row.overrides ?? []) : [])
      .filter((span) => span.target.kind === "inline-action")
      .map((span) => (span.target as { action: string }).action)));
    expect(actions).toEqual(new Set([
      "continue", "compose", "regenerate", "retake-with-prompt", "write", "edit"
    ]));
  });

  test("right-click over a gutter verb still opens the part menu", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    render(state);
    const row = state.hitRows.findIndex((entry) => entry?.overrides?.some((span) => span.target.kind === "inline-action") === true);
    const span = state.hitRows[row]!.overrides![0]!;
    // Left-click runs the verb; right-click reads through to the part beneath.
    expect(mouseToAction(click(span.left, row), state)).toMatchObject({ action: (span.target as { action: string }).action });
    expect(mouseToAction(click(span.left, row, 2), state)).toMatchObject({ action: "open-actions" });
  });

  test("every fact tag stays visible and clickable however many there are", () => {
    // Tags are user-written. An unbounded region would answer clicks outside the
    // panel, because hitAt consults overrides before the row-wide bounds.
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.mode = "FACTS";
    state.payload = { ...state.payload, facts: Array.from({ length: 12 }, (_, index) => ({
      id: `f${index}`, tag: `a-very-long-tag-name-${index}`, text: `fact ${index}`,
      activation: "always" as const, keys: [],
      createdAt: "2022-10-25T09:00:00.000Z", updatedAt: "2022-10-25T09:00:00.000Z"
    })) };
    state.facts = { cursor: 0, chip: 0, selectedTag: null, query: "", filtering: false, deleteArmedId: null, prompt: null } as never;
    const frame = render(state, 80, 24);
    const chipRows = state.hitRows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row?.overrides?.some((span) => span.target.kind === "chip") === true);
    expect(chipRows.length).toBeGreaterThan(1);
    const seen = new Set<number>();
    for (const { row, index } of chipRows) {
      const line = plainLine(frame[index]!);
      for (const span of row!.overrides!.filter((region) => region.target.kind === "chip")) {
        // In bounds, on a chip that was actually drawn, and clickable.
        expect(span.right <= row!.right).toBe(true);
        expect(line.slice(span.left, span.right).trim().length).toBeGreaterThan(0);
        expect(hitAt(state.hitRows, span.left, index)).toEqual(span.target);
        seen.add((span.target as { index: number }).index);
      }
    }
    // No tag is dropped: `tab` cycles all of them, so all must be reachable.
    expect(seen.size).toBe(state.payload.facts.length + 1);
  });

  test("modals with no verbs are inert, not transparent", () => {
    // Both once passed no hits at all, so the story rows the frame had already
    // drawn stayed live underneath: a click inside answered as prose, and a
    // click outside did not even dismiss them.
    for (const setup of [
      (state: ReturnType<typeof initialState>) => { state.mode = "KEYS"; },
      (state: ReturnType<typeof initialState>) => {
        state.mode = "SUMMARY";
        state.summary = { start: 1, end: 13, totalParts: 13, text: "", controller: new AbortController() };
      }
    ]) {
      const state = initialState(demoAppSource(), false);
      state.stream = null;
      setup(state);
      render(state);
      expect(state.hitRows.some((row) => row?.target.kind === "part")).toBeFalse();
      expect(hitAt(state.hitRows, 2, 2)).toEqual({ kind: "scrim" });
      expect(mouseToAction(click(2, 2), state)).toEqual({ action: "cancel" });
    }
  });

  test("gutter verbs run on click while the prose beside them only focuses", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    const frame = render(state);
    const gutterActions = new Set(GUTTER_VERBS.flat().map(({ action }) => action));
    const verbRows = state.hitRows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row?.target.kind === "part"
        && entry.row.overrides?.some((span) => span.target.kind === "inline-action"
          && gutterActions.has(span.target.action)) === true);
    // All three verb lines of the focused part are clickable, not just the first.
    expect(verbRows.length).toBe(3);
    const advertised = new Set<string>();
    for (const { row, index } of verbRows) {
      const line = plainLine(frame[index]!);
      for (const span of row!.overrides!.filter((candidate) =>
        candidate.target.kind === "inline-action" && gutterActions.has(candidate.target.action))) {
        const target = span.target as { kind: string; action: string };
        expect(target.kind).toBe("inline-action");
        advertised.add(target.action);
        // The span must sit on the token it claims, not near it.
        expect(line.slice(span.left, span.right)).toMatch(/^[␠↵rRwe] /);
        expect(mouseToAction(click(span.left, index), state)).toEqual({ action: target.action });
      }
      // Prose to the right of the gutter still only moves focus.
      expect(mouseToAction(click(60, index), state)).toMatchObject({ action: "focus-index" });
    }
    expect(advertised).toEqual(new Set([
      "continue", "compose", "regenerate", "retake-with-prompt", "write", "edit"
    ]));
  });

  test("a long focused part keeps every gutter control sticky and clickable", () => {
    const source = demoAppSource();
    source.demo = false;
    source.payload = {
      ...source.payload,
      path: source.payload.path.slice(0, -1)
    };
    const state = initialState(source, false);
    state.stream = null;
    state.payload.path.at(-1)!.text = Array.from(
      { length: 80 }, (_, index) => `long prose row ${index}`
    ).join("\n");
    state.viewScroll = Number.MAX_SAFE_INTEGER;
    const frame = render(state, 120, 12);
    const text = frame.map(plainLine).join("\n");
    const targets = state.hitRows.flatMap((row) =>
      row === null ? [] : [row.target, ...row.overrides?.map(({ target }) => target) ?? []]);

    expect(text).toContain("R reprompt");
    const expectedActions = new Set([
      "take-previous", "take-next",
      "continue", "compose", "regenerate", "retake-with-prompt", "write", "edit"
    ]);
    expect(new Set(targets.flatMap((target) =>
      target.kind === "inline-action" && expectedActions.has(target.action)
        ? [target.action]
        : [])))
      .toEqual(expectedActions);
    expect(new Set(targets.flatMap((target) =>
      target.kind === "story-take" ? [target.take] : [])))
      .toEqual(new Set([1, 2, 3, 4, 5]));
  });

  test("take overrides still land on their glyph when depths reach three digits", () => {
    // `  ¶ nn  ` is only 8 cells while depths stay two digits. This repo's own
    // scale study runs 214 parts, so the offset has to be derived, not assumed.
    const chain = 104;
    const nodes = Array.from({ length: chain }, (_, index) => ({
      id: `n${index}`, parentId: index === 0 ? null : `n${index - 1}`, preview: `part ${index}`,
      words: 10, tokens: 12, childCount: index === chain - 1 ? 3 : 1, leafCount: index === chain - 1 ? 3 : 1,
      lastTouched: "2022-10-25T09:00:00.000Z", hasInstruction: false,
      activeChildId: index === chain - 1 ? "leaf0" : `n${index + 1}`
    }));
    const leaves = Array.from({ length: 3 }, (_, take) => ({
      id: `leaf${take}`, parentId: `n${chain - 1}`, preview: `leaf ${take}`, words: 10, tokens: 12,
      childCount: 0, leafCount: 1, lastTouched: "2022-10-25T09:00:00.000Z",
      hasInstruction: false, activeChildId: null
    }));
    const all = [...nodes, ...leaves];
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    showMap(state, "path", "leaf0");
    state.map!.showSketches = true;
    state.payload = {
      ...state.payload, nodes: all,
      path: [...nodes, leaves[0]!].map((node) => ({
        id: node.id, parentId: node.parentId, instruction: "", text: node.preview,
        model: "test", createdAt: node.lastTouched, activeChildId: node.activeChildId
      })),
      activeRootId: "n0", tags: []
    } as never;
    const frame = render(state, 120, 40);
    const rowIndex = state.hitRows.findIndex((row) =>
      (row?.overrides?.filter((span) => span.target.kind === "take").length ?? 0) >= 3);
    expect(rowIndex).toBeGreaterThan(-1);
    const line = [...plainLine(frame[rowIndex]!)];
    for (const span of state.hitRows[rowIndex]!.overrides!.filter((span) => span.target.kind === "take")) {
      expect("○●◉◈▸‹›").toContain(line[span.left]!);
    }
  });

  test("a map take click selects, and a second click applies", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    showMap(state, "path", "p12");
    state.map!.showSketches = true;
    render(state);
    const rowIndex = state.hitRows.findIndex((row) =>
      row?.overrides?.filter((span) => span.target.kind === "take").length === 7);
    const span = state.hitRows[rowIndex]!.overrides!.find((candidate) =>
      candidate.target.kind === "take" && candidate.target.take === 1)!;
    const resolved = mouseToAction(click(span.left, rowIndex), state)!;
    expect(resolved).toMatchObject({ action: "apply", take: 1 });
    // First click only moves the cursor — same two steps as a row click.
    await dispatch(resolved, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.mode).toBe("MAP");
    expect(state.map?.pathCursorId).toBe("p12-t1");
    expect(state.payload.path[11]?.id).toBe("p12");
    // The second click on the same take reroutes through the existing path.
    render(state);
    await dispatch(resolved, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.mode).toBe("NAV");
    expect(state.payload.path[11]?.id).toBe("p12-t1");
  });

  test("folded path arrows and clicks resolve only exact visible node IDs", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    showMap(state, "path", "p8");
    state.map!.pathShowAllTakes = false;
    render(state);

    const pathRow = state.map!.rowIds.indexOf("p8");
    const rowIndex = state.hitRows.findIndex((row) =>
      row?.target.kind === "list" && row.target.index === pathRow);
    const takeSpans = state.hitRows[rowIndex]!.overrides!
      .filter((span) => span.target.kind === "take");
    expect(new Set(takeSpans.map((span) => (span.target as { take: number }).take)))
      .toEqual(new Set([1, 2]));

    const tagged = takeSpans.find((span) =>
      span.target.kind === "take" && span.target.take === 2)!;
    const clicked = mouseToAction(click(tagged.left, rowIndex), state)!;
    await dispatch(clicked, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.map?.pathCursorId).toBe("p8-alt-3");

    state.map!.pathCursorId = "p8";
    await dispatch({ action: "take-next" }, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.map?.pathCursorId).toBe("p8-alt-3");
    state.map!.pathCursorId = "p8";
    state.map!.pathShowAllTakes = true;
    await dispatch({ action: "take-next" }, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.map?.pathCursorId).toBe("p8-alt-1");
  });

  test("settings owns its panel and exact theme/provider selector arrows", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    footerCases.at(-1)!.setup(state, source);
    let frame = render(state, 80, 24);
    const panelRows = state.hitRows.map((row, index) => ({ row, index,
      panel: row?.overrides?.find((region) => region.target.kind === "panel") }))
      .filter((entry) => entry.panel !== undefined);
    const first = panelRows[0]!;
    const last = panelRows.at(-1)!;
    for (let row = first.index; row <= last.index; row += 1) {
      expect(hitAt(state.hitRows, first.panel!.left + 2, row)?.kind).not.toBe("scrim");
    }
    // The selector arrows only. A section rule also carries an indexed action —
    // it jumps to that section's first field — and sits on a label, not a glyph.
    const isArrow = (region: { target: HitTarget }, index: number) =>
      region.target.kind === "action" && region.target.index === index
      && (region.target.action === "take-previous" || region.target.action === "take-next");
    for (const index of [
      SETTINGS_ROW_IDS.indexOf("theme"),
      SETTINGS_ROW_IDS.indexOf("provider")
    ]) {
      state.settings!.cursor = index;
      frame = render(state, 80, 24);
      const selectorRow = state.hitRows.findIndex((row) =>
        row?.overrides?.some((region) => isArrow(region, index)) === true);
      const arrows = state.hitRows[selectorRow]!.overrides!.filter((region) =>
        isArrow(region, index));
      expect(arrows.map((span) => span.target)).toEqual([
        { kind: "action", action: "take-previous", index },
        { kind: "action", action: "take-next", index }
      ]);
      const line = plainLine(frame[selectorRow]!);
      expect([...line][arrows[0]!.left]).toBe("‹");
      expect([...line][arrows[1]!.left]).toBe("›");
    }
  });

  test("every settings label fits its column, so the values line up", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    footerCases.at(-1)!.setup(state, source);
    // Tall enough to paint the whole sectioned form, so every choice is sampled.
    const frame = render(state, 120, 48);

    // Each closed choice opens on the first cell of its value, so the opening
    // arrows share a column exactly when the labels all fit theirs.
    const opens = new Map<number, number>();
    for (const [rowIndex, row] of state.hitRows.entries()) {
      for (const region of row?.overrides ?? []) {
        if (region.target.kind !== "action" || region.target.index === undefined) continue;
        if (region.target.action !== "take-previous") continue;
        opens.set(region.target.index, region.left);
        expect([...plainLine(frame[rowIndex]!)][region.left]).toMatch(/[‹[]/u);
      }
    }

    // The advanced form has 19 visible choices in this viewport. The remaining
    // rows stay below the window and are reachable through row navigation.
    expect(opens.size).toBe(19);
    expect(new Set(opens.values()).size).toBe(1);
  });

  test("model discovery adds exact slider arrows and mouse selection", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    const index = SETTINGS_ROW_IDS.indexOf("model");
    footerCases.at(-1)!.setup(state, source);
    installModelChoices(state, ["qwen3-32b", "novelist-b"]);
    state.settings!.cursor = index;
    const frame = render(state, 120, 30);

    const selectorRow = state.hitRows.findIndex((row) =>
      row?.overrides?.some((region) =>
        region.target.kind === "action" && region.target.index === index) === true);
    const arrows = state.hitRows[selectorRow]!.overrides!.filter((region) =>
      region.target.kind === "action" && region.target.index === index);
    const line = plainLine(frame[selectorRow]!);
    expect([...line][arrows[0]!.left]).toBe("‹");
    expect([...line][arrows[1]!.left]).toBe("›");

    const clicked = mouseToAction(click(arrows[1]!.left, selectorRow), state)!;
    await dispatch(clicked, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.settings?.draft.generation.model).toBe("novelist-b");
  });

  test("a truncated selector value leaves no arrow behind at any panel width", () => {
    let widest = 0;
    for (let width = 30; width <= 120; width += 1) {
      const source = demoAppSource();
      const state = initialState(source, false);
      state.stream = null;
      footerCases.at(-1)!.setup(state, source);
      installModelChoices(state, ["a-model-name-that-does-not-fit-in-a-narrow-panel"]);
      state.settings!.cursor = SETTINGS_ROW_IDS.indexOf("model");
      const frame = render(state, width, 30);
      let arrows = 0;
      for (const [rowIndex, row] of state.hitRows.entries()) {
        for (const region of row?.overrides ?? []) {
          // The selector arrows, not every indexed action — the C-03 rail's
          // jump cells are indexed too and sit on a label, not a glyph.
          if (region.target.kind !== "action" || region.target.index === undefined) continue;
          if (region.target.action !== "take-previous"
            && region.target.action !== "take-next") continue;
          arrows += 1;
          const line = [...plainLine(frame[rowIndex]!)];
          // The whole region, not just its first cell, has to be on the glyph.
          expect(line[region.left]).toMatch(/[‹›[\]]/u);
          expect(line[region.right - 1]).toMatch(/[‹›[\]]/u);
        }
      }
      widest = arrows;
    }
    // Otherwise a panel that painted no arrows at all would pass the sweep.
    expect(widest).toBeGreaterThan(0);
  });

  test("story model and context hint open their exact Settings rows", async () => {
    const source = demoAppSource();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    source.settings = { ...source.settings, contextWindow: null };
    const document = source.settingsView.document;
    const defaultProfile = document.profiles[document.routing.default]!;
    source.settingsView = {
      ...source.settingsView,
      effective: source.settings,
      effectiveProse: source.settings,
      document: {
        ...document,
        profiles: {
          ...document.profiles,
          prose: { ...defaultProfile, name: "Prose" }
        },
        routing: { ...document.routing, prose: "prose" }
      }
    };
    source.api.getSettings = async () => source.settingsView;
    const state = initialState(source, false);
    state.stream = null;
    const frame = render(state, 140, 36);

    const model = clickText(frame, state, state.model);
    const context = clickText(frame, state, "set context window · settings (,)");
    expect(model).toEqual({
      action: "open-settings",
      settingsRow: "model",
      settingsProfilePurpose: "prose"
    });
    expect(context).toEqual({
      action: "open-settings",
      settingsRow: "context-window",
      settingsProfilePurpose: "prose"
    });

    await dispatch(
      context!,
      state,
      source,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined
    );
    expect(state.mode).toBe("SETTINGS");
    // "context-window" is one of simple mode's rows too, so the overlay opens
    // at its simple-mode index (simple is the default), not the full list's.
    expect(state.settings?.cursor).toBe(settingsRowIndex("context-window", state.settings!));
    expect(state.settings?.draft.selectedProfileId).toBe("prose");
  });

  test("story Settings links cannot take ownership from Compose", () => {
    const source = demoAppSource();
    source.settings = { ...source.settings, contextWindow: null };
    source.settingsView = {
      ...source.settingsView,
      effective: source.settings,
      effectiveProse: source.settings
    };
    const state = initialState(source, false);
    state.stream = null;
    state.mode = "COMPOSE";
    const frame = render(state, 140, 36);

    expect(clickText(frame, state, state.model)).toBe(null);
    expect(clickText(frame, state, "set context window · settings (,)"))
      .toEqual({ action: "toggle-context-meter" });
  });

  test("settings footer keeps its hit targets when compacted", () => {
    const modes = [
      { name: "choice", setup: (_state: State) => {} },
      { name: "text", setup: (state: State) => {
        state.settings!.cursor = 3;
      } },
      { name: "context detection", setup: (state: State) => {
        state.settings!.cursor = SETTINGS_ROW_IDS.indexOf("context-window");
      } },
      { name: "editing", setup: (state: State) => {
        state.settings!.cursor = SETTINGS_ROW_IDS.indexOf("base-url");
        beginSettingsRowEdit(state.settings!, state.config);
        if (state.settings!.edit === null) throw new Error("settings edit did not open");
      } },
      { name: "pending", setup: (state: State) => {
        const view = state.settings!.view;
        if (!view.editable) throw new Error("demo settings must be editable");
        state.settings!.view = {
          ...view,
          pendingRevision: view.activeRevision + 1
        };
      } }
    ];

    for (const mode of modes) {
      for (const width of [60, 40, 24]) {
        const source = demoAppSource();
        const state = initialState(source, false);
        state.stream = null;
        footerCases.at(-1)!.setup(state, source);
        mode.setup(state);
        const frame = render(state, width, 24);
        const footerRow = state.hitRows.findIndex((row) =>
          row?.overrides?.some((region) =>
            region.target.kind === "action" && region.target.action === "cancel") === true);
        if (footerRow < 0) {
          throw new Error(`${mode.name} footer missing at ${width} columns`);
        }
        const line = plainLine(frame[footerRow]!);
        const regions = state.hitRows[footerRow]!.overrides!.filter((region) =>
          region.target.kind === "action");
        for (const region of regions) {
          expect(line.slice(region.left, region.right).trim().length).toBeGreaterThan(0);
          expect(hitAt(state.hitRows, region.left, footerRow)).toEqual(region.target);
        }
        const cancel = regions.find((region) =>
          region.target.kind === "action" && region.target.action === "cancel")!;
        expect(line.slice(cancel.left, cancel.left + 3)).toBe("esc");
      }
    }
  });

  test("focused prose clicks only focus, and right-click opens the composer menu", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    render(state);
    const focusedRow = state.hitRows.findIndex((row) => row?.target.kind === "part"
      && row.target.index === state.focusIndex);
    expect(mouseToAction(click(state.hitRows[focusedRow]!.left + 2, focusedRow), state))
      .toMatchObject({ action: "focus-index", index: state.focusIndex });
    state.mode = "COMPOSE";
    state.composer = createComposer("draft stays");
    for (const fullscreen of [false, true]) {
      state.composer.fullscreen = fullscreen;
      render(state);
      const composerRow = state.hitRows.findIndex((row) => row?.target.kind === "composer");
      expect(composerRow).toBeGreaterThan(-1);
      const action = mouseToAction(click(2, composerRow, 2), state);
      expect(action).toEqual({ action: "open-text-actions" });
      await dispatch(
        action!, state, source, createWrapCache(), () => {}, async () => {}, () => {}
      );
      expect(state.mode).toBe("COMPOSE");
      expect(state.textActions).not.toBe(null);
      for (const width of [120, 40, 24]) {
        render(state, width, 24);
      }
      await dispatch(
        { action: "cancel" }, state, source, createWrapCache(), () => {}, async () => {}, () => {}
      );
      expect(state.textActions).toBe(null);
    }
    state.composer.fullscreen = false;
    render(state);
    const composePartRow = state.hitRows.findIndex((row) => row?.target.kind === "part");
    expect(composePartRow).toBeGreaterThan(-1);
    expect(mouseToAction(click(2, composePartRow, 2), state)).toBe(null);

    const node = state.payload.path.at(-1)!;
    state.mode = "EDITOR";
    state.editor = {
      kind: "document",
      target: {
        kind: "part",
        node,
        pathIndex: state.payload.path.length - 1,
        savedNode: null
      },
      title: "edit part",
      placeholder: "",
      composer: createComposer("editor text"),
      initial: "editor text",
      returnMode: "NAV",
      conflict: null
    };
    render(state);
    const editorRow = state.hitRows.findIndex((row) => row?.target.kind === "composer");
    expect(editorRow).toBeGreaterThan(-1);
    const editorAction = mouseToAction(click(2, editorRow, 2), state);
    expect(editorAction).toEqual({ action: "open-text-actions" });
    await dispatch(
      editorAction!, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    expect(render(state).some((line) => plainLine(line).includes("edit actions"))).toBeTrue();
    await dispatch(
      { action: "cancel" }, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );

    openFactEditor(state, null);
    expect(currentFactEditor(state).tag.text).toBe("");
    render(state);
    const emptyTagRow = state.hitRows.findIndex((row) => row?.target.kind === "composer"
      && row.target.composerSourceId === FACT_TAG_COMPOSER_SOURCE);
    expect(emptyTagRow).toBeGreaterThan(-1);
    const emptyTagAction = mouseToAction(click(2, emptyTagRow, 2), state);
    expect(emptyTagAction).toEqual({
      action: "open-text-actions",
      composerSourceId: FACT_TAG_COMPOSER_SOURCE,
      composerEditable: true
    });
    await dispatch(
      emptyTagAction!, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    expect(state.textActions?.owner === currentFactEditor(state).tag).toBeTrue();
    await dispatch(
      { action: "cancel" }, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    setComposerText(currentFactEditor(state).tag, "weather");
    render(state);
    const tagRow = state.hitRows.findIndex((row) => row?.target.kind === "composer"
      && row.target.composerSourceId === FACT_TAG_COMPOSER_SOURCE);
    expect(tagRow).toBeGreaterThan(-1);
    const tagAction = mouseToAction(click(2, tagRow, 2), state);
    expect(tagAction).toEqual({
      action: "open-text-actions",
      composerSourceId: FACT_TAG_COMPOSER_SOURCE,
      composerEditable: true
    });
    await dispatch(
      tagAction!, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    const factEditor = currentFactEditor(state);
    expect(factEditor.focus).toBe("tag");
    expect(state.textActions?.owner === factEditor.tag).toBeTrue();
    await dispatch(
      { action: "cancel" }, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    render(state);
    const keysRow = state.hitRows.findIndex((row) => row?.target.kind === "composer"
      && row.target.composerSourceId === FACT_KEYS_COMPOSER_SOURCE);
    expect(keysRow).toBeGreaterThan(-1);
    const keysAction = mouseToAction(click(2, keysRow, 2), state);
    expect(keysAction).toEqual({
      action: "open-text-actions",
      composerSourceId: FACT_KEYS_COMPOSER_SOURCE,
      composerEditable: true
    });
    await dispatch(
      keysAction!, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    expect(currentFactEditor(state).focus).toBe("keys");
    await dispatch(
      { action: "cancel" }, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    render(state);
    const activationRow = state.hitRows.findIndex((row) => row?.target.kind === "composer"
      && row.target.composerSourceId === FACT_ACTIVATION_COMPOSER_SOURCE);
    expect(activationRow).toBeGreaterThan(-1);
    const activationAction = mouseToAction(click(2, activationRow, 2), state);
    expect(activationAction).toEqual({
      action: "open-text-actions",
      composerSourceId: FACT_ACTIVATION_COMPOSER_SOURCE,
      composerEditable: false
    });
    await dispatch(
      activationAction!, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    expect(state.textActions).toBe(null);
    setFactEditorFocus(currentFactEditor(state), "activation");
    render(state);
    const editorChrome = state.hitRows.findIndex((row) => row?.target.kind === "composer"
      && row.target.composerSourceId === undefined);
    expect(editorChrome).toBeGreaterThan(-1);
    expect(mouseToAction(click(2, editorChrome, 2), state)).toBe(null);

    state.editor = null;
    state.mode = "SETTINGS";
    // SETTINGS_ROW_IDS indexes the full (advanced) row list.
    state.config = { ...state.config, settingsViewMode: "advanced" };
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.settings.cursor = SETTINGS_ROW_IDS.indexOf("model");
    beginSettingsRowEdit(state.settings, state.config);
    render(state);
    const settingsRow = state.hitRows.findIndex((row) => row?.overrides?.some((region) =>
      region.target.kind === "list" && region.target.index === state.settings!.cursor) === true);
    expect(settingsRow).toBeGreaterThan(-1);
    const settingsHit = state.hitRows[settingsRow]!.overrides!.find((region) =>
      region.target.kind === "list" && region.target.index === state.settings!.cursor)!;
    const settingsAction = mouseToAction(click(settingsHit.left + 2, settingsRow, 2), state);
    expect(settingsAction).toEqual({ action: "open-text-actions" });
    await dispatch(
      settingsAction!, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    expect(render(state).some((line) => plainLine(line).includes("edit actions"))).toBeTrue();
    await dispatch(
      { action: "cancel" }, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );

    state.settings = null;
    state.mode = "COMPOSE";
    await dispatch(
      resolveKey({ ...key("space"), sequence: " " } as KeyEvent, state.mode),
      state,
      source,
      createWrapCache(),
      () => {},
      async () => {},
      () => {}
    );
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("draft stays ");
  });

  test("left-clicking Fact fields focuses text and choice sources", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    openFactEditor(state, null);

    const sourceRow = (sourceId: string): number => {
      render(state);
      const row = state.hitRows.findIndex((hit) => hit?.target.kind === "composer"
        && hit.target.composerSourceId === sourceId);
      expect(row).toBeGreaterThan(-1);
      return row;
    };

    let row = sourceRow(FACT_TAG_COMPOSER_SOURCE);
    let action = mouseToAction(click(2, row), state);
    expect(action).toEqual({ action: "compose", composerSourceId: FACT_TAG_COMPOSER_SOURCE });
    await dispatch(action!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(currentFactEditor(state).focus).toBe("tag");
    await dispatch(
      { action: "input", text: "weather" }, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    expect(currentFactEditor(state).tag.text).toBe("weather");

    row = sourceRow(FACT_BODY_COMPOSER_SOURCE);
    action = mouseToAction(click(2, row), state);
    expect(action).toEqual({ action: "compose", composerSourceId: FACT_BODY_COMPOSER_SOURCE });
    await dispatch(action!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(currentFactEditor(state).focus).toBe("body");
    await dispatch(
      { action: "input", text: "A rainy street." }, state, source, createWrapCache(), () => {}, async () => {}, () => {}
    );
    expect(currentFactEditor(state).composer.text).toBe("A rainy street.");

    row = sourceRow(FACT_ACTIVATION_COMPOSER_SOURCE);
    action = mouseToAction(click(2, row), state);
    expect(action).toEqual({ action: "compose", composerSourceId: FACT_ACTIVATION_COMPOSER_SOURCE });
    await dispatch(action!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(currentFactEditor(state).focus).toBe("activation");
    expect(currentFactEditor(state).activation).toBe("always");
  });

  test("every screen footer renders untruncated at wide and compact sizes", () => {
    const cases: Array<{ name: string; expected: string | ((width: number) => string); setup: (state: State, source: Source) => void }> = [
      { name: "actions", expected: "↑↓ move · ↵ run · esc close",
        setup: (state) => {
          state.mode = "ACTIONS";
          state.actions = {
            cursor: 0,
            partId: createStoryViewModel(state.payload, state.stream).rows[state.focusIndex]!.id
          };
        } },
      { name: "map path", expected: (width) => width < 100
        ? "m · a branch · ↑↓ depth · ←→ take · esc"
        : width < 136
          ? "m tree · a branches · ↑↓ depth · ←→ take · enter · esc"
          : "m tree · a branches · ↑↓ depth · ←→ take · enter reroute · esc writes",
        setup: (state) => { showMap(state, "path", "p12"); } },
      { name: "map tree", expected: (width) => width < 100
        ? "m mass · ↑↓ row · ←→ lane · tab path · esc"
        : width < 136
          ? "m mass · ↑↓ row · ←→ lane · a sketches · tab path · enter · esc writes"
          : "m mass · ↑↓ row · ←→ lane · a sketches · l follow · tab path · enter reroute · esc writes",
        setup: (state) => { showMap(state, "tree", state.payload.path.at(-1)!.id); } },
      { name: "map mass", expected: (width) => width < 100
        ? "m path · ↑↓ row · s sort · l open · esc"
        : width < 136
          ? "m path · ↑↓ row · s sort · l open · esc writes"
          : "m path · ↑↓ row · s sort · a sketches · l open line · enter reroute · esc writes",
        setup: (state) => { showMap(state, "mass", state.payload.path.at(-1)!.id); } },
      // Too short a terminal to hold the whole reference trades the selection
      // hint for the scroll position, so the footer differs by size.
      { name: "keys", expected: (width) => width < 100
        ? "↑↓ scrolls · "
        : "drag selects · ctrl+c copies · esc closes",
        setup: (state) => { state.mode = "KEYS"; } },
      { name: "library", expected: "↑↓ move · ↵ open · n new · e rename · / filter · D delete · esc",
        setup: (state, source) => { state.mode = "LIBRARY"; state.library = { stories: source.stories, cursor: 0, query: "", prompt: null }; } },
      { name: "facts", expected: (width: number) => width < 100
        ? "↑↓ · tab · ↵ edit · / filter · e edit · n new · D delete · esc"
        : "↑↓ · ⇧↑↓ move · tab tags · ↵ edit · / filter · e edit · n new · D delete · esc",
        setup: (state) => { state.mode = "FACTS"; state.facts = { cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null }; } },
      { name: "facts confirm", expected: (width) => width < 100
        ? "↑↓ · tab · ↵ · / filter · e edit · n new · D confirms · esc keeps"
        : "↑↓ · ⇧↑↓ move · tab tags · ↵ edit · / filter · e edit · n new · D confirms · esc keeps",
        setup: (state) => { state.mode = "FACTS"; state.facts = { cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: "fact-1" }; } },
      { name: "commands", expected: "↑↓ move · ↵ run · esc close",
        setup: (state) => { state.mode = "COMMANDS"; state.commands = { query: "", cursor: 0, selectedId: null, view: "commands", returnMode: "NAV" }; } },
      { name: "tag manager", expected: "↑↓ move · D delete · esc commands",
        setup: (state) => { state.mode = "COMMANDS"; state.commands = { query: "", cursor: 0, selectedId: null, view: "tags", returnMode: "NAV" }; } },
      { name: "tag manager confirm", expected: "D confirms · esc keeps",
        setup: (state) => { state.mode = "COMMANDS"; state.commands = { query: "", cursor: 0, selectedId: null, view: "tags", returnMode: "NAV", deleteArmedTagNodeId: "tag-1" }; } },
      // Context status moved into the panel, so the footer is actions only and
      // no longer grows with `over`/`fix`.
      { name: "chapters", expected: (width) => width < 100
        ? "↵ jump · s sum · e rename · n break · D rm · esc"
        : "↵ jump · s summarize · e rename · n break · D remove · esc",
        setup: (state) => { state.mode = "CHAPTERS"; state.chapters = { cursor: 0, rename: null, deleteArmedId: null }; } },
      // A chapter list longer than the row budget: the panel must still show the
      // context status it moved inside to stop the footer from hiding.
      { name: "chapters full", expected: "total ",
        setup: (state) => {
          state.mode = "CHAPTERS";
          state.chapters = { cursor: 0, rename: null, deleteArmedId: null };
          state.payload = { ...state.payload, chapterBreaks: state.payload.path.map((node, index) => ({
            id: `b${index}`, parentPartId: node.id, title: `ch ${index + 1}`, createdAt: "2022-10-25T09:00:00.000Z"
          })) };
        } },
      { name: "chapters confirm", expected: "↵ jump · s sum · e rename · n break · D confirms · esc keeps",
        setup: (state) => { state.mode = "CHAPTERS"; state.chapters = { cursor: 0, rename: null, deleteArmedId: "chapter-break-1" }; } },
      { name: "settings",
        expected: "↑↓ move · ←→ choose · ↵ next · s save · c check · m simple · esc",
        setup: (state, source) => {
          state.mode = "SETTINGS";
          // Advanced mode selects the `m simple` footer. Row 0 is "theme".
          state.config = { ...state.config, settingsViewMode: "advanced" };
          state.settings = initialSettingsOverlay(source.settingsView, state.config);
        } },
      { name: "summary", expected: "esc discards", setup: (state) => {
        state.mode = "SUMMARY";
        state.summary = { start: 1, end: 13, totalParts: 13, text: "", controller: new AbortController() };
      } }
    ];
    for (const { width, height } of [{ width: 120, height: 36 }, { width: 80, height: 24 }]) {
      for (const item of cases) {
        const source = demoAppSource();
        const state = initialState(source, false);
        state.stream = null;
        item.setup(state, source);
        const expected = typeof item.expected === "string" ? item.expected : item.expected(width);
        const footer = render(state, width, height).map(plainLine).find((line) => line.includes(expected));
        expect(footer).toBeDefined();
        expect(footer!.slice(footer!.indexOf(expected))).not.toContain("…");
      }
    }
  });
});

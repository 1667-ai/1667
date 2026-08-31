import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { dispatch, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { canonicalFactStates } from "../../shared/fact-state.js";
import { factScopeLabel } from "../src/facts-model.js";
import { hitAt } from "../src/hit.js";
import { resolveKey } from "../src/keys.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, plainLine } from "../src/screens/story/frame.js";
import { createWrapCache } from "../src/wrap.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { runPartAction } from "../src/story-actions.js";
import type { StoryFact } from "../../shared/types.js";

const STAMP = "2026-01-01T00:00:00.000Z";

function key(name: string): KeyEvent {
  return {
    name,
    sequence: name,
    shift: false,
    ctrl: false,
    meta: false,
    option: false,
    super: false
  } as KeyEvent;
}

function click(x: number, y: number) {
  return {
    type: "down",
    button: 0,
    x,
    y,
    modifiers: { shift: false, alt: false, ctrl: false }
  } as never;
}

function render(state: ReturnType<typeof initialState>, width = 120, height = 32): string {
  const frame = renderStoryScreen(state, { width, height, wrapCache: createWrapCache() });
  Object.assign(state, frame.derived);
  return frameText(frame.lines);
}

function customFact(source: StoryFact, id: string, name: string, states: StoryFact["states"]): StoryFact {
  return {
    ...source,
    id,
    name,
    tag: "people",
    activation: "always",
    keys: [],
    states,
    createdAt: STAMP,
    updatedAt: STAMP
  };
}

function stateText(id: string, text: string, anchorPartId?: string) {
  return {
    id,
    ...(anchorPartId === undefined ? {} : { anchorPartId }),
    text,
    createdAt: STAMP,
    updatedAt: STAMP
  } as const;
}

describe("Facts scope chips and dossier", () => {
  test("labels a story-wide End State as ended", () => {
    const template = initialState(demoAppSource(), false).payload.facts[0]!;
    const fact = customFact(template, "ended-everywhere", "ended everywhere", [{
      id: "ended-everywhere",
      ends: true,
      createdAt: STAMP,
      updatedAt: STAMP
    }]);
    expect(factScopeLabel(fact)).toBe("✕ story");
  });

  test("keeps Enter on the existing editor for a single story-wide Fact", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "FACTS";
    state.payload = {
      ...state.payload,
      facts: [{ ...state.payload.facts[0]!, name: "Named story-wide Fact" }, ...state.payload.facts.slice(1)]
    };
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
    await dispatch(
      { action: "open-selected" },
      state,
      source,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined
    );
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("fact");
    expect(state.editor?.kind === "fact" ? state.editor.name?.text : null).toBe("Named story-wide Fact");
  });

  test("overview edit still opens a legacy Fact without state PATCH", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "FACTS";
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
    source.api.patchFactState = undefined;

    await dispatch(
      { action: "edit" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("fact");
  });

  test("overview edit refuses a stateful Fact without state PATCH", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    const fact = customFact(template, "overview-edit-old", "overview edit old", [
      stateText("base", "Story-wide body."),
      stateText("branch", "Branch body.", "p12")
    ]);
    state.payload = { ...state.payload, facts: [fact] };
    state.mode = "FACTS";
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
    const before = structuredClone(state.payload.facts);
    source.api.patchFactState = undefined;

    await dispatch(
      { action: "edit" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.mode).toBe("FACTS");
    expect(state.editor).toBeNull();
    expect(state.payload.facts).toEqual(before);
    expect(state.toast).toBe("state editing requires a newer backend");
  });

  test("renders the resolution line, scope chips, and visible search-hit context", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    const branch = customFact(template, "branch", "branch keeper", [
      stateText("branch-old", "Old branch text."),
      stateText("branch-current", "Current branch text.", "p12"),
      stateText("branch-other", "Other branch text.", "p3-alt")
    ]);
    state.payload = {
      ...state.payload,
      facts: [
        customFact(template, "everywhere", "everywhere keeper", [stateText("everywhere-state", "Story-wide text.")]),
        customFact(template, "this-line", "line keeper", [stateText("line-state", "Line text.", "p12")]),
        branch,
        customFact(template, "elsewhere", "other line keeper", [stateText("other-line-state", "Other line text.", "p3-alt")]),
        customFact(template, "ended", "ended keeper", [{
          id: "ended-state",
          anchorPartId: "p12",
          ends: true,
          createdAt: STAMP,
          updatedAt: STAMP
        }])
      ]
    };
    state.mode = "FACTS";
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

    const text = render(state);
    expect(text).toContain("line canon-storm");
    expect(text).toContain("[ everywhere ]");
    expect(text).toContain("[ this line ]");
    expect(text).toContain("[ elsewhere ]");
    expect(text).toContain("[ ended ]");
    expect(text).toContain("⊘");

    state.facts.selectedStateId = "branch-current";
    expect(render(state)).toContain("search hit · st.2 · this line");

    const scopeHit = state.hitRows
      .flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .find(({ hit }) => hit.target.kind === "chip" && hit.target.group === "scope"
        && hit.target.index === 2);
    expect(scopeHit).toBeDefined();
    expect(mouseToAction(click(scopeHit!.hit.left + 1, scopeHit!.y), state))
      .toEqual({ action: "cycle-fact-scope", index: 2 });
    expect(hitAt(state.hitRows, scopeHit!.hit.left + 1, scopeHit!.y)).toEqual({
      kind: "chip",
      index: 2,
      group: "scope"
    });

    state.facts.selectedStateId = null;
    await dispatch(
      { action: "cycle-fact-scope", index: 2 },
      state,
      source,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined
    );
    expect(state.facts.scopeFilter).toBe("elsewhere");
    expect(render(state)).toContain("other line keeper");
    expect(render(state)).not.toContain("everywhere keeper");
  });

  test("opens a path-relative dossier and derives an on-demand old] new diff", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    const fact = customFact(template, "dossier", "dossier keeper", [
      stateText("base", "Old line\nKept line."),
      stateText("current", "New line\nAdded line.", "p12"),
      stateText("other", "Other line.", "p3-alt"),
      { id: "ended", anchorPartId: "p13", ends: true, createdAt: STAMP, updatedAt: STAMP }
    ]);
    state.payload = { ...state.payload, facts: [fact] };
    state.mode = "FACTS";
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

    await dispatch(
      { action: "open-selected" },
      state,
      source,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined
    );
    expect(state.facts.dossier).toEqual({ factId: "dossier", stateIndex: 0, diff: false });
    let text = render(state);
    expect(text).toContain("path-relative history");
    expect(text).toContain("st.1 start");
    expect(text).toContain("st.3");
    expect(text).toContain("elsewhere ·");
    expect(text).toContain("st.4");

    const stateHit = state.hitRows
      .flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .find(({ hit }) => hit.target.kind === "list" && hit.target.rowId === "current");
    expect(stateHit).toBeDefined();
    expect(mouseToAction(click(stateHit!.hit.left + 1, stateHit!.y), state)).toEqual({
      action: "focus-index",
      index: 1,
      rowId: "current"
    });

    await dispatch(
      { action: "cycle-state", index: 1 },
      state,
      source,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined
    );
    await dispatch(
      { action: "toggle-fact-diff" },
      state,
      source,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined
    );
    text = render(state);
    expect(text).toContain("derived diff · never stored");
    expect(text).toContain("old]");
    expect(text).toContain("new]");
    expect(text).toContain("add.");

    const diffHit = state.hitRows
      .flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .find(({ hit }) => hit.target.kind === "action" && hit.target.action === "toggle-fact-diff");
    expect(diffHit).toBeDefined();
    expect(mouseToAction(click(diffHit!.hit.left + 1, diffHit!.y), state))
      .toEqual({ action: "toggle-fact-diff" });
  });

  test("dossier new state uses the story part that opened Facts", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    const fact = customFact(template, "dossier-new", "dossier new", [
      stateText("base", "Story-wide body."),
      stateText("branch", "Branch body.", "p12")
    ]);
    state.payload = { ...state.payload, facts: [fact] };
    const openedPartId = state.payload.path[0]!.id;
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), openedPartId);
    state.mode = "FACTS";
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

    await dispatch(
      { action: "open-selected" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );
    await dispatch(
      { action: "new-state" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.editor?.kind).toBe("fact");
    expect(state.editor?.kind === "fact" ? state.editor.stateAnchorPartId : null)
      .toBe(openedPartId);
    expect(state.editor?.kind === "fact" ? state.editor.stateCursorAnchorId : null)
      .toBe(openedPartId);
  });

  test("overview new state uses the story part that opened Facts", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    const fact = customFact(template, "overview-new", "overview new", [
      stateText("base", "Story-wide body."),
      stateText("branch", "Branch body.", "p12")
    ]);
    state.payload = { ...state.payload, facts: [fact] };
    const openedPartId = state.payload.path[0]!.id;
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), openedPartId);
    state.mode = "FACTS";
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

    await dispatch(
      { action: "new-state" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.editor?.kind).toBe("fact");
    expect(state.editor?.kind === "fact" ? state.editor.stateAnchorPartId : null)
      .toBe(openedPartId);
    expect(state.editor?.kind === "fact" ? state.editor.stateCursorAnchorId : null)
      .toBe(openedPartId);
  });

  test("overview state creation refuses chapter summary and divider cursors", async () => {
    for (const rowKind of ["chapter-summary", "chapter-divider"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const before = structuredClone(state.payload.facts);
      const view = createStoryViewModel(state.payload);
      state.focusIndex = view.rows.findIndex((row) => row.kind === rowKind);
      expect(state.focusIndex).toBeGreaterThan(-1);
      state.mode = "FACTS";
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

      await dispatch(
        { action: "new-state" }, state, source, createWrapCache(),
        () => undefined, async () => undefined, () => undefined
      );

      expect(state.editor).toBeNull();
      expect(state.payload.facts).toEqual(before);
      expect(state.toast).toBe("select a story part before adding a state");
    }
  });

  test("overview state creation fails closed on an older backend", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const fact = state.payload.facts[0]!;
    const before = structuredClone(state.payload.facts);
    source.api.createFactState = undefined;
    state.mode = "FACTS";
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

    await dispatch(
      { action: "new-state" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.editor).toBeNull();
    expect(state.payload.facts).toEqual(before);
    expect(state.toast).toBe("state creation requires a newer backend");
    expect(state.payload.facts.find(({ id }) => id === fact.id)).toEqual(fact);
  });

  test("dossier state creation fails closed on an older backend", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    const fact = customFact(template, "dossier-old", "dossier old", [
      stateText("base", "Story-wide body."),
      stateText("branch", "Branch body.", "p12")
    ]);
    state.payload = { ...state.payload, facts: [fact] };
    state.mode = "FACTS";
    state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null,
      scopeFilter: "everywhere",
      dossier: { factId: fact.id, stateIndex: 0, diff: false }
    };
    const before = structuredClone(state.payload.facts);
    source.api.createFactState = undefined;

    await dispatch(
      { action: "new-state" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.editor).toBeNull();
    expect(state.facts?.dossier).toEqual({ factId: fact.id, stateIndex: 0, diff: false });
    expect(state.payload.facts).toEqual(before);
    expect(state.toast).toBe("state creation requires a newer backend");
  });

  test("dossier edit refuses a stateful Fact without state PATCH", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    const fact = customFact(template, "dossier-edit-old", "dossier edit old", [
      stateText("base", "Story-wide body."),
      stateText("branch", "Branch body.", "p12")
    ]);
    state.payload = { ...state.payload, facts: [fact] };
    state.mode = "FACTS";
    state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null,
      scopeFilter: "everywhere",
      dossier: { factId: fact.id, stateIndex: 1, diff: false }
    };
    const before = structuredClone(state.payload.facts);
    source.api.patchFactState = undefined;

    await dispatch(
      { action: "edit" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.editor).toBeNull();
    expect(state.facts?.dossier).toEqual({
      factId: fact.id,
      stateIndex: 1,
      diff: false
    });
    expect(state.payload.facts).toEqual(before);
    expect(state.toast).toBe("state editing requires a newer backend");
  });

  test("dossier state creation refuses chapter summary and divider cursors", async () => {
    for (const rowKind of ["chapter-summary", "chapter-divider"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const template = state.payload.facts[0]!;
      const fact = customFact(template, `dossier-row-${rowKind}`, "dossier row", [
        stateText("base", "Story-wide body."),
        stateText("branch", "Branch body.", "p12")
      ]);
      state.payload = { ...state.payload, facts: [fact] };
      const view = createStoryViewModel(state.payload);
      state.focusIndex = view.rows.findIndex((row) => row.kind === rowKind);
      expect(state.focusIndex).toBeGreaterThan(-1);
      state.mode = "FACTS";
      state.facts = {
        cursor: 0,
        query: "",
        chip: 0,
        selectedTag: null,
        filtering: false,
        deleteArmedId: null,
        scopeFilter: "everywhere",
        dossier: { factId: fact.id, stateIndex: 0, diff: false }
      };

      await dispatch(
        { action: "new-state" }, state, source, createWrapCache(),
        () => undefined, async () => undefined, () => undefined
      );

      expect(state.editor).toBeNull();
      expect(state.facts?.dossier).toEqual({
        factId: fact.id,
        stateIndex: 0,
        diff: false
      });
      expect(state.toast).toBe("select a story part before adding a state");
    }
  });

  test("a pending part state action fails closed on an older backend", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const anchorPartId = state.payload.path[0]!.id;
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), anchorPartId);
    source.api.createFactState = undefined;

    await runPartAction("fact-new-state", state, source, {
      cache: createWrapCache(),
      repaint: () => undefined,
      backend: new ActionRuntime(state, () => undefined),
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined
    });

    expect(state.mode).toBe("FACTS");
    expect(state.facts?.pendingFactAction).toEqual({
      kind: "new-state",
      anchorPartId
    });
    const before = structuredClone(state.payload.facts);
    await dispatch(
      { action: "open-selected" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.editor).toBeNull();
    expect(state.mode).toBe("FACTS");
    expect(state.facts?.pendingFactAction).toEqual({
      kind: "new-state",
      anchorPartId
    });
    expect(state.payload.facts).toEqual(before);
    expect(state.toast).toBe("state creation requires a newer backend");
  });

  test("mouse dossier End State uses the story part that opened Facts", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    const fact = customFact(template, "dossier-end", "dossier end", [
      stateText("base", "Story-wide body."),
      stateText("branch", "Branch body.", "p12")
    ]);
    state.payload = { ...state.payload, facts: [fact] };
    const openedPartId = state.payload.path[0]!.id;
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), openedPartId);
    state.mode = "FACTS";
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

    await dispatch(
      { action: "open-selected" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );
    render(state);
    const endHit = state.hitRows
      .flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .find(({ hit }) => hit.target.kind === "action" && hit.target.action === "end-state");
    expect(endHit).toBeDefined();
    const mouseAction = mouseToAction(click(endHit!.hit.left + 1, endHit!.y), state);
    expect(mouseAction).toEqual({ action: "end-state" });
    await dispatch(
      mouseAction!, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );

    expect(state.editor?.kind).toBe("fact");
    expect(state.editor?.kind === "fact" ? state.editor.stateAnchorPartId : null)
      .toBe(openedPartId);
    expect(state.editor?.kind === "fact" ? state.editor.stateCursorAnchorId : null)
      .toBe(openedPartId);
    expect(state.editor?.kind === "fact" ? state.editor.stateIsEnd : false).toBeTrue();
  });

  test("opens the selected state's Anchor part", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: [customFact(template, "anchored", "anchored keeper", [
        stateText("base", "Old line."),
        stateText("current", "Current line.", "p12")
      ])]
    };
    state.mode = "FACTS";
    state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null,
      dossier: { factId: "anchored", stateIndex: 1, diff: false }
    };

    await dispatch(
      { action: "open-selected" },
      state,
      source,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined
    );

    expect(state.mode).toBe("NAV");
    expect(state.facts).toBeNull();
    expect(state.editor).toBeNull();
    expect(state.focusIndex).toBe(rowIndexForNode(createStoryViewModel(state.payload), "p12"));
  });

  test("keeps dossier verbs on the shared keyboard and mouse contract", () => {
    expect(resolveKey(key("return"), "FACTS").action).toBe("open-selected");
    expect(resolveKey(key("["), "FACTS", { factDossier: true })).toEqual({
      action: "cycle-state",
      index: -1
    });
    expect(resolveKey(key("]"), "FACTS", { factDossier: true })).toEqual({
      action: "cycle-state",
      index: 1
    });
    expect(resolveKey(key("e"), "FACTS", { factDossier: true }).action).toBe("edit");
    expect(resolveKey(key("n"), "FACTS", { factDossier: true }).action).toBe("new-state");
    expect(resolveKey(key("x"), "FACTS", { factDossier: true }).action).toBe("end-state");
    expect(resolveKey(key("d"), "FACTS", { factDossier: true }).action).toBe("toggle-fact-diff");

    const state = initialState(demoAppSource(), false);
    const fact = state.payload.facts[0]!;
    state.mode = "FACTS";
    state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null,
      scopeFilter: "everywhere",
      dossier: { factId: fact.id, stateIndex: 0, diff: false }
    };
    render(state);
    const endHit = state.hitRows
      .flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .find(({ hit }) => hit.target.kind === "action" && hit.target.action === "end-state");
    expect(endHit).toBeDefined();
    expect(mouseToAction(click(endHit!.hit.left + 1, endHit!.y), state))
      .toEqual({ action: "end-state" });
    const editHit = state.hitRows
      .flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .find(({ hit }) => hit.target.kind === "action" && hit.target.action === "edit");
    expect(editHit).toBeDefined();
    expect(mouseToAction(click(editHit!.hit.left + 1, editHit!.y), state))
      .toEqual({ action: "edit" });
    expect(canonicalFactStates(fact)).toHaveLength(1);
  });

  test("keeps wrapped scope chips clickable and keeps a later dossier state visible", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const template = state.payload.facts[0]!;
    const states = Array.from({ length: 9 }, (_, index) =>
      stateText(
        `state-${index}`,
        `Revision ${index}`,
        index === 0 ? undefined : state.payload.path[index]!.id
      ));
    state.payload = {
      ...state.payload,
      facts: [customFact(template, "many-states", "many states", states)]
    };
    state.mode = "FACTS";
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

    const overview = render(state, 70, 24);
    const scopeRows = state.hitRows
      .map((row, y) => ({ row, y }))
      .filter(({ row }) => row?.overrides?.some((hit) =>
        hit.target.kind === "chip" && hit.target.group === "scope"));
    expect(scopeRows.length).toBeGreaterThan(1);
    const endedHit = scopeRows
      .flatMap(({ row, y }) => row?.overrides
        ?.filter((hit) => hit.target.kind === "chip" && hit.target.group === "scope"
          && hit.target.index === 3)
        .map((hit) => ({ hit, y })) ?? [])
      .at(0);
    expect(endedHit).toBeDefined();
    expect(mouseToAction(click(endedHit!.hit.left + 1, endedHit!.y), state))
      .toEqual({ action: "cycle-fact-scope", index: 3 });
    expect(overview).toContain("[ ended ]");

    await dispatch(
      { action: "open-selected" },
      state,
      source,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined
    );
    await dispatch(
      { action: "focus-index", index: 8 },
      state,
      source,
      createWrapCache(),
      () => undefined,
      async () => undefined,
      () => undefined
    );
    const dossierText = render(state, 70, 12);
    expect(dossierText).toContain("st.9");
    const selected = state.hitRows
      .flatMap((row, y) => row?.overrides?.map((hit) => ({ hit, y })) ?? [])
      .find(({ hit }) => hit.target.kind === "list" && hit.target.rowId === "state-8");
    expect(selected).toBeDefined();
    expect(hitAt(state.hitRows, selected!.hit.left + 1, selected!.y)).toEqual({
      kind: "list",
      index: 8,
      rowId: "state-8",
      selected: true
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  composerPosition,
  insertComposerText,
  setComposerText
} from "../src/composer-model.js";
import { dispatch } from "../src/app.js";
import { createDemoController } from "../src/demo.js";
import { openFactEditor, openFactStateEditor } from "../src/editor-action.js";
import {
  factDraftToFactMetadataPatch,
  factDraftToFactPatch,
  factEditorChanged
} from "../src/fact-editor-draft.js";
import { resetFactEditorHistory } from "../src/fact-editor-policy.js";
import { captureMouseActionState, mouseToAction } from "../src/mouse-actions.js";
import { pasteInto } from "../src/keys.js";
import { nextRequestEstimate } from "../src/request-projection.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createStoryViewModel } from "../src/model.js";
import { currentPartActions } from "../src/story-actions.js";
import type { DocumentEditorSession, FactEditorSession, RuntimeState } from "../src/state.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { estimateTokens } from "../../shared/tokens.js";
import { MAX_FACT_NAME_CHARS } from "../../shared/fact-name.js";
import { MAX_FACT_TEXT_CHARS } from "../../shared/types.js";
import { MAX_FACT_STATES } from "../../shared/types.js";
import type { StoryFact } from "../../shared/types.js";
import { editorHarness, key } from "./editor-harness.js";
import { factText, factWithText } from "./fact-fixture.js";

/** Ctrl+S's raw terminal sequence (0x13), built at runtime so the literal
 *  control byte never has to live in this file's source text. */
const SAVE_SEQUENCE = String.fromCharCode(0x13);

const mouseClick = (x: number, y: number) => ({
  type: "down",
  button: 0,
  x,
  y,
  modifiers: { shift: false, alt: false, ctrl: false }
}) as never;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function activeFactEditor(state: RuntimeState): FactEditorSession {
  const editor = state.editor;
  if (editor?.kind !== "fact") throw new Error("expected an active Fact editor");
  return editor;
}

function activeDocumentEditor(state: RuntimeState): Extract<DocumentEditorSession, { kind: "document" }> {
  const editor = state.editor;
  if (editor?.kind !== "document") throw new Error("expected an active document editor");
  return editor;
}

function setFactDraft(
  state: RuntimeState,
  tag: string | null,
  text: string
): FactEditorSession {
  const editor = activeFactEditor(state);
  setComposerText(editor.tag, tag ?? "");
  setComposerText(editor.composer, text);
  return editor;
}

describe("Fact editor", () => {
  test("creates and edits a Fact, then returns to the Facts panel", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("n"));
    expect(activeFactEditor(state).target).toEqual({
      kind: "fact",
      factId: null,
      base: null
    });
    setFactDraft(state, "Place", "Lantern room\nAlways warm.");
    const draft = activeFactEditor(state);
    draft.activation = "keyed";
    setComposerText(draft.keys, "lantern, warm room");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.mode).toBe("FACTS");
    const created = state.payload.facts.find((fact) =>
      factText(fact).startsWith("Lantern room"));
    expect(created).toMatchObject({
      tag: "Place",
      activation: "keyed",
      keys: ["lantern", "warm room"],
    });
    expect(factText(created!)).toBe("Lantern room\nAlways warm.");

    state.facts!.selectedTag = "Place";
    state.facts!.cursor = 0;
    await press(key("e"));
    expect(activeFactEditor(state).target).toMatchObject({
      kind: "fact",
      factId: created!.id
    });
    setFactDraft(state, "Place", "Lantern room\nCold now.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(factText(state.payload.facts.find(({ id }) => id === created!.id)!))
      .toBe("Lantern room\nCold now.");
  });

  test("saves regex keys with commas and all activation settings", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("n"));
    const editor = setFactDraft(state, "Place", "The locked observatory.");
    editor.activation = "keyed";
    setComposerText(editor.keys, "/brass, key/i, observatory");
    setComposerText(editor.secondary, "permit");
    editor.secondaryMode = "not";
    setComposerText(editor.scan, "4");
    editor.recursion = "off";
    await press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));

    expect(state.payload.facts.find((fact) => factText(fact).startsWith("The locked")))
      .toMatchObject({
        activation: "keyed",
        keys: ["/brass, key/i", "observatory"],
        secondaryKeys: ["permit"],
        secondaryMode: "not",
        scanDepth: 4,
        recursion: "off"
      });
  });

  test("cycles preset tags and reuses a saved custom tag", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    let editor = activeFactEditor(state);
    expect(editor.tag.text).toBe("people");
    expect(editor.composer.text)
      .toBe("Maren\nKeeps the lantern-house and distrusts old coin.");

    await press(key("tab"));
    expect(editor.tag.text).toBe("places");
    let frame = frameText(renderStoryScreen(state, { width: 100, height: 24 }).lines);
    expect(frame).toContain("tag               ‹ places ›");

    await press(key("t", { sequence: "\u0014", ctrl: true }));
    for (const character of "omens") await press(key(character));
    expect(editor.tag.text).toBe("omens");
    expect(editor.composer.text)
      .toBe("Maren\nKeeps the lantern-house and distrusts old coin.");
    await press(key("down"));
    frame = frameText(renderStoryScreen(state, { width: 100, height: 24 }).lines);
    expect(frame).toContain("tag               ‹ omens ›");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.payload.facts[0]?.tag).toBe("omens");

    state.facts!.cursor = 1;
    await press(key("return"));
    editor = activeFactEditor(state);
    for (let index = 0; index < 4; index += 1) await press(key("tab"));
    expect(editor.tag.text).toBe("omens");
  });

  test("renders a long inactive tag on one truncated choice row", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = setFactDraft(
      state,
      "weather".repeat(30),
      "Body marker"
    );

    const frame = frameText(renderStoryScreen(state, { width: 60, height: 24 }).lines);
    expect(frame).toContain("tag               ‹");
    expect(frame).toContain("Body marker");
    expect(frame).not.toContain(editor.tag.text);
  });

  test("moves through all Fact fields from the body first row", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);
    editor.composer.anchor = null;
    editor.composer.cursor = 2;

    await press(key("up"));

    expect(editor.focus).toBe("budget");
    expect(composerPosition(editor.budget).column).toBe(0);
    await press(key("5"));
    expect(editor.budget.text).toBe("5");
    await press(key("up"));
    expect(editor.focus).toBe("priority");
    await press(key("right"));
    expect(editor.priority).toBe("high");
    await press(key("up"));
    expect(editor.focus).toBe("chain");
    await press(key("up"));
    expect(editor.focus).toBe("scan");
    await press(key("up"));
    expect(editor.focus).toBe("match");
    await press(key("up"));
    expect(editor.focus).toBe("secondary");
    await press(key("up"));
    expect(editor.focus).toBe("keys");
    expect(composerPosition(editor.keys).column).toBe(0);
    await press(key("X"));
    expect(editor.keys.text).toBe("X");
    await press(key("up"));
    expect(editor.focus).toBe("activation");
    await press(key("left"));
    expect(editor.activation).toBe("keyed");
    await press(key("up"));
    expect(editor.focus).toBe("tag");
    expect(editor.composer.text)
      .toBe("Maren\nKeeps the lantern-house and distrusts old coin.");
  });

  test("cycling a multi-code-point tag preserves the Fact body", async () => {
    const { state, press } = editorHarness();
    const first = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: [{
        ...factWithText(first, "Body stays whole.", { tag: "👨‍👩‍👧‍👦" })
      }, ...state.payload.facts.slice(1)]
    };

    await press(key("f"));
    await press(key("return"));
    await press(key("tab"));

    const editor = activeFactEditor(state);
    expect(editor.tag.text).toBe("");
    expect(editor.composer.text).toBe("Body stays whole.");
  });

  test("cycling a tag leaves subsequent typing in the body", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);

    await press(key("tab"));
    await press(key("!"));

    expect(editor.tag.text).toBe("places");
    expect(editor.composer.text)
      .toBe("Maren\nKeeps the lantern-house and distrusts old coin.!");
  });

  test("undo follows edit order across tag cycling and body input", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);
    editor.composer.anchor = null;
    editor.composer.cursor = editor.composer.text.length;

    await press(key("tab"));
    await press(key("!"));
    await press(key("z", { ctrl: true }));

    expect(editor.focus).toBe("body");
    expect(editor.composer.text)
      .toBe("Maren\nKeeps the lantern-house and distrusts old coin.");
    expect(editor.tag.text).toBe("places");

    await press(key("z", { ctrl: true }));
    expect(editor.focus).toBe("tag");
    expect(editor.tag.text).toBe("people");

    await press(key("z", { ctrl: true, shift: true }));
    await press(key("z", { ctrl: true, shift: true }));
    expect(editor.focus).toBe("body");
    expect(editor.tag.text).toBe("places");
    expect(editor.composer.text)
      .toBe("Maren\nKeeps the lantern-house and distrusts old coin.!");
  });

  test("native tag paste invalidates redo from the Fact body", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);

    await press(key("!"));
    await press(key("z", { ctrl: true }));
    await press(key("t", { sequence: "\u0014", ctrl: true }));
    expect(pasteInto(state, "weather")).toBeTrue();
    await press(key("z", { ctrl: true }));
    await press(key("z", { ctrl: true, shift: true }));
    await press(key("z", { ctrl: true, shift: true }));

    expect(editor.tag.text).toBe("weather");
    expect(editor.composer.text)
      .toBe("Maren\nKeeps the lantern-house and distrusts old coin.");
    expect(state.toast).toBe("nothing to redo");
  });

  test("undo retains a paste that lands after an authoritative reset", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);
    const original = editor.composer.text;

    await press(key("!"));
    await press(key("z", { ctrl: true }));

    let resume: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const paste = (async () => {
      await gate;
      insertComposerText(editor.composer, " pasted");
    })();
    setComposerText(editor.composer, original);
    resetFactEditorHistory(editor);
    resume();
    await paste;

    expect(editor.composer.text).toBe(`${original} pasted`);
    await press(key("z", { ctrl: true }));
    expect(editor.composer.text).toBe(original);
  });

  test("an empty Fact uses one body placeholder below its tag row", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("n"));

    const frame = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24 }
    ).lines);

    expect(frame).toContain("tag               ‹ none ›");
    expect(frame).toContain("fact text…");
    expect(frame).not.toContain("tag: optional");
  });

  test("saves a multi-paragraph body without changing its blank lines", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    setFactDraft(state, "people", "First paragraph.\n\nSecond paragraph.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.payload.facts[0]).toMatchObject({
      tag: "people"
    });
    expect(factText(state.payload.facts[0]!)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  test("shows a persisted multiline tag safely and preserves its body", async () => {
    const { state, press } = editorHarness();
    const first = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: [{
        ...factWithText(first, "Body stays whole.", { tag: "weather\nurgent" })
      }, ...state.payload.facts.slice(1)]
    };

    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);
    const frame = frameText(renderStoryScreen(state, { width: 80, height: 24 }).lines);

    expect(frame).toContain("‹ weather↵urgent ›");
    expect(editor.tag.text).toBe("weather\nurgent");
    expect(editor.composer.text).toBe("Body stays whole.");
    await press(key("t", { sequence: "\u0014", ctrl: true }));
    await press(key("right"));
    await press(key("X"));
    const editing = frameText(
      renderStoryScreen(state, { width: 80, height: 24 }).lines
    );
    expect(editing).toContain("[ urgentX");
    expect(editing).not.toContain("[ weather");
    expect(editor.tag.text).toBe("weather\nurgentX");
    await press(key("tab"));
    expect(editor.tag.text).toBe("people");
    expect(editor.composer.text).toBe("Body stays whole.");
  });

  test("a blank tag clears the persisted Fact tag", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    setFactDraft(state, null, "Body stays whole.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.payload.facts[0]).toMatchObject({
      tag: null
    });
    expect(factText(state.payload.facts[0]!)).toBe("Body stays whole.");
  });

  test("an untouched imported tag stays exact when the body changes", async () => {
    for (const importedTag of [" people ", ""]) {
      const { source, state, press } = editorHarness();
      const original = state.payload.facts[0]!;
      const imported = { ...original, tag: importedTag };
      state.payload = {
        ...state.payload,
        facts: [imported, ...state.payload.facts.slice(1)]
      };
      const patches: Array<{ tag?: string | null; text?: string }> = [];
      source.api.patchFact = async (_storyId, factId, body) => {
        patches.push(body);
        return {
          ...state.payload,
          facts: state.payload.facts.map((fact) =>
            fact.id === factId
              ? factWithText(fact, body.text ?? factText(fact), { tag: body.tag ?? null })
              : fact)
        };
      };

      openFactEditor(state, imported);
      await press(key("s", { sequence: "\u0013", ctrl: true }));
      expect(patches).toHaveLength(0);

      openFactEditor(state, imported);
      await press(key("!"));
      await press(key("s", { sequence: "\u0013", ctrl: true }));

      expect(patches).toHaveLength(1);
      expect(patches[0]?.tag).toBe(importedTag);
    }
  });

  test("custom tag paste flattens line separators without changing the body", async () => {
    for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
      const { state, press } = editorHarness();
      await press(key("f"));
      await press(key("return"));
      await press(key("t", { sequence: "\u0014", ctrl: true }));

      expect(pasteInto(state, `weather${separator}urgent`)).toBeTrue();
      const editor = activeFactEditor(state);
      expect(editor.tag.text).toBe("weather urgent");
      expect(editor.composer.text)
        .toBe("Maren\nKeeps the lantern-house and distrusts old coin.");
    }
  });

  test("newline input cannot split a custom tag", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    await press(key("t", { sequence: "\u0014", ctrl: true }));
    for (const character of "weather") await press(key(character));
    const editor = activeFactEditor(state);

    await press(key("return", { sequence: "\r" }));

    expect(editor.tag.text).toBe("weather");
    expect(state.toast).toBe("fact tags stay on one line");
    expect(editor.composer.text)
      .toBe("Maren\nKeeps the lantern-house and distrusts old coin.");
  });

  test("same-story recovery keeps a dirty draft and requires confirmation", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    openFactEditor(state, fact);
    setFactDraft(state, "Local", "local draft");
    const recovered = factWithText(fact, "recovered fact", { tag: "Remote" });
    adoptSameStoryPayload(state, {
      ...state.payload,
      facts: state.payload.facts.map((candidate) =>
        candidate.id === fact.id ? recovered : candidate)
    }, createWrapCache<ProseStyle>());

    const editor = activeFactEditor(state);
    expect(editor.tag.text).toBe("Local");
    expect(editor.composer.text).toBe("local draft");
    expect(editor.target.base).toEqual(recovered);
    let saves = 0;
    const patchFact = source.api.patchFact;
    source.api.patchFact = async (...args) => {
      saves += 1;
      return patchFact(...args);
    };

    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(saves).toBe(0);
    expect(editor.conflict?.armed).toBeTrue();
    expect(state.toast).toContain("ctrl+s again overwrites");
  });

  test("stateful recovery rebases metadata without replacing the selected state", () => {
    const { state } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const stateTwo = {
      id: "fact-state-two",
      anchorPartId,
      text: "state two body",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    state.payload = {
      ...state.payload,
      facts: [{ ...fact, states: [...fact.states, stateTwo] }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    expect(editor.composer.text).toBe("state two body");

    adoptSameStoryPayload(state, {
      ...state.payload,
      facts: state.payload.facts.map((candidate) => candidate.id === fact.id
        ? { ...candidate, name: "Remote name", tag: "Remote tag" }
        : candidate)
    }, createWrapCache<ProseStyle>());

    expect(editor.composer.text).toBe("state two body");
    expect(editor.name?.text).toBe("Remote name");
    expect(editor.tag.text).toBe("Remote tag");
    expect(editor.stateId).toBe(stateTwo.id);
    expect(editor.stateInitialId).toBe(stateTwo.id);
    expect(editor.stateInitialText).toBe("state two body");
    expect(editor.target.base?.name).toBe("Remote name");
    expect(editor.conflict).toBeNull();
  });

  test("state chrome exposes a re-anchor shortcut and hides for legacy Facts", async () => {
    const { state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const initialAnchorPartId = state.payload.path[0]!.id;
    const stateTwo = {
      id: "fact-state-reanchor",
      anchorPartId: initialAnchorPartId,
      text: "anchored state",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    state.payload = {
      ...state.payload,
      facts: [{ ...fact, states: [...fact.states, stateTwo] }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    editor.chromeFocus = "state";

    expect(editor.stateAnchorPartId).toBe(initialAnchorPartId);
    expect(editor.stateCursorAnchorId).not.toBeNull();
    const cursorAnchorPartId = editor.stateCursorAnchorId!;
    expect(cursorAnchorPartId).not.toBe(initialAnchorPartId);
    expect(frameText(renderStoryScreen(state, { width: 100, height: 24 }).lines))
      .toContain("a re-anchor ◆ cursor");
    await press(key("A"));
    expect(editor.stateAnchorPartId).toBe(initialAnchorPartId);
    await press(key("a"));
    expect(editor.stateAnchorPartId).toBe(cursorAnchorPartId);

    openFactEditor(state, fact);
    expect(frameText(renderStoryScreen(state, { width: 100, height: 24 }).lines))
      .not.toContain("states");
  });

  test("stateful recovery detects a dirty selected-state conflict and keeps remote text", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const stateTwo = {
      id: "fact-state-two",
      anchorPartId,
      text: "state two body",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    state.payload = {
      ...state.payload,
      facts: [{ ...fact, states: [...fact.states, stateTwo] }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    setComposerText(editor.composer, "local state two");
    const recovered = {
      ...state.payload,
      facts: state.payload.facts.map((candidate) => candidate.id === fact.id
        ? {
            ...candidate,
            states: candidate.states.map((candidateState) => candidateState.id === stateTwo.id
              ? { ...candidateState, text: "remote state two" }
              : candidateState)
          }
        : candidate)
    };
    adoptSameStoryPayload(state, recovered, createWrapCache<ProseStyle>());

    expect(editor.composer.text).toBe("local state two");
    expect(editor.stateInitialId).toBe(stateTwo.id);
    expect(editor.stateInitialText).toBe("state two body");
    expect(editor.conflict).toMatchObject({ resolution: "overwrite", armed: false });
    expect(state.payload.facts[0]!.states.find(({ id }) => id === stateTwo.id))
      .toMatchObject({ text: "remote state two" });

    let stateSaves = 0;
    const patchFactState = source.api.patchFactState!;
    source.api.patchFactState = async (...args) => {
      stateSaves += 1;
      return patchFactState(...args);
    };
    await press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));
    expect(stateSaves).toBe(0);
    expect(state.payload.facts[0]!.states.find(({ id }) => id === stateTwo.id))
      .toMatchObject({ text: "remote state two" });
  });

  test("selected state removal keeps a clean draft and saves it as a new state", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const stateTwo = {
      id: "fact-state-recovered-clean",
      anchorPartId,
      text: "state body to recover",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    const openedFact = {
      ...fact,
      name: "Initial name",
      states: [...fact.states, stateTwo]
    };
    state.payload = {
      ...state.payload,
      facts: [openedFact, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, openedFact, { stateId: stateTwo.id });

    const authoritativeFact = {
      ...openedFact,
      name: "Remote name",
      tag: "Remote tag",
      states: openedFact.states.filter(({ id }) => id !== stateTwo.id)
    };
    const authoritative = {
      ...state.payload,
      facts: [authoritativeFact, ...state.payload.facts.slice(1)]
    };
    let createBody: Parameters<NonNullable<typeof source.api.createFactState>>[2] | null = null;
    let statePatchCalls = 0;
    const originalPatchFactState = source.api.patchFactState!;
    source.api.patchFactState = async (...args) => {
      statePatchCalls += 1;
      return originalPatchFactState(...args);
    };
    source.api.createFactState = async (_storyId, _factId, body) => {
      createBody = body;
      const created = (body.ends === true
        ? {
            id: "fact-state-recreated",
            anchorPartId: body.anchorPartId ?? undefined,
            ends: true as const,
            createdAt: authoritativeFact.updatedAt,
            updatedAt: authoritativeFact.updatedAt
          }
        : {
            id: "fact-state-recreated",
            anchorPartId: body.anchorPartId ?? undefined,
            text: body.text ?? "",
            createdAt: authoritativeFact.updatedAt,
            updatedAt: authoritativeFact.updatedAt
          }) as StoryFact["states"][number];
      return {
        ...state.payload,
        facts: state.payload.facts.map((candidate) => candidate.id === authoritativeFact.id
          ? { ...candidate, states: [...candidate.states, created] }
          : candidate)
      };
    };

    adoptSameStoryPayload(state, authoritative, createWrapCache<ProseStyle>());

    const editor = activeFactEditor(state);
    expect(editor.stateCreating).toBeTrue();
    expect(editor.stateId).toBeNull();
    expect(editor.stateInitialId).toBeNull();
    expect(editor.composer.text).toBe("state body to recover");
    expect(editor.stateAnchorPartId).toBe(anchorPartId);
    expect(editor.name?.text).toBe("Remote name");
    expect(editor.tag.text).toBe("Remote tag");
    expect(editor.conflict).toBeNull();

    await press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));

    expect(statePatchCalls).toBe(0);
    expect(createBody).toMatchObject({
      text: "state body to recover",
      anchorPartId: anchorPartId
    });
    expect(state.editor).toBeNull();
    expect(state.payload.facts[0]!.states.some((candidate) =>
      candidate.id === "fact-state-recreated"
      && "text" in candidate
      && candidate.text === "state body to recover"
    )).toBeTrue();
  });

  test("selected End State removal keeps dirty state and Fact drafts for recreation", () => {
    const { state } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const localAnchorPartId = state.payload.path[0]!.id;
    const stateTwo = {
      id: "fact-state-recovered-end",
      anchorPartId,
      ends: true as const,
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    const openedFact = { ...fact, states: [...fact.states, stateTwo] };
    state.payload = {
      ...state.payload,
      facts: [openedFact, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, openedFact, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    setComposerText(editor.name!, "Local Fact name");
    setComposerText(editor.tag, "Local tag");
    editor.stateAnchorPartId = localAnchorPartId;
    setComposerText(editor.composer, "");

    adoptSameStoryPayload(state, {
      ...state.payload,
      facts: [{
        ...openedFact,
        name: "Remote Fact name",
        tag: "Remote tag",
        states: openedFact.states.filter(({ id }) => id !== stateTwo.id)
      }, ...state.payload.facts.slice(1)]
    }, createWrapCache<ProseStyle>());

    expect(editor.stateCreating).toBeTrue();
    expect(editor.stateId).toBeNull();
    expect(editor.stateInitialId).toBeNull();
    expect(editor.stateIsEnd).toBeTrue();
    expect(editor.composer.text).toBe("");
    expect(editor.stateAnchorPartId).toBe(localAnchorPartId);
    expect(editor.name?.text).toBe("Local Fact name");
    expect(editor.tag.text).toBe("Local tag");
    expect(factEditorChanged(editor)).toBeTrue();
    expect(state.toast).toContain("selected state deleted");
  });

  test("a conflicted draft overwrites recovery on the second save", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    openFactEditor(state, fact);
    setFactDraft(state, "Local", "local draft");
    const recovered = factWithText(fact, "recovered fact", { tag: "Remote" });
    adoptSameStoryPayload(state, {
      ...state.payload,
      facts: state.payload.facts.map((candidate) =>
        candidate.id === fact.id ? recovered : candidate)
    }, createWrapCache<ProseStyle>());
    let saves = 0;
    const patchFact = source.api.patchFact;
    source.api.patchFact = async (...args) => {
      saves += 1;
      return patchFact(...args);
    };

    await press(key("s", { sequence: "\u0013", ctrl: true }));
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(saves).toBe(1);
    expect(state.payload.facts.find(({ id }) => id === fact.id)).toMatchObject({ tag: "Local" });
    expect(factText(state.payload.facts.find(({ id }) => id === fact.id)!)).toBe("local draft");
  });

  test("a Fact deleted during recovery keeps its draft and saves as new", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    openFactEditor(state, fact);
    setFactDraft(state, "Recovered", "keep this deleted-Fact draft");
    adoptSameStoryPayload(state, {
      ...state.payload,
      facts: state.payload.facts.filter(({ id }) => id !== fact.id)
    }, createWrapCache<ProseStyle>());

    const editor = activeFactEditor(state);
    expect(editor.target).toMatchObject({
      kind: "fact",
      factId: null,
      base: null
    });
    expect(editor.conflict).toMatchObject({
      resolution: "create",
      armed: false
    });
    let creates = 0;
    const createFact = source.api.createFact;
    source.api.createFact = async (...args) => {
      creates += 1;
      return createFact(...args);
    };

    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(creates).toBe(0);
    expect(state.toast).toContain("ctrl+s again creates a new fact");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(creates).toBe(1);
    expect(state.payload.facts.some((candidate) =>
      candidate.tag === "Recovered" && factText(candidate) === "keep this deleted-Fact draft")).toBeTrue();
  });

  test("replacing selection with identical text invalidates sibling redo across keyboard and native paste", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);

    // Make an edit in body, then undo it to leave redo pending in body
    await press(key("!"));
    expect(editor.composer.text).toContain("!");
    await press(key("z", { ctrl: true }));
    expect(editor.composer.text).not.toContain("!");

    // Move to tag field and select its full text ("people")
    await press(key("t", { sequence: "\u0014", ctrl: true }));
    editor.tag.anchor = 0;
    editor.tag.cursor = editor.tag.text.length;

    // Replace selection with identical text "people" via native paste
    expect(pasteInto(state, "people")).toBeTrue();
    expect(editor.tag.text).toBe("people");

    // Redo should be invalidated
    await press(key("z", { ctrl: true, shift: true }));
    expect(state.toast).toBe("nothing to redo");
    expect(editor.composer.text).not.toContain("!");

    // Repeat for keyboard edit path: make edit in body, undo to leave redo pending
    await press(key("down"));
    await press(key("!"));
    await press(key("z", { ctrl: true }));

    // Move to tag and select "people"
    await press(key("t", { sequence: "\u0014", ctrl: true }));
    editor.tag.anchor = 0;
    editor.tag.cursor = editor.tag.text.length;

    // Replace selection with identical text "people" by backspacing selection
    await press(key("backspace"));
    expect(editor.tag.text).toBe("");
    // Redo should be invalidated
    await press(key("z", { ctrl: true, shift: true }));
    expect(state.toast).toBe("nothing to redo");
  });

  test("focus transitions clear sibling selection anchors and cut confirmations", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);

    // Start in tag field with selection and cut confirmation
    await press(key("t", { sequence: "\u0014", ctrl: true }));
    editor.tag.anchor = 0;
    editor.tag.cursor = 3;
    editor.tag.cutConfirmation = { start: 0, end: 3, text: "peo" };

    // Move focus through every fixed Fact row to the body.
    await press(key("down"));
    expect(editor.focus).toBe("activation");
    await press(key("down"));
    expect(editor.focus).toBe("keys");
    editor.keys.cutConfirmation = { start: 0, end: 1, text: "x" };
    await press(key("down"));
    expect(editor.focus).toBe("secondary");
    expect(editor.keys.cutConfirmation).toBe(null);
    await press(key("down"));
    expect(editor.focus).toBe("match");
    await press(key("down"));
    expect(editor.focus).toBe("scan");
    await press(key("down"));
    expect(editor.focus).toBe("chain");
    await press(key("down"));
    expect(editor.focus).toBe("priority");
    // Priority borrows budget's buffer identity, same as activation borrows
    // keys' — leaving keys for priority still clears keys' own confirmation.
    expect(editor.keys.cutConfirmation).toBe(null);
    editor.budget.cutConfirmation = { start: 0, end: 1, text: "5" };
    await press(key("down"));
    expect(editor.focus).toBe("budget");
    expect(editor.budget.cutConfirmation).toEqual({ start: 0, end: 1, text: "5" });
    await press(key("down"));
    expect(editor.focus).toBe("body");
    expect(editor.tag.anchor).toBe(null);
    expect(editor.tag.cutConfirmation).toBe(null);
    expect(editor.budget.cutConfirmation).toBe(null);

    // In body field, set selection and cut confirmation
    editor.composer.anchor = 0;
    editor.composer.cursor = 5;
    editor.composer.cutConfirmation = { start: 0, end: 5, text: "Maren" };

    // Move focus to budget. The body selection ownership clears immediately.
    await press(key("up"));
    expect(editor.focus).toBe("budget");
    expect(editor.composer.anchor).toBe(null);
    expect(editor.composer.cutConfirmation).toBe(null);
  });

  test("renders activation and keys and rejects duplicate normalized keys", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("n"));
    const editor = setFactDraft(state, null, "A keyed Fact.");
    editor.activation = "keyed";
    setComposerText(editor.keys, "Café, CAFÉ");

    const frame = frameText(renderStoryScreen(state, { width: 80, height: 24 }).lines);
    expect(frame).toContain("activation");
    expect(frame).toContain("‹ keyed ›");
    expect(frame).toContain("keys");

    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("EDITOR");
    expect(state.toast).toContain("duplicates another key");
  });

  test("a Fact ranked low and a tight Facts budget, both set through the interface, shed that Fact from the next request", async () => {
    const { state, press } = editorHarness();
    const facts = state.payload.facts;
    const shedId = facts.at(-1)!.id;

    // Rank the last Fact low through the Fact editor's priority row.
    state.facts = { cursor: facts.length - 1, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null };
    state.mode = "FACTS";
    await press(key("return"));
    expect(activeFactEditor(state).target).toMatchObject({ factId: shedId });
    // A new editor's cursor starts at the end of the body text; put it on
    // the first row so the next Up leaves the body instead of just moving
    // the text cursor within it.
    activeFactEditor(state).composer.anchor = null;
    activeFactEditor(state).composer.cursor = 0;
    await press(key("up")); // body -> budget
    await press(key("up")); // budget -> priority
    expect(activeFactEditor(state).focus).toBe("priority");
    await press(key("left")); // normal -> low
    expect(activeFactEditor(state).priority).toBe("low");
    await press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));
    expect(state.mode).toBe("FACTS");
    expect(state.payload.facts.find(({ id }) => id === shedId)?.priority).toBe("low");

    // Cap the story's Facts budget through the command palette, tight enough
    // to force exactly the one low-priority Fact out.
    const budget = state.payload.facts
      .filter(({ id }) => id !== shedId)
      .reduce((sum, fact) => sum + estimateTokens(factText(fact)), 0) + 1;
    await press(key("escape"));
    expect(state.mode).toBe("NAV");
    await press(key(":"));
    expect(state.mode).toBe("COMMANDS");
    for (const character of "facts budget") await press(key(character));
    expect(state.commands?.selectedId).toBe("facts-budget");
    await press(key("return"));
    const budgetEditor = activeDocumentEditor(state);
    expect(budgetEditor.target).toMatchObject({ kind: "story-scalar", field: "facts-budget" });
    setComposerText(budgetEditor.composer, String(budget));
    await press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.factsBudgetTokens).toBe(budget);

    // The ranked-low Fact leaves the next request; every other Fact stays.
    // No window here: this is about the story's own Facts budget, not
    // window-pressure shedding.
    const estimate = nextRequestEstimate(state.payload, {
      systemPrompt: "Write vivid prose.",
      instruction: "",
      assistantPrefill: true,
      operation: "continue",
      targetId: state.payload.path.at(-1)!.id,
      contextWindow: null,
      maxTokens: 0
    });
    expect(estimate.factStatuses.get(shedId)).toEqual({ kind: "dropped", reason: "total-budget" });
    expect([...estimate.factStatuses.values()].filter((status) => status.kind === "sent"))
      .toHaveLength(facts.length - 1);
    expect(estimate.droppedFacts).toEqual([{ factId: shedId, reason: "total-budget" }]);
  });

  test("Fact text owns plain m and brackets until the chrome row is focused", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);
    const before = editor.composer.text;
    await press(key("m"));
    await press(key("["));
    await press(key("]"));
    expect(editor.composer.text).toBe(`${before}m[]`);

    editor.chromeFocus = "view";
    await press(key("m"));
    expect(state.config.factsViewMode).toBe("simple");
    expect(editor.composer.text).toBe(`${before}m[]`);
    expect(frameText(renderStoryScreen(state, { width: 100, height: 24 }).lines))
      .toContain("▸ advanced");
  });

  test("non-default Fact options keep advanced rows visibly open", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const editor = activeFactEditor(state);
    editor.activation = "keyed";
    state.config = { ...state.config, factsViewMode: "simple" };

    const frame = frameText(renderStoryScreen(state, { width: 100, height: 24 }).lines);
    expect(frame).toContain("▾ advanced ·");
    expect(frame).toContain("activation");
  });

  test("new Fact scope defaults by entry point and cycles from keyboard and mouse", async () => {
    const { source, state, cache, press } = editorHarness();
    const anchorPartId = state.payload.path.at(-1)!.id;

    // The Facts overlay's n door starts story-wide. The scope row is still
    // visible, so the writer can choose the current part before saving.
    await press(key("f"));
    await press(key("n"));
    let editor = activeFactEditor(state);
    expect(editor.factAnchorPartId).toBeNull();
    expect(editor.factScopeAnchorPartId).toBe(anchorPartId);
    let frame = frameText(renderStoryScreen(state, { width: 100, height: 24 }).lines);
    expect(frame).toContain("scope");
    expect(frame).toContain("the whole story");

    // Plain scope-looking characters remain body input until the scope row
    // owns focus.
    const before = editor.composer.text;
    await press(key("m"));
    await press(key("["));
    await press(key("]"));
    expect(editor.composer.text).toBe(`${before}m[]`);

    // Simple mode makes the small creation surface explicit: body -> scope.
    state.config = { ...state.config, factsViewMode: "simple" };
    source.config = state.config;
    editor.composer.anchor = null;
    editor.composer.cursor = 0;
    await press(key("up"));
    expect(editor.focus).toBe("scope");
    await press(key("right"));
    expect(editor.factAnchorPartId).toBe(anchorPartId);
    frame = frameText(renderStoryScreen(state, { width: 100, height: 24 }).lines);
    expect(frame).toContain("from here on ◆");
    await press(key("tab"));
    expect(editor.focus).toBe("body");
    setComposerText(editor.composer, "A scoped creation.");
    await press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));

    const created = state.payload.facts.find((fact) =>
      factText(fact) === "A scoped creation."
    );
    expect(created?.states[0]?.anchorPartId).toBe(anchorPartId);

    // The part-action x door starts scoped. Its scope row has the same
    // action target as the keyboard cycler, and clicking it returns to the
    // story-wide choice.
    await press(key("escape"));
    const xAnchorPartId = createStoryViewModel(state.payload).rows[state.focusIndex]!.id;
    await press(key("x"));
    const factFromHere = currentPartActions(state).findIndex(({ id }) => id === "fact-from-here");
    expect(factFromHere).toBeGreaterThan(-1);
    state.actions!.cursor = factFromHere;
    await press(key("return"));
    editor = activeFactEditor(state);
    expect(editor.factAnchorPartId).toBe(xAnchorPartId);
    expect(editor.factScopeAnchorPartId).toBe(xAnchorPartId);

    const rendered = renderStoryScreen(state, { width: 100, height: 24 });
    Object.assign(state, rendered.derived);
    const scopeRow = state.hitRows.findIndex((row) => row?.overrides?.some((region) =>
      region.target.kind === "action" && region.target.action === "cycle-fact-scope"));
    expect(scopeRow).toBeGreaterThan(-1);
    const scopeRegion = state.hitRows[scopeRow]!.overrides!.find((region) =>
      region.target.kind === "action" && region.target.action === "cycle-fact-scope");
    expect(scopeRegion).toBeDefined();
    const mouseAction = mouseToAction(
      mouseClick(scopeRegion!.left, scopeRow),
      captureMouseActionState(state)
    );
    expect(mouseAction).toEqual({ action: "cycle-fact-scope" });
    await dispatch(mouseAction!, state, source, cache, () => undefined, async () => undefined, () => undefined);
    expect(activeFactEditor(state).factAnchorPartId).toBeNull();
  });

  test("state chrome owns bracket walking and Enter lands on its anchor", async () => {
    const { state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    state.payload = {
      ...state.payload,
      facts: [{
        ...fact,
        states: [
          ...fact.states,
          {
            id: "fact-state-branch",
            anchorPartId,
            text: "branch state body",
            createdAt: fact.updatedAt,
            updatedAt: fact.updatedAt
          }
        ]
      }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!);
    const editor = activeFactEditor(state);
    editor.chromeFocus = "state";
    await press(key("]"));
    expect(editor.stateId).toBe("fact-state-branch");
    expect(editor.composer.text).toBe("branch state body");
    await press(key("return"));
    expect(state.mode).toBe("NAV");
    expect(createStoryViewModel(state.payload).rows[state.focusIndex]?.id).toBe(anchorPartId);
  });

  test("summary focus hides re-anchor and rejects missing or invalid cursor actions", async () => {
    const { source, state, cache } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const stateTwo = {
      id: "fact-state-summary-focus",
      anchorPartId,
      text: "anchored state",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    const openedFact = { ...fact, states: [...fact.states, stateTwo] };
    state.payload = {
      ...state.payload,
      facts: [openedFact, ...state.payload.facts.slice(1)]
    };
    const summaryIndex = createStoryViewModel(state.payload).rows
      .findIndex((row) => row.kind === "chapter-summary");
    expect(summaryIndex).toBeGreaterThan(-1);
    state.focusIndex = summaryIndex;
    openFactEditor(state, openedFact, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    expect(editor.stateCursorAnchorId).toBeNull();
    editor.stateAnchorPartId = anchorPartId;
    editor.chromeFocus = "state";
    editor.stateCursorAnchorId = "missing-cursor-part";
    adoptSameStoryPayload(state, state.payload, cache);
    expect(editor.stateCursorAnchorId).toBeNull();

    const rendered = renderStoryScreen(state, { width: 100, height: 24 });
    Object.assign(state, rendered.derived);
    const reanchorHit = state.hitRows
      .flatMap((row) => row?.overrides ?? [])
      .find((region) => region.target.kind === "action"
        && region.target.action === "reanchor-state");
    expect(reanchorHit === undefined).toBeTrue();

    await dispatch(
      { action: "reanchor-state" },
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined
    );
    await dispatch(
      { action: "reanchor-state", rowId: "missing-cursor-part" },
      state,
      source,
      cache,
      () => undefined,
      async () => undefined,
      () => undefined
    );
    expect(editor.stateAnchorPartId).toBe(anchorPartId);
  });

  test("a dirty Fact stays open when keyboard Enter opens its state anchor", async () => {
    const { state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const stateTwo = {
      id: "fact-state-two",
      anchorPartId,
      text: "state two body",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    state.payload = {
      ...state.payload,
      facts: [{ ...fact, states: [...fact.states, stateTwo] }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    setComposerText(editor.composer, "dirty body");
    setComposerText(editor.name!, "dirty name");
    editor.activation = "keyed";
    editor.stateAnchorPartId = state.payload.path[0]!.id;
    editor.chromeFocus = "state";

    await press(key("return"));

    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.composer.text).toBe("dirty body");
    expect(editor.name?.text).toBe("dirty name");
    expect(state.toast).toBe("save or cancel this Fact before opening its anchor");
  });

  test("a dirty Fact stays open when mouse click opens its state anchor", async () => {
    const { source, state, cache } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const stateTwo = {
      id: "fact-state-two",
      anchorPartId,
      text: "state two body",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    state.payload = {
      ...state.payload,
      facts: [{ ...fact, states: [...fact.states, stateTwo] }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    setComposerText(editor.name!, "dirty name");

    const rendered = renderStoryScreen(state, { width: 100, height: 24 });
    Object.assign(state, rendered.derived);
    const stateRow = state.hitRows.findIndex((row) => row?.overrides?.some((region) =>
      region.target.kind === "action" && region.target.action === "open-state-anchor"));
    expect(stateRow).toBeGreaterThan(-1);
    const anchorRegion = state.hitRows[stateRow]!.overrides!.find((region) =>
      region.target.kind === "action" && region.target.action === "open-state-anchor");
    expect(anchorRegion).toBeDefined();
    const mouseAction = mouseToAction(
      mouseClick(anchorRegion!.left, stateRow),
      captureMouseActionState(state)
    );
    expect(mouseAction).toMatchObject({ action: "open-state-anchor", rowId: anchorPartId });
    await dispatch(mouseAction!, state, source, cache, () => undefined, async () => undefined, () => undefined);

    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.name?.text).toBe("dirty name");
    expect(state.toast).toBe("save or cancel this Fact before opening its anchor");
  });

  test("dirty Fact state cannot be armed for deletion from the keyboard action", async () => {
    const { source, state } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const stateTwo = {
      id: "fact-state-two",
      anchorPartId,
      text: "state two body",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    state.payload = {
      ...state.payload,
      facts: [{ ...fact, states: [...fact.states, stateTwo] }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    setComposerText(editor.composer, "dirty state body");
    setComposerText(editor.name!, "dirty Fact name");
    editor.stateAnchorPartId = state.payload.path[0]!.id;

    await dispatch(
      { action: "delete-state" },
      state,
      source,
      createWrapCache<ProseStyle>(),
      () => undefined,
      async () => undefined,
      () => undefined
    );

    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.stateDeleteArmedId).toBeNull();
    expect(editor.composer.text).toBe("dirty state body");
    expect(editor.name?.text).toBe("dirty Fact name");
    expect(state.payload.facts[0]!.states).toHaveLength(2);
    expect(state.toast).toBe("save or cancel this Fact before deleting its state");
  });

  test("mouse-confirmed state deletion keeps a draft when it becomes dirty", async () => {
    const { source, state, cache } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const stateTwo = {
      id: "fact-state-two",
      anchorPartId,
      text: "state two body",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    state.payload = {
      ...state.payload,
      facts: [{ ...fact, states: [...fact.states, stateTwo] }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    let deleteCalls = 0;
    const deleteFactState = source.api.deleteFactState!;
    source.api.deleteFactState = async (...args) => {
      deleteCalls += 1;
      return deleteFactState(...args);
    };

    const clickDelete = async () => {
      const rendered = renderStoryScreen(state, { width: 100, height: 24 });
      Object.assign(state, rendered.derived);
      const stateRow = state.hitRows.findIndex((row) => row?.overrides?.some((region) =>
        region.target.kind === "action" && region.target.action === "delete-state"));
      expect(stateRow).toBeGreaterThan(-1);
      const deleteRegion = state.hitRows[stateRow]!.overrides!.find((region) =>
        region.target.kind === "action" && region.target.action === "delete-state");
      expect(deleteRegion).toBeDefined();
      const mouseAction = mouseToAction(
        mouseClick(deleteRegion!.left, stateRow),
        captureMouseActionState(state)
      );
      expect(mouseAction).toMatchObject({ action: "delete-state", rowId: stateTwo.id });
      await dispatch(mouseAction!, state, source, cache, () => undefined, async () => undefined, () => undefined);
    };

    await clickDelete();
    expect(editor.stateDeleteArmedId).toBe(stateTwo.id);
    setComposerText(editor.name!, "dirty after confirmation");
    await clickDelete();

    expect(deleteCalls).toBe(0);
    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.stateDeleteArmedId).toBeNull();
    expect(editor.name?.text).toBe("dirty after confirmation");
    expect(state.payload.facts[0]!.states).toHaveLength(2);
    expect(state.toast).toBe("save or cancel this Fact before deleting its state");
  });

  test("state walking keeps an unsaved state draft", async () => {
    const { state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    state.payload = {
      ...state.payload,
      facts: [{
        ...fact,
        states: [
          ...fact.states,
          {
            id: "fact-state-branch",
            anchorPartId,
            text: "branch state body",
            createdAt: fact.updatedAt,
            updatedAt: fact.updatedAt
          }
        ]
      }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!, { stateId: fact.states[0]!.id });
    const editor = activeFactEditor(state);
    setComposerText(editor.composer, "unsaved state body");
    editor.chromeFocus = "state";

    await press(key("["));
    expect(editor.composer.text).toBe("unsaved state body");
    await press(key("]"));
    expect(editor.stateId).toBe(fact.states[0]!.id);
    expect(editor.composer.text).toBe("unsaved state body");
    expect(state.toast).toBe("save or cancel this state before opening another");
  });

  test("an End State opens clean and can walk to its previous state", async () => {
    const { state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const ended = {
      id: "fact-state-end",
      anchorPartId,
      ends: true as const,
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    state.payload = {
      ...state.payload,
      facts: [{ ...fact, states: [...fact.states, ended] }, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, state.payload.facts[0]!, { stateId: ended.id });
    const editor = activeFactEditor(state);
    expect(factEditorChanged(editor)).toBeFalse();
    editor.chromeFocus = "state";
    await press(key("["));
    expect(editor.stateId).toBe(fact.states[0]!.id);
  });

  test("Fact State PATCH keeps edits typed while the request is in flight", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    const stateTwo = {
      id: "fact-state-in-flight-patch",
      anchorPartId,
      text: "original state body",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    const openedFact = { ...fact, states: [...fact.states, stateTwo] };
    state.payload = {
      ...state.payload,
      facts: [openedFact, ...state.payload.facts.slice(1)]
    };
    openFactEditor(state, openedFact, { stateId: stateTwo.id });
    const editor = activeFactEditor(state);
    setComposerText(editor.composer, "submitted state body");
    setComposerText(editor.name!, "submitted name");

    const entered = deferred<void>();
    const gate = deferred<typeof state.payload>();
    let requestBody: unknown = null;
    source.api.patchFactState = async (_storyId, _factId, _stateId, body) => {
      requestBody = body;
      entered.resolve();
      return gate.promise;
    };

    const saving = press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));
    await entered.promise;
    setComposerText(editor.composer, "newer state body");
    setComposerText(editor.name!, "newer name");
    editor.activation = "keyed";

    gate.resolve({
      ...state.payload,
      facts: state.payload.facts.map((candidate) => candidate.id === openedFact.id
        ? {
            ...candidate,
            name: "submitted name",
            states: candidate.states.map((candidateState) => candidateState.id === stateTwo.id
              ? { ...candidateState, text: "submitted state body" }
              : candidateState)
          }
        : candidate)
    });
    await saving;

    expect(requestBody).toMatchObject({
      text: "submitted state body",
      metadata: { name: "submitted name" }
    });
    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.composer.text).toBe("newer state body");
    expect(editor.name?.text).toBe("newer name");
    expect(editor.activation).toBe("keyed");
    expect(editor.stateInitialText).toBe("submitted state body");
    expect(state.toast).toBe("Fact state saved · newer edits kept");
  });

  test("Fact State creation keeps edits typed while the request is in flight", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path[0]!.id;
    openFactStateEditor(state, fact, anchorPartId);
    const editor = activeFactEditor(state);
    setComposerText(editor.composer, "submitted new state");
    setComposerText(editor.name!, "submitted name");

    const entered = deferred<void>();
    const gate = deferred<typeof state.payload>();
    let requestBody: unknown = null;
    source.api.createFactState = async (_storyId, _factId, body) => {
      requestBody = body;
      entered.resolve();
      return gate.promise;
    };

    const saving = press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));
    await entered.promise;
    setComposerText(editor.composer, "newer new state");
    setComposerText(editor.name!, "newer name");
    editor.activation = "keyed";

    const createdState = {
      id: "fact-state-in-flight-create",
      anchorPartId,
      text: "submitted new state",
      createdAt: fact.updatedAt,
      updatedAt: fact.updatedAt
    };
    gate.resolve({
      ...state.payload,
      facts: state.payload.facts.map((candidate) => candidate.id === fact.id
        ? { ...candidate, name: "submitted name", states: [...candidate.states, createdState] }
        : candidate)
    });
    await saving;

    expect(requestBody).toMatchObject({
      text: "submitted new state",
      anchorPartId,
      metadata: { name: "submitted name" }
    });
    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(editor);
    expect(editor.stateCreating).toBeFalse();
    expect(editor.stateId).toBe(createdState.id);
    expect(editor.composer.text).toBe("newer new state");
    expect(editor.name?.text).toBe("newer name");
    expect(editor.activation).toBe("keyed");
    expect(editor.stateInitialText).toBe("submitted new state");
    expect(state.toast).toBe("Fact state saved · newer edits kept");
  });

  test("one state save carries metadata through the atomic state mutation", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    state.payload = await source.api.createFactState!(state.payload.id, fact.id, {
      text: "branch state body",
      anchorPartId
    });
    const branch = state.payload.facts[0]!.states.find((candidate) => candidate.anchorPartId === anchorPartId)!;
    openFactEditor(state, state.payload.facts[0]!, { stateId: branch.id });
    const editor = activeFactEditor(state);
    setComposerText(editor.name!, "Branch-aware keeper");
    setComposerText(editor.composer, "updated branch state");
    let separateMetadataSaves = 0;
    const patchFact = source.api.patchFact;
    source.api.patchFact = async (...args) => {
      separateMetadataSaves += 1;
      return patchFact(...args);
    };
    let combinedBody: unknown = null;
    const patchFactState = source.api.patchFactState!;
    source.api.patchFactState = async (storyId, factId, stateId, body) => {
      combinedBody = body;
      return patchFactState(storyId, factId, stateId, body);
    };

    await press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));

    expect(separateMetadataSaves).toBe(0);
    expect(combinedBody).toMatchObject({
      text: "updated branch state",
      metadata: { name: "Branch-aware keeper" }
    });
    expect(state.payload.facts[0]!.name).toBe("Branch-aware keeper");
  });

  test("one state metadata-only save uses the ordinary Fact mutation", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchorPartId = state.payload.path.at(-1)!.id;
    state.payload = await source.api.createFactState!(state.payload.id, fact.id, {
      text: "branch state body",
      anchorPartId
    });
    const branch = state.payload.facts[0]!.states.find((candidate) => candidate.anchorPartId === anchorPartId)!;
    openFactEditor(state, state.payload.facts[0]!, { stateId: branch.id });
    const editor = activeFactEditor(state);
    setComposerText(editor.name!, "Metadata-only keeper");
    const originalPatchFact = source.api.patchFact;
    let factPatchBody: unknown = null;
    source.api.patchFact = async (storyId, factId, body) => {
      factPatchBody = body;
      return originalPatchFact(storyId, factId, body);
    };
    let statePatchCalls = 0;
    const originalPatchFactState = source.api.patchFactState!;
    source.api.patchFactState = async (...args) => {
      statePatchCalls += 1;
      return originalPatchFactState(...args);
    };

    await press(key("s", { sequence: SAVE_SEQUENCE, ctrl: true }));

    expect(statePatchCalls).toBe(0);
    expect(factPatchBody).toMatchObject({ name: "Metadata-only keeper" });
    expect(state.payload.facts[0]!.name).toBe("Metadata-only keeper");
    expect(state.payload.facts[0]!.states.find(({ id }) => id === branch.id)).toMatchObject({
      text: "branch state body",
      anchorPartId
    });
  });

  test("ordinary and state metadata conversion share the same FactDraft fields", () => {
    const draft = {
      name: undefined,
      tag: "people",
      activation: "keyed" as const,
      keys: ["lantern"],
      secondaryKeys: ["storm"],
      secondaryMode: "not" as const,
      scanDepth: 4,
      recursion: "off" as const,
      priority: "high" as const,
      budgetTokens: 512,
      text: "the keeper remembers"
    };
    const full = factDraftToFactPatch(draft, { includeName: true });
    const { text: _text, ...withoutText } = full;

    expect(factDraftToFactMetadataPatch(draft, { includeName: true })).toEqual(withoutText);
    expect(full.name).toBe(null);
    expect("name" in factDraftToFactPatch(draft)).toBeFalse();
    expect(full.keys).not.toBe(draft.keys);
    expect(full.secondaryKeys).not.toBe(draft.secondaryKeys);
  });

  test("demo Fact names use canonical normalization and reject invalid input", () => {
    const demo = createDemoController();
    const nfd = "Cafe\u0301";
    const created = demo.createFact({ name: nfd, text: "named Fact" });
    const createdFact = created.facts.at(-1)!;
    expect(createdFact.name).toBe("Café");

    const beforeInvalid = demo.payload().facts.map(({ id, name }) => ({ id, name }));
    const overLimit = "n".repeat(MAX_FACT_NAME_CHARS + 1);
    expect(() => demo.createFact({
      name: overLimit,
      text: "too long"
    })).toThrow(`${MAX_FACT_NAME_CHARS}-character limit`);
    expect(() => demo.patchFact(createdFact.id, { name: overLimit }))
      .toThrow(`${MAX_FACT_NAME_CHARS}-character limit`);
    const malformed = `bad${String.fromCharCode(0xd800)}`;
    expect(() => demo.createFact({ name: malformed, text: "bad Unicode" }))
      .toThrow("Fact name contains invalid Unicode");
    expect(() => demo.patchFact(createdFact.id, {
      name: malformed
    })).toThrow("Fact name contains invalid Unicode");
    expect(demo.payload().facts.map(({ id, name }) => ({ id, name }))).toEqual(beforeInvalid);

    const patched = demo.patchFact(createdFact.id, { name: "Cafe\u0301" });
    expect(patched.facts.find(({ id }) => id === createdFact.id)?.name).toBe("Café");
  });

  test("demo state creation stays collision-free after a middle deletion", async () => {
    const { source, state } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchors = state.payload.nodes
      .filter((node) => node.role !== "summary")
      .slice(0, 3)
      .map(({ id }) => id);
    expect(anchors).toHaveLength(3);

    let payload = await source.api.createFactState!(state.payload.id, fact.id, {
      text: "second state",
      anchorPartId: anchors[0]
    });
    const secondId = payload.facts[0]!.states.at(-1)!.id;
    payload = await source.api.createFactState!(state.payload.id, fact.id, {
      text: "third state",
      anchorPartId: anchors[1]
    });
    const thirdId = payload.facts[0]!.states.at(-1)!.id;
    await source.api.deleteFactState!(state.payload.id, fact.id, secondId);
    payload = await source.api.createFactState!(state.payload.id, fact.id, {
      text: "state after deletion",
      anchorPartId: anchors[2]
    });

    const ids = payload.facts[0]!.states.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(thirdId);
    expect(payload.facts[0]!.states.at(-1)).toMatchObject({ text: "state after deletion" });
  });

  test("demo anchor-only state PATCH preserves an End State", async () => {
    const { source, state } = editorHarness();
    const fact = state.payload.facts[0]!;
    const anchors = state.payload.nodes
      .filter((node) => node.role !== "summary")
      .slice(0, 2)
      .map(({ id }) => id);
    expect(anchors).toHaveLength(2);

    let payload = await source.api.createFactState!(state.payload.id, fact.id, {
      ends: true,
      anchorPartId: anchors[0]
    });
    const endStateId = payload.facts[0]!.states.at(-1)!.id;
    payload = await source.api.patchFactState!(state.payload.id, fact.id, endStateId, {
      anchorPartId: anchors[1]
    });

    const reanchored = payload.facts[0]!.states.find(({ id }) => id === endStateId)!;
    expect(reanchored).toMatchObject({ id: endStateId, anchorPartId: anchors[1], ends: true });
    expect("text" in reanchored).toBeFalse();
  });

  test("demo Fact State creation enforces the shared state capacity", () => {
    const demo = createDemoController(true);
    const initial = demo.payload();
    const fact = initial.facts[0]!;
    const anchors = initial.nodes
      .filter((node) => node.role !== "summary")
      .map(({ id }) => id);
    expect(anchors.length).toBeGreaterThan(MAX_FACT_STATES - 2);

    let payload = initial;
    for (let index = 0; index < MAX_FACT_STATES - 1; index += 1) {
      payload = demo.createFactState(fact.id, {
        text: `state ${index + 1}`,
        anchorPartId: anchors[index]
      });
    }
    expect(payload.facts[0]!.states).toHaveLength(MAX_FACT_STATES);
    expect(() => demo.createFactState(fact.id, {
      text: "one too many",
      anchorPartId: anchors[MAX_FACT_STATES - 1]
    })).toThrow(new RegExp(`maximum of ${MAX_FACT_STATES} states`));
  });

  test("demo Fact State creation enforces the aggregate text limit", () => {
    const demo = createDemoController();
    const initial = demo.payload();
    const fact = initial.facts[0]!;
    const anchors = initial.nodes
      .filter((node) => node.role !== "summary")
      .slice(0, 2)
      .map(({ id }) => id);
    demo.createFactState(fact.id, {
      text: "x".repeat(60_000),
      anchorPartId: anchors[0]
    });

    expect(() => demo.createFactState(fact.id, {
      text: "y".repeat(40_001),
      anchorPartId: anchors[1]
    })).toThrow(new RegExp(`${MAX_FACT_TEXT_CHARS}-character aggregate limit`));
    expect(demo.payload().facts[0]!.states).toHaveLength(2);
  });

  test("demo Fact State mutations reject unknown and summary anchors", () => {
    const demo = createDemoController();
    const initial = demo.payload();
    const fact = initial.facts[0]!;
    const proseAnchors = initial.nodes.filter((node) => node.role !== "summary");
    const anchor = proseAnchors[0]!.id;
    const summary = initial.nodes.find((node) => node.role === "summary")!;

    expect(() => demo.createFactState(fact.id, {
      text: "unknown anchor",
      anchorPartId: "missing-anchor"
    })).toThrow("Unknown anchor part: missing-anchor");
    expect(() => demo.createFactState(fact.id, {
      text: "summary anchor",
      anchorPartId: summary.id
    })).toThrow(`Unknown anchor part: ${summary.id}`);

    const payload = demo.createFactState(fact.id, { text: "anchored", anchorPartId: anchor });
    const stateId = payload.facts[0]!.states.at(-1)!.id;
    expect(() => demo.patchFactState(fact.id, stateId, {
      anchorPartId: "missing-anchor"
    })).toThrow("Unknown anchor part: missing-anchor");
    expect(() => demo.patchFactState(fact.id, stateId, {
      anchorPartId: summary.id
    })).toThrow(`Unknown anchor part: ${summary.id}`);
  });
});

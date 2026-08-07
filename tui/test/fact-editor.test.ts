import { describe, expect, test } from "bun:test";
import {
  composerPosition,
  insertComposerText,
  setComposerText
} from "../src/composer-model.js";
import { openFactEditor } from "../src/editor-action.js";
import { resetFactEditorHistory } from "../src/fact-editor-policy.js";
import { pasteInto } from "../src/keys.js";
import { nextRequestEstimate } from "../src/request-projection.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import type { DocumentEditorSession, FactEditorSession, RuntimeState } from "../src/state.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { estimateTokens } from "../../shared/tokens.js";
import { editorHarness, key } from "./editor-harness.js";

/** Ctrl+S's raw terminal sequence (0x13), built at runtime so the literal
 *  control byte never has to live in this file's source text. */
const SAVE_SEQUENCE = String.fromCharCode(0x13);

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
    const created = state.payload.facts.find(({ text }) =>
      text.startsWith("Lantern room"));
    expect(created).toMatchObject({
      tag: "Place",
      activation: "keyed",
      keys: ["lantern", "warm room"],
      text: "Lantern room\nAlways warm."
    });

    state.facts!.selectedTag = "Place";
    state.facts!.cursor = 0;
    await press(key("e"));
    expect(activeFactEditor(state).target).toMatchObject({
      kind: "fact",
      factId: created!.id
    });
    setFactDraft(state, "Place", "Lantern room\nCold now.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.payload.facts.find(({ id }) => id === created!.id)?.text)
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

    expect(state.payload.facts.find(({ text }) => text.startsWith("The locked")))
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
        ...first,
        tag: "👨‍👩‍👧‍👦",
        text: "Body stays whole."
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
      tag: "people",
      text: "First paragraph.\n\nSecond paragraph."
    });
  });

  test("shows a persisted multiline tag safely and preserves its body", async () => {
    const { state, press } = editorHarness();
    const first = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: [{
        ...first,
        tag: "weather\nurgent",
        text: "Body stays whole."
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
      tag: null,
      text: "Body stays whole."
    });
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
              ? { ...fact, tag: body.tag ?? null, text: body.text ?? fact.text }
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
    const recovered = { ...fact, tag: "Remote", text: "recovered fact" };
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

  test("a conflicted draft overwrites recovery on the second save", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    openFactEditor(state, fact);
    setFactDraft(state, "Local", "local draft");
    const recovered = { ...fact, tag: "Remote", text: "recovered fact" };
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
    expect(state.payload.facts.find(({ id }) => id === fact.id)).toMatchObject({
      tag: "Local",
      text: "local draft"
    });
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
    expect(state.payload.facts.some(({ tag, text }) =>
      tag === "Recovered" && text === "keep this deleted-Fact draft")).toBeTrue();
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
      .reduce((sum, fact) => sum + estimateTokens(fact.text), 0) + 1;
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
});

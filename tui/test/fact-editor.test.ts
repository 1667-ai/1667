import { describe, expect, test } from "bun:test";
import { setComposerText } from "../src/composer-model.js";
import { openFactEditor } from "../src/editor-action.js";
import { parseFactEditor } from "../src/facts-model.js";
import { pasteInto } from "../src/keys.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { editorHarness, key } from "./editor-harness.js";

describe("Fact editor", () => {
  test("facts create and edit inline, returning to the facts panel", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("n"));
    expect(state.editor?.target).toEqual({ kind: "fact", factId: null, base: null });
    setComposerText(state.editor!.composer, "tag: Place\nLantern room\nAlways warm.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.mode).toBe("FACTS");
    const created = state.payload.facts.find(({ text }) => text.startsWith("Lantern room"));
    expect(created).toMatchObject({ tag: "Place", text: "Lantern room\nAlways warm." });

    state.facts!.selectedTag = "Place";
    state.facts!.cursor = 0;
    await press(key("e"));
    expect(state.editor?.target).toEqual({ kind: "fact", factId: created!.id, base: created });
    setComposerText(state.editor!.composer, "tag: Place\nLantern room\nCold now.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.payload.facts.find(({ id }) => id === created!.id)?.text).toBe("Lantern room\nCold now.");
  });

  test("Fact Enter edits and the tag slider reuses a saved custom tag", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));

    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.target.kind).toBe("fact");
    expect(state.editor?.composer.text.startsWith("tag: people")).toBeTrue();

    await press(key("tab"));
    expect(state.editor?.composer.text.startsWith("tag: places")).toBeTrue();
    expect(frameText(renderStoryScreen(state, { width: 100, height: 24 }).lines))
      .toContain("tag ‹ places ›");

    await press(key("t", { sequence: "\u0014", ctrl: true }));
    for (const character of "omens") await press(key(character));
    expect(state.editor?.composer.text.startsWith("tag: omens")).toBeTrue();
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.payload.facts[0]?.tag).toBe("omens");

    state.facts!.cursor = 1;
    await press(key("return"));
    for (let index = 0; index < 4; index += 1) await press(key("tab"));
    expect(state.editor?.composer.text.startsWith("tag: omens")).toBeTrue();
  });

  test("cycling a multi-code-point Fact tag preserves its body", async () => {
    const { state, press } = editorHarness();
    const first = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: [{ ...first, tag: "👨‍👩‍👧‍👦", text: "Body stays whole." }, ...state.payload.facts.slice(1)]
    };

    await press(key("f"));
    await press(key("return"));
    await press(key("tab"));

    expect(state.editor?.composer.text).toBe("tag: \n\nBody stays whole.");
  });

  test("cycling a Fact tag keeps subsequent typing in the body", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    await press(key("tab"));
    await press(key("!"));

    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: "places",
      text: "Maren\nKeeps the lantern-house and distrusts old coin.!"
    });
  });

  test("Fact tag cycle redo restores the body caret for typing", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    await press(key("tab"));
    await press(key("z", { ctrl: true }));
    await press(key("z", { ctrl: true, shift: true }));
    await press(key("!"));

    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: "places",
      text: "Maren\nKeeps the lantern-house and distrusts old coin.!"
    });
    expect(state.editor!.composer.text.endsWith("!")).toBeTrue();
  });

  test("Tab after deleting header records undo and keeps typing in the body", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const body = parseFactEditor(state.editor!.composer.text)!.text;
    // Header removed; a body edit after that must remain undoable across Tab.
    setComposerText(state.editor!.composer, body);
    await press(key("!"));
    const headerless = state.editor!.composer.text;
    expect(headerless.startsWith("tag:")).toBeFalse();
    expect(headerless.endsWith("!")).toBeTrue();

    await press(key("tab"));
    expect(state.editor!.composer.text.startsWith("tag: ")).toBeTrue();
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: "people",
      text: headerless
    });

    // Undo restores the headerless document (and the prior body edit).
    await press(key("z", { ctrl: true }));
    expect(state.editor!.composer.text).toBe(headerless);
    expect(state.editor!.composer.text.startsWith("tag:")).toBeFalse();

    // Redo restores the Tab command state.
    await press(key("z", { ctrl: true, shift: true }));
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: "people",
      text: headerless
    });

    // Typing lands in the body, not the tag field.
    await press(key("?"));
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: "people",
      text: `${headerless}?`
    });
  });

  test("Ctrl+T after deleting header records undo and types into the tag", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    const body = parseFactEditor(state.editor!.composer.text)!.text;
    setComposerText(state.editor!.composer, body);
    await press(key("!"));
    const headerless = state.editor!.composer.text;
    expect(headerless.startsWith("tag:")).toBeFalse();

    await press(key("t", { sequence: "\u0014", ctrl: true }));
    expect(state.editor!.composer.text.startsWith("tag: ")).toBeTrue();
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: null,
      text: headerless
    });

    await press(key("z", { ctrl: true }));
    expect(state.editor!.composer.text).toBe(headerless);

    await press(key("z", { ctrl: true, shift: true }));
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: null,
      text: headerless
    });

    // Redo leaves the tag field selected; typing fills the custom tag.
    for (const character of "omens") await press(key(character));
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: "omens",
      text: headerless
    });
    expect(state.editor!.composer.text.startsWith("tag: omens")).toBeTrue();
    expect(state.editor!.composer.text.endsWith("omens")).toBeFalse();
  });

  test("Ctrl+T on tag-json redo leaves typing in the custom tag field", async () => {
    const { state, press } = editorHarness();
    const first = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: [{
        ...first,
        tag: "weather\nurgent",
        text: "Maren\nKeeps the lantern-house and distrusts old coin."
      }, ...state.payload.facts.slice(1)]
    };

    await press(key("f"));
    await press(key("return"));
    expect(state.editor?.composer.text)
      .toBe('tag-json: "weather\\nurgent"\n\nMaren\nKeeps the lantern-house and distrusts old coin.');

    await press(key("t", { sequence: "\u0014", ctrl: true }));
    expect(state.editor?.composer.text.startsWith("tag: ")).toBeTrue();

    await press(key("z", { ctrl: true }));
    expect(state.editor?.composer.text.startsWith("tag-json:")).toBeTrue();

    await press(key("z", { ctrl: true, shift: true }));
    // Redo must restore tag-field selection, not the body caret.
    for (const character of "omens") await press(key(character));
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: "omens",
      text: "Maren\nKeeps the lantern-house and distrusts old coin."
    });
    expect(state.editor!.composer.text.startsWith("tag: omens")).toBeTrue();
    expect(state.editor!.composer.text.endsWith("omens")).toBeFalse();
  });

  test("saving a multi-paragraph Fact body without the header blank keeps both paragraphs", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    setComposerText(
      state.editor!.composer,
      "tag: people\nFirst paragraph.\n\nSecond paragraph."
    );
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.payload.facts[0]).toMatchObject({
      tag: "people",
      text: "First paragraph.\n\nSecond paragraph."
    });
  });

  test("cycling a persisted multiline Fact tag preserves its body", async () => {
    const { state, press } = editorHarness();
    const first = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: [{ ...first, tag: "weather\nurgent", text: "Body stays whole." }, ...state.payload.facts.slice(1)]
    };

    await press(key("f"));
    await press(key("return"));
    expect(state.editor?.composer.text)
      .toBe('tag-json: "weather\\nurgent"\n\nBody stays whole.');
    await press(key("tab"));

    expect(state.editor?.composer.text).toBe("tag: people\n\nBody stays whole.");
  });

  test("malformed tag-json rejects save and keeps the persisted Fact tag", async () => {
    const { source, state, press } = editorHarness();
    const first = state.payload.facts[0]!;
    const multilineTag = "weather\nurgent";
    state.payload = {
      ...state.payload,
      facts: [{ ...first, tag: multilineTag, text: "Body stays whole." }, ...state.payload.facts.slice(1)]
    };

    await press(key("f"));
    await press(key("return"));
    expect(state.editor?.composer.text)
      .toBe('tag-json: "weather\\nurgent"\n\nBody stays whole.');

    setComposerText(state.editor!.composer, 'tag-json: "weather\\nurgent\n\nBody stays whole.');
    let patches = 0;
    const patchFact = source.api.patchFact;
    source.api.patchFact = async (...args) => { patches += 1; return patchFact(...args); };

    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(patches).toBe(0);
    expect(state.editor).not.toBe(null);
    expect(state.toast).toContain("invalid tag-json");
    expect(state.payload.facts[0]).toMatchObject({
      tag: multilineTag,
      text: "Body stays whole."
    });
  });

  test("blank tag: header still clears a persisted Fact tag", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    expect(state.payload.facts[0]?.tag).toBe("people");

    setComposerText(state.editor!.composer, "tag: \n\nBody stays whole.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.payload.facts[0]).toMatchObject({
      tag: null,
      text: "Body stays whole."
    });
  });

  test("custom Fact tag paste keeps separators out of the Fact body", async () => {
    for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
      const { state, press } = editorHarness();
      await press(key("f"));
      await press(key("return"));
      await press(key("t", { sequence: "\u0014", ctrl: true }));

      for (const character of "weather") await press(key(character));
      expect(pasteInto(state, `${separator}urgent`)).toBeTrue();
      await press(key("s", { sequence: "\u0013", ctrl: true }));

      expect(state.payload.facts[0]?.tag).toBe("weather urgent");
      expect(state.payload.facts[0]?.text).toBe("Maren\nKeeps the lantern-house and distrusts old coin.");
    }
  });

  test("native newline-only paste into a selected Fact tag matches Ctrl+V toast", async () => {
    for (const separator of ["\n", "\r", "\u2028", "\u2029", "\n\n", "\r\n"]) {
      const { state, press } = editorHarness();
      await press(key("f"));
      await press(key("return"));
      await press(key("t", { sequence: "\u0014", ctrl: true }));
      const before = state.editor!.composer.text;

      expect(pasteInto(state, separator)).toBeTrue();
      expect(state.editor!.composer.text).toBe(before);
      expect(state.toast).toBe("fact tags stay on one line");
    }
  });

  test("Enter inside a Fact tag keeps the tag on one line and saves cleanly", async () => {
    const body = "Maren\nKeeps the lantern-house and distrusts old coin.";
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    await press(key("t", { sequence: "\u0014", ctrl: true }));
    for (const character of "weather") await press(key(character));

    // Caret inside the tag (after "wea") must not open a header break.
    for (let index = 0; index < 4; index += 1) await press(key("left"));
    const beforeCaret = state.editor!.composer.text;
    await press(key("return", { sequence: "\r" }));
    expect(state.editor!.composer.text).toBe(beforeCaret);
    expect(state.editor!.composer.text).not.toContain("wea\n");
    expect(state.toast).toBe("fact tags stay on one line");
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({ tag: "weather", text: body });

    // Full tag selection (Ctrl+T) must not replace the tag with a newline either.
    await press(key("t", { sequence: "\u0014", ctrl: true }));
    const beforeSelection = state.editor!.composer.text;
    await press(key("return", { sequence: "\r" }));
    expect(state.editor!.composer.text).toBe(beforeSelection);
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({ tag: "weather", text: body });

    // Body Enter still starts a new body line.
    await press(key("end", { ctrl: true }));
    await press(key("return", { sequence: "\r" }));
    expect(state.editor!.composer.text.endsWith(`${body}\n`)).toBeTrue();
    expect(parseFactEditor(state.editor!.composer.text)).toEqual({
      tag: "weather",
      text: `${body}\n`
    });

    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.payload.facts[0]).toMatchObject({ tag: "weather", text: `${body}\n` });
  });

  test("linefeed and Ctrl+J inside a Fact tag stay on one line; body linefeed inserts", async () => {
    const body = "Maren\nKeeps the lantern-house and distrusts old coin.";
    // OpenTUI raw LF and Ctrl+J both arrive as name linefeed + sequence newline.
    const linefeedDeliveries = [
      key("linefeed", { sequence: "\n" }),
      key("j", { sequence: "\n", ctrl: true })
    ] as const;

    for (const delivery of linefeedDeliveries) {
      const { state, press } = editorHarness();
      await press(key("f"));
      await press(key("return"));
      await press(key("t", { sequence: "\u0014", ctrl: true }));
      for (const character of "weather") await press(key(character));

      // Caret inside the tag (after "wea") must not open a header break.
      for (let index = 0; index < 4; index += 1) await press(key("left"));
      const beforeCaret = state.editor!.composer.text;
      await press(delivery);
      expect(state.editor!.composer.text).toBe(beforeCaret);
      expect(state.editor!.composer.text).not.toContain("wea\n");
      expect(state.toast).toBe("fact tags stay on one line");
      expect(parseFactEditor(state.editor!.composer.text)).toEqual({ tag: "weather", text: body });

      // Full tag selection must not replace the tag with a linefeed either.
      await press(key("t", { sequence: "\u0014", ctrl: true }));
      const beforeSelection = state.editor!.composer.text;
      await press(delivery);
      expect(state.editor!.composer.text).toBe(beforeSelection);
      expect(parseFactEditor(state.editor!.composer.text)).toEqual({ tag: "weather", text: body });

      // Body linefeed still starts a new body line.
      await press(key("end", { ctrl: true }));
      await press(delivery);
      expect(state.editor!.composer.text.endsWith(`${body}\n`)).toBeTrue();
      expect(parseFactEditor(state.editor!.composer.text)).toEqual({
        tag: "weather",
        text: `${body}\n`
      });

      await press(key("s", { sequence: "\u0013", ctrl: true }));
      expect(state.payload.facts[0]).toMatchObject({ tag: "weather", text: `${body}\n` });
    }
  });

  test("same-story recovery keeps a dirty fact draft and requires overwrite confirmation", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    openFactEditor(state, fact);
    setComposerText(state.editor!.composer, "tag: Local\nlocal draft");
    const recovered = { ...fact, tag: "Remote", text: "recovered fact" };
    adoptSameStoryPayload(state, {
      ...state.payload,
      facts: state.payload.facts.map((candidate) => candidate.id === fact.id ? recovered : candidate)
    });

    expect(state.editor?.composer.text).toBe("tag: Local\nlocal draft");
    expect(state.editor?.conflict?.armed).toBeFalse();
    expect(state.editor?.target).toMatchObject({ kind: "fact", base: recovered });
    let saves = 0;
    const patchFact = source.api.patchFact;
    source.api.patchFact = async (...args) => { saves += 1; return patchFact(...args); };

    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(saves).toBe(0);
    expect(state.editor?.conflict?.armed).toBeTrue();
    expect(state.payload.facts.find(({ id }) => id === fact.id)).toEqual(recovered);
    expect(state.toast).toContain("ctrl+s again overwrites");
  });

  test("a conflicted fact can overwrite the recovery with its original text", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    openFactEditor(state, fact);
    setComposerText(state.editor!.composer, "tag: Local\nlocal draft");
    const recovered = { ...fact, tag: "Remote", text: "recovered fact" };
    adoptSameStoryPayload(state, {
      ...state.payload,
      facts: state.payload.facts.map((candidate) => candidate.id === fact.id ? recovered : candidate)
    });
    setComposerText(state.editor!.composer, state.editor!.initial);
    let saves = 0;
    const patchFact = source.api.patchFact;
    source.api.patchFact = async (...args) => { saves += 1; return patchFact(...args); };

    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(saves).toBe(0);
    expect(state.editor?.conflict?.armed).toBeTrue();
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(saves).toBe(1);
    expect(state.payload.facts.find(({ id }) => id === fact.id)).toMatchObject({
      tag: fact.tag,
      text: fact.text
    });
  });

  test("a fact deleted during recovery keeps its draft and saves only as new", async () => {
    const { source, state, press } = editorHarness();
    const fact = state.payload.facts[0]!;
    openFactEditor(state, fact);
    const localDraft = "tag: Recovered\nkeep this deleted-fact draft";
    setComposerText(state.editor!.composer, localDraft);
    adoptSameStoryPayload(state, {
      ...state.payload,
      facts: state.payload.facts.filter(({ id }) => id !== fact.id)
    });

    expect(state.editor?.composer.text).toBe(localDraft);
    expect(state.editor?.target).toMatchObject({ kind: "fact", factId: null, base: null });
    expect(state.editor?.conflict).toMatchObject({ resolution: "create", armed: false });
    let creates = 0;
    const createFact = source.api.createFact;
    source.api.createFact = async (...args) => { creates += 1; return createFact(...args); };

    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(creates).toBe(0);
    expect(state.toast).toContain("ctrl+s again creates a new fact");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(creates).toBe(1);
    expect(state.payload.facts.some(({ tag, text }) =>
      tag === "Recovered" && text === "keep this deleted-fact draft")).toBeTrue();
  });
});

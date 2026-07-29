import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleKey, initialState } from "../src/app.js";
import { createComposer, setComposerText } from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { parsePartFile, serializePart } from "../src/editor.js";
import { openFactEditor } from "../src/editor-action.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function key(
  name: string,
  options: { sequence?: string; ctrl?: boolean; shift?: boolean; meta?: boolean } = {}
): KeyEvent {
  return {
    name,
    sequence: options.sequence ?? name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: options.meta ?? false
  } as KeyEvent;
}

function harness() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const press = (event: KeyEvent) => handleKey(
    event, state, source, cache, () => undefined, async () => undefined, () => undefined
  );
  return { source, state, cache, press };
}

describe("inline editor", () => {
  test("round-trips instruction and multiline prose through the edit contract", () => {
    const file = serializePart("make it rain", "First line.\n\nSecond line.");
    expect(file.startsWith("≻")).toBe(true);
    expect(parsePartFile(file)).toEqual({ instruction: "make it rain", text: "First line.\n\nSecond line." });
  });

  test("parses a bare inline part document and keeps later scene breaks", () => {
    expect(parsePartFile("make it rain\n---\nprose")).toEqual({ instruction: "make it rain", text: "prose" });
    expect(parsePartFile("go\n---\nbefore\n---\nafter")).toEqual({
      instruction: "go", text: "before\n---\nafter"
    });
    expect(parsePartFile("---\njust prose")).toEqual({ instruction: "", text: "just prose" });
    expect(parsePartFile("prose only")).toBe(null);
  });

  test("e preserves the original part and saves the edit as a new sibling take", async () => {
    const { state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    const original = structuredClone(state.payload.nodes.find(({ id }) => id === "p12")!);

    await press(key("e"));
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.target.kind).toBe("part");
    expect(state.editor?.composer.text).toContain("\n---\n");
    setComposerText(state.editor!.composer, "new direction\n---\nnew prose");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(state.editor).toBe(null);
    expect(state.payload.nodes.find(({ id }) => id === "p12")).toEqual(original);
    expect(state.payload.path.at(-1)).toMatchObject({
      parentId: original.parentId,
      instruction: "new direction",
      text: "new prose"
    });
    expect(state.payload.path.at(-1)?.id).not.toBe("p12");
    expect(state.toast).toBe("edited take created");
  });

  test("ctrl+o overwrites the focused part in place", async () => {
    const { state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    const originalId = "p12";

    await press(key("e"));
    setComposerText(state.editor!.composer, "rewritten direction\n---\nrewritten prose");
    // Raw control-O (0x0f) is the portable same-take chord on classic terminals.
    await press(key("o", { sequence: "\u000f", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(state.payload.path.find(({ id }) => id === originalId)).toMatchObject({
      instruction: "rewritten direction",
      text: "rewritten prose"
    });
    expect(state.payload.nodes.find(({ id }) => id === originalId)?.preview)
      .toContain("rewritten prose");
    expect(state.toast).toBe("take updated in place");
  });

  test("ctrl+s always forks even after an earlier save in the same session", async () => {
    const { source, state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    const parentId = state.payload.nodes.find(({ id }) => id === "p12")!.parentId;
    const beforeIds = new Set(state.payload.nodes.map(({ id }) => id));
    await press(key("e"));
    setComposerText(state.editor!.composer, "first fork\n---\nfirst prose");

    const originalCreate = source.api.createNode;
    const originalEdit = source.api.editNode;
    let creates = 0;
    let edits = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    source.api.createNode = async (...args) => {
      creates += 1;
      await gate;
      return originalCreate(...args);
    };
    source.api.editNode = async (...args) => {
      edits += 1;
      return originalEdit(...args);
    };

    const saving = press(key("s", { sequence: "\u0013", ctrl: true }));
    await Promise.resolve();
    await press(key("x"));
    release();
    await saving;

    expect(state.mode).toBe("EDITOR");
    expect(state.toast).toBe("edited take created · newer edits kept");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect({ creates, edits }).toEqual({ creates: 2, edits: 0 });
    const forked = state.payload.nodes.filter(({ id, parentId: nodeParentId }) =>
      !beforeIds.has(id) && nodeParentId === parentId);
    expect(forked.length).toBe(2);
  });

  test("demo edited takes preserve earlier human spans and mark only the new edit", async () => {
    const { state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    const source = state.payload.path.find(({ id }) => id === "p12")!;
    const existingHumanText = source.attribution!.ranges.map((range) =>
      source.text.slice(range.start, range.end));
    const changedText = `${source.text} Quietly.`;

    await press(key("e"));
    setComposerText(
      state.editor!.composer,
      serializePart(source.instruction, changedText)
    );
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    const edited = state.payload.path.at(-1)!;
    expect(edited.attribution?.ranges.map((range) =>
      edited.text.slice(range.start, range.end))).toEqual([
      ...existingHumanText,
      "Quietly."
    ]);
  });

  test("opening an editor clears native story selection before its offsets can be reused", async () => {
    const { source, state, cache } = harness();
    let clears = 0;
    await handleKey(
      key("e"), state, source, cache, () => undefined, async () => undefined, () => undefined,
      { clearSelection: () => { clears += 1; } } as never
    );

    expect(state.mode).toBe("EDITOR");
    expect(clears).toBe(1);
    await handleKey(
      key("escape"), state, source, cache, () => undefined, async () => undefined, () => undefined,
      { clearSelection: () => { clears += 1; } } as never
    );
    expect(state.mode).toBe("NAV");
    expect(clears).toBe(2);
  });

  test("w writes a human sibling through the same editor", async () => {
    const { state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");

    await press(key("w"));
    expect(state.editor?.target.kind).toBe("human-take");
    setComposerText(state.editor!.composer, "A human-written turn.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(state.payload.path.some(({ text, human }) => text === "A human-written turn." && human === true)).toBeTrue();
    expect(state.toast).toBe("human take saved");
  });

  test("facts create and edit inline, returning to the facts panel", async () => {
    const { state, press } = harness();
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

  test("chapter summaries edit inline", async () => {
    const { state, press } = harness();
    const view = createStoryViewModel(state.payload);
    state.focusIndex = view.rows.findIndex((row) => row.kind === "chapter-summary");
    const summary = view.rows[state.focusIndex];
    expect(summary?.kind).toBe("chapter-summary");

    await press(key("e"));
    expect(state.editor?.target.kind).toBe("chapter-summary");
    setComposerText(state.editor!.composer, "A tighter human summary.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.nodes.find(({ id }) => id === (summary as { summary: { id: string } }).summary.id)?.text)
      .toBe("A tighter human summary.");
  });

  test("keyboard selection replaces text and Alt+Backspace deletes the previous word", async () => {
    const { state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    setComposerText(state.editor!.composer, "alpha beta\ngamma");

    await press(key("home", { ctrl: true }));
    await press(key("right", { ctrl: true }));
    for (let index = 0; index < 4; index += 1) await press(key("right", { shift: true }));
    await press(key("X", { sequence: "X", shift: true }));
    expect(state.editor?.composer.text).toBe("alpha X\ngamma");
    await press(key("z", { ctrl: true }));
    expect(state.editor?.composer.text).toBe("alpha beta\ngamma");

    await press(key("end", { ctrl: true }));
    await press(key("backspace", { meta: true }));
    expect(state.editor?.composer.text).toBe("alpha beta\n");
  });

  test("same-story recovery keeps a dirty fact draft and requires overwrite confirmation", async () => {
    const { source, state, press } = harness();
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
    const { source, state, press } = harness();
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
    const { source, state, press } = harness();
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

  test("the editor is full-screen, multiline, cancellable, and paste-ready", async () => {
    const { state, press, cache } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    const frame = frameText(renderStoryScreen(state, {
      width: 80, height: 24, wrapCache: cache
    }).lines);
    expect(frame).toContain("edit ¶");
    expect(frame).toContain("ctrl+s new take");
    expect(frame).toContain("ctrl+o same take");
    expect(frame).not.toContain("n continues");

    const original = state.editor!.initial;
    await press(key("return", { sequence: "\r" }));
    expect(state.editor!.composer.text).toBe(`${original}\n`);
    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.editor).toBe(null);
  });

  test("composer model remains independent from the editor draft", async () => {
    const { state, press } = harness();
    state.composer = createComposer("kept direct draft");
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    setComposerText(state.editor!.composer, "changed\n---\nunsaved");
    await press(key("escape", { sequence: "\u001b" }));
    expect(state.composer.text).toBe("kept direct draft");
  });

  test("local editing and cancel stay responsive during unrelated backend work", async () => {
    const { state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    const initial = state.editor!.composer.text;
    state.backendTask = { id: 99, kind: "action", label: "refreshing library", storyId: state.payload.id };

    await press(key("x"));
    expect(state.editor!.composer.text).toBe(`${initial}x`);
    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.editor).toBe(null);
  });

  test("ctrl+o keeps updating the opened part when newer input remains", async () => {
    const { source, state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    const submitted = "saved direction\n---\nsaved prose";
    setComposerText(state.editor!.composer, submitted);

    const originalCreate = source.api.createNode;
    const originalEdit = source.api.editNode;
    let creates = 0;
    let edits = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    source.api.createNode = async (...args) => {
      creates += 1;
      return originalCreate(...args);
    };
    source.api.editNode = async (...args) => {
      edits += 1;
      await gate;
      return originalEdit(...args);
    };
    const saving = press(key("o", { sequence: "\u000f", ctrl: true }));
    await Promise.resolve();
    await press(key("x"));
    release();
    await saving;

    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.initial).toBe(submitted);
    expect(state.editor?.composer.text).toBe(`${submitted}x`);
    expect(state.toast).toBe("take updated in place · newer edits kept");
    await press(key("o", { sequence: "\u000f", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect({ creates, edits }).toEqual({ creates: 0, edits: 2 });
    expect(state.payload.path.find(({ id }) => id === "p12")?.text).toBe("saved prosex");
  });

  test("an in-place save still targets the opened part when another client reroutes", async () => {
    const { source, state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    const savedProse = `${"a".repeat(99)}💡 tail`;
    setComposerText(state.editor!.composer, `   \n---\n${savedProse}`);

    const originalEdit = source.api.editNode;
    let editedId = "";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    source.api.editNode = async (...args) => {
      await gate;
      editedId = args[1].id;
      await originalEdit(...args);
      return source.api.switchLine(args[0], "p5-alt", { stopAtNode: true });
    };

    const saving = press(key("o", { sequence: "\u000f", ctrl: true }));
    await Promise.resolve();
    await press(key("x"));
    release();
    await saving;

    expect(editedId).toBe("p12");
    expect(state.payload.path.at(-1)?.id).toBe("p5-alt");
    expect(state.editor?.target).toMatchObject({
      kind: "part",
      node: { id: "p12", text: savedProse }
    });
    await press(key("o", { sequence: "\u000f", ctrl: true }));
    expect(editedId).toBe("p12");
    // Path no longer includes p12 after the line switch; the second save still
    // mutates the opened take identity held by the editor session.
    const restored = await source.api.switchLine(state.payload.id, "p12", { stopAtNode: true });
    expect(restored.path.find(({ id }) => id === "p12")?.text).toBe(`${savedProse}x`);
  });

  test("a newly created human take becomes an edit when newer input remains", async () => {
    const { source, state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("w"));
    setComposerText(state.editor!.composer, "first save");

    const originalCreate = source.api.createNode;
    const originalEdit = source.api.editNode;
    let creates = 0;
    let edits = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    source.api.createNode = async (...args) => {
      creates += 1;
      await gate;
      return originalCreate(...args);
    };
    source.api.editNode = async (...args) => {
      edits += 1;
      return originalEdit(...args);
    };
    const saving = press(key("s", { sequence: "\u0013", ctrl: true }));
    await Promise.resolve();
    await press(key("x"));
    release();
    await saving;

    expect(state.editor?.target).toMatchObject({ kind: "human-take" });
    expect(state.editor?.composer.text).toBe("first savex");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect({ creates, edits }).toEqual({ creates: 1, edits: 1 });
    expect(state.payload.path.some(({ text, human }) => text === "first savex" && human === true)).toBeTrue();
  });

  test("a settled save does not steal focus after the editor was closed", async () => {
    const { source, state, press } = harness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    const original = structuredClone(state.payload.nodes.find(({ id }) => id === "p12")!);
    await press(key("e"));
    setComposerText(state.editor!.composer, "saved direction\n---\nsaved prose");

    const originalCreate = source.api.createNode;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    source.api.createNode = async (...args) => {
      await gate;
      return originalCreate(...args);
    };
    const saving = press(key("s", { sequence: "\u0013", ctrl: true }));
    await Promise.resolve();
    await press(key("escape", { sequence: "\u001b" }));
    const laterFocus = rowIndexForNode(createStoryViewModel(state.payload), "p5");
    state.focusIndex = laterFocus;
    release();
    await saving;

    expect(state.mode).toBe("NAV");
    expect(createStoryViewModel(state.payload).rows[state.focusIndex]).toMatchObject({ id: "p5" });
    expect(state.payload.nodes.find(({ id }) => id === "p12")).toEqual(original);
    expect(state.payload.path.some(({ id, text }) => id !== "p12" && text === "saved prose")).toBeTrue();
  });
});

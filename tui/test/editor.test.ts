import { describe, expect, test } from "bun:test";
import { handleKey } from "../src/app.js";
import { createComposer, setComposerText } from "../src/composer-model.js";
import { parsePartFile, serializePart } from "../src/editor.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { frameText } from "../src/screens/story/frame.js";
import { openTextActions } from "../src/text-actions.js";
import type { CommandSelectionId } from "../src/command-model.js";
import type { InlineEditorSession, RuntimeState } from "../src/state.js";
import { editorHarness, key } from "./editor-harness.js";

function documentEditor(state: RuntimeState): InlineEditorSession {
  const editor = state.editor;
  if (editor?.kind !== "document") throw new Error("expected a document editor");
  return editor;
}

/** Author Brief has no NAV shortcut; open it the way a writer would, through
 *  the story palette. */
async function openAuthorBriefFromPalette(
  state: RuntimeState,
  press: (event: ReturnType<typeof key>) => Promise<void>
): Promise<void> {
  await press(key("p", { ctrl: true }));
  expect(state.mode).toBe("COMMANDS");
  state.commands = {
    query: "author brief",
    cursor: 0,
    selectedId: "author-brief",
    view: "commands",
    returnMode: state.commands?.returnMode ?? "NAV"
  };
  await press(key("return"));
}

/** Same story-palette route as Author Brief (issue #341) — neither the
 *  story's own phrase bias nor its banned strings has a NAV shortcut. */
async function openStoryScalarFromPalette(
  state: RuntimeState,
  press: (event: ReturnType<typeof key>) => Promise<void>,
  query: string,
  selectedId: CommandSelectionId
): Promise<void> {
  await press(key("p", { ctrl: true }));
  expect(state.mode).toBe("COMMANDS");
  state.commands = {
    query,
    cursor: 0,
    selectedId,
    view: "commands",
    returnMode: state.commands?.returnMode ?? "NAV"
  };
  await press(key("return"));
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
    const { state, press } = editorHarness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    const original = structuredClone(state.payload.nodes.find(({ id }) => id === "p12")!);

    await press(key("e"));
    expect(state.mode).toBe("EDITOR");
    expect(documentEditor(state).target.kind).toBe("part");
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
    const { state, press } = editorHarness();
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

  test("saving an unchanged editor closes silently without a story mutation", async () => {
    const { source, state, press } = editorHarness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    source.api.createNode = async () => {
      throw new Error("unchanged editor must not create a take");
    };
    source.api.editNode = async () => {
      throw new Error("unchanged editor must not update a take");
    };

    await press(key("e"));
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(state.editor).toBe(null);
    expect(state.toast).toBe(null);
  });

  test("ctrl+s always forks even after an earlier save in the same session", async () => {
    const { source, state, press } = editorHarness();
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

  test("an asynchronous save closes its editor action menu with the editor", async () => {
    const { source, state, press } = editorHarness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
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
    openTextActions(state);
    expect(state.textActions).not.toBe(null);
    release();
    await saving;

    expect(state.mode).toBe("NAV");
    expect(state.editor).toBe(null);
    expect(state.textActions).toBe(null);
  });

  test("demo edited takes preserve earlier human spans and mark only the new edit", async () => {
    const { state, press } = editorHarness();
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
    const { source, state, cache } = editorHarness();
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
    const { state, press } = editorHarness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");

    await press(key("w"));
    expect(documentEditor(state).target.kind).toBe("human-take");
    setComposerText(state.editor!.composer, "A human-written turn.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(state.payload.path.some(({ text, human }) => text === "A human-written turn." && human === true)).toBeTrue();
    expect(state.toast).toBe("human take saved");
  });

  test("chapter summaries edit inline", async () => {
    const { state, press } = editorHarness();
    const view = createStoryViewModel(state.payload);
    state.focusIndex = view.rows.findIndex((row) => row.kind === "chapter-summary");
    const summary = view.rows[state.focusIndex];
    expect(summary?.kind).toBe("chapter-summary");

    await press(key("e"));
    expect(documentEditor(state).target.kind).toBe("chapter-summary");
    setComposerText(state.editor!.composer, "A tighter human summary.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.nodes.find(({ id }) => id === (summary as { summary: { id: string } }).summary.id)?.text)
      .toBe("A tighter human summary.");
  });

  test("n opens the Author's Note editor, saves, clears, and reports save errors", async () => {
    const { source, state, press } = editorHarness();

    await press(key("n"));
    expect(documentEditor(state).target.kind).toBe("authors-note");
    setComposerText(state.editor!.composer, "Sparse prose. Keep the lantern unanswered.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(state.payload.authorsNote).toBe("Sparse prose. Keep the lantern unanswered.");
    expect(state.toast).toBe("Author's Note saved");

    await press(key("n"));
    setComposerText(state.editor!.composer, " \n\t ");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.authorsNote).toBe(undefined);
    expect(state.toast).toBe("Author's Note cleared");

    source.api.setAuthorsNote = async () => { throw new Error("note endpoint unavailable"); };
    await press(key("n"));
    setComposerText(state.editor!.composer, "Keep this draft.");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.composer.text).toBe("Keep this draft.");
    expect(state.toast).toBe("note endpoint unavailable");
  });

  test("Author's Note depth steps with the alt-minus/equals chord, is bounded, and saves with the note", async () => {
    const { source, state, press } = editorHarness();

    await press(key("n"));
    const target = documentEditor(state).target as { kind: "authors-note"; depth: number };
    expect(target.depth).toBe(1);

    await press(key("-", { meta: true }));
    expect(target.depth).toBe(1);
    expect(state.editor?.composer.text).toBe("");

    await press(key("=", { meta: true }));
    await press(key("=", { meta: true }));
    expect(target.depth).toBe(3);

    for (let step = 0; step < 12; step += 1) await press(key("=", { meta: true }));
    expect(target.depth).toBe(10);

    await press(key("-", { meta: true }));
    expect(target.depth).toBe(9);

    let receivedDepth: number | undefined;
    const forward = source.api.setAuthorsNote.bind(source.api);
    source.api.setAuthorsNote = async (storyId, note, depth) => {
      receivedDepth = depth;
      return await forward(storyId, note, depth);
    };
    setComposerText(state.editor!.composer, "Keep the storm distant.");
    await press(key("s", { sequence: "", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(receivedDepth).toBe(9);
    expect(state.payload.authorsNote).toBe("Keep the storm distant.");
    expect(state.payload.authorsNoteDepth).toBe(9);
    expect(state.toast).toBe("Author's Note saved");
  });

  test("a recovered Author's Note depth requires confirmation before the draft overwrites it", async () => {
    const { source, state, press } = editorHarness();
    state.payload.authorsNote = "Keep the storm distant.";
    await press(key("n"));
    const target = documentEditor(state).target as {
      kind: "authors-note";
      depth: number;
      expectedDepth: number;
    };

    // The writer moves the depth, and recovery brings back a different one.
    // The note text still matches, so only the depth disagrees.
    await press(key("=", { meta: true }));
    expect(target.depth).toBe(2);
    adoptSameStoryPayload(state, { ...state.payload, authorsNoteDepth: 7 }, createWrapCache<ProseStyle>());

    expect(target.depth).toBe(2);
    expect(target.expectedDepth).toBe(7);
    expect(documentEditor(state).conflict === null).toBe(false);

    let saves = 0;
    const forward = source.api.setAuthorsNote.bind(source.api);
    source.api.setAuthorsNote = async (storyId, note, depth) => {
      saves += 1;
      return await forward(storyId, note, depth);
    };

    await press(key("s", { sequence: "", ctrl: true }));

    expect(saves).toBe(0);
    expect(documentEditor(state).conflict?.armed).toBeTrue();
  });

  test("a depth change alone still saves, even when the note text is untouched", async () => {
    const { source, state, press } = editorHarness();
    await press(key("n"));
    setComposerText(state.editor!.composer, "Sparse prose.");
    await press(key("s", { sequence: "", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.authorsNoteDepth).toBe(undefined);

    await press(key("n"));
    expect(state.editor?.composer.text).toBe("Sparse prose.");
    await press(key("=", { meta: true }));
    let receivedDepth: number | undefined;
    const forward = source.api.setAuthorsNote.bind(source.api);
    source.api.setAuthorsNote = async (storyId, note, depth) => {
      receivedDepth = depth;
      return await forward(storyId, note, depth);
    };
    await press(key("s", { sequence: "", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(receivedDepth).toBe(2);
    expect(state.payload.authorsNote).toBe("Sparse prose.");
    expect(state.payload.authorsNoteDepth).toBe(2);
  });

  test("author brief opens from the story palette, saves, clears, and reports save errors", async () => {
    const { source, state, press } = editorHarness();

    await openAuthorBriefFromPalette(state, press);
    expect(documentEditor(state).target).toMatchObject({ kind: "story-scalar", field: "author-brief" });
    setComposerText(state.editor!.composer, "Write in short, clipped sentences.");
    await press(key("s", { sequence: "", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(state.payload.authorBrief).toBe("Write in short, clipped sentences.");
    expect(state.toast).toBe("Author Brief saved");

    await openAuthorBriefFromPalette(state, press);
    setComposerText(state.editor!.composer, " \n\t ");
    await press(key("s", { sequence: "", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.authorBrief).toBe(undefined);
    expect(state.toast).toBe("Author Brief cleared");

    source.api.setAuthorBrief = async () => { throw new Error("brief endpoint unavailable"); };
    await openAuthorBriefFromPalette(state, press);
    setComposerText(state.editor!.composer, "Keep this draft.");
    await press(key("s", { sequence: "", ctrl: true }));
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.composer.text).toBe("Keep this draft.");
    expect(state.toast).toBe("brief endpoint unavailable");
  });

  test("phrase bias opens from the story palette, saves, clears, rejects a bad line, and reports save errors", async () => {
    const { source, state, press } = editorHarness();

    await openStoryScalarFromPalette(state, press, "phrase bias", "phrase-bias");
    expect(documentEditor(state).target).toMatchObject({ kind: "story-scalar", field: "phrase-bias" });
    setComposerText(state.editor!.composer, "delve: -8\ntapestry: -12");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(state.payload.phraseBias).toEqual([
      { phrase: "delve", weight: -8 },
      { phrase: "tapestry", weight: -12 }
    ]);
    expect(state.toast).toBe("phrase bias saved");

    await openStoryScalarFromPalette(state, press, "phrase bias", "phrase-bias");
    expect(state.editor?.composer.text).toBe("delve: -8\ntapestry: -12");
    setComposerText(state.editor!.composer, "not a valid line");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("EDITOR");
    expect(state.payload.phraseBias).toEqual([
      { phrase: "delve", weight: -8 },
      { phrase: "tapestry", weight: -12 }
    ]);
    expect(state.toast).toContain("phrase: weight");

    setComposerText(state.editor!.composer, "");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.phraseBias).toBe(undefined);
    expect(state.toast).toBe("phrase bias cleared");

    source.api.setPhraseBias = async () => { throw new Error("phrase bias endpoint unavailable"); };
    await openStoryScalarFromPalette(state, press, "phrase bias", "phrase-bias");
    setComposerText(state.editor!.composer, "delve: -8");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.composer.text).toBe("delve: -8");
    expect(state.toast).toBe("phrase bias endpoint unavailable");
  });

  test("banned strings opens from the story palette, saves, and clears", async () => {
    const { state, press } = editorHarness();

    await openStoryScalarFromPalette(state, press, "banned strings", "banned-strings");
    expect(documentEditor(state).target).toMatchObject({ kind: "story-scalar", field: "banned-strings" });
    setComposerText(state.editor!.composer, "moreover\nin conclusion");
    await press(key("s", { sequence: "\u0013", ctrl: true }));

    expect(state.mode).toBe("NAV");
    expect(state.payload.bannedStrings).toEqual(["moreover", "in conclusion"]);
    expect(state.toast).toBe("banned strings saved");

    await openStoryScalarFromPalette(state, press, "banned strings", "banned-strings");
    expect(state.editor?.composer.text).toBe("moreover\nin conclusion");
    setComposerText(state.editor!.composer, "");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.bannedStrings).toBe(undefined);
    expect(state.toast).toBe("banned strings cleared");
  });

  test("Author's Note enforces the scalar limit on save and paints its status", async () => {
    const { source, state, cache, press } = editorHarness();
    await press(key("n"));
    setComposerText(state.editor!.composer, "x".repeat(1_200));
    const thresholdFrame = frameText(renderStoryScreen(state, {
      width: 120, height: 24, wrapCache: cache
    }).lines);
    expect(thresholdFrame).not.toContain("tokens");

    setComposerText(state.editor!.composer, "x".repeat(1_204));
    const warningFrame = frameText(renderStoryScreen(state, {
      width: 120, height: 24, wrapCache: cache
    }).lines);
    expect(warningFrame).toContain("· 301 tokens");
    const warningLine = renderStoryScreen(state, {
      width: 120, height: 24, wrapCache: cache
    }).lines.find((line) => line.some((part) => part.role === "context warning"));
    expect(warningLine).toBeDefined();

    let saves = 0;
    source.api.setAuthorsNote = async () => {
      saves += 1;
      throw new Error("must not reach the server");
    };
    setComposerText(state.editor!.composer, "🙂".repeat(4_001));
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(saves).toBe(0);
    expect(state.mode).toBe("EDITOR");
    expect(state.toast).toBe("Author's Note must contain at most 4,000 Unicode scalar values.");
    const limitFrame = renderStoryScreen(state, {
      width: 120, height: 24, wrapCache: cache
    });
    expect(limitFrame.lines.flat().some((part) => part.role === "danger text")).toBeTrue();
  });

  test("keyboard selection replaces text and Alt+Backspace deletes the previous word", async () => {
    const { state, press } = editorHarness();
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

  test("the editor is full-screen, multiline, cancellable, and paste-ready", async () => {
    const { state, press, cache } = editorHarness();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    const frame = frameText(renderStoryScreen(state, {
      width: 80, height: 24, wrapCache: cache
    }).lines);
    expect(frame).toContain("edit ¶");
    expect(frame).toContain("ctrl+s new take");
    expect(frame).toContain("ctrl+o same take");
    expect(frame).not.toContain("n continues");

    const editor = state.editor;
    if (editor?.kind !== "document") throw new Error("expected a document editor");
    const original = editor.initial;
    await press(key("return", { sequence: "\r" }));
    expect(state.editor!.composer.text).toBe(`${original}\n`);
    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.editor).toBe(null);
  });

  test("composer model remains independent from the editor draft", async () => {
    const { state, press } = editorHarness();
    state.composer = createComposer("kept direct draft");
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press(key("e"));
    setComposerText(state.editor!.composer, "changed\n---\nunsaved");
    await press(key("escape", { sequence: "\u001b" }));
    expect(state.composer.text).toBe("kept direct draft");
  });

  test("local editing and cancel stay responsive during unrelated backend work", async () => {
    const { state, press } = editorHarness();
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
    const { source, state, press } = editorHarness();
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
    expect(state.editor?.kind).toBe("document");
    expect(state.editor?.kind === "document" ? state.editor.initial : null)
      .toBe(submitted);
    expect(state.editor?.composer.text).toBe(`${submitted}x`);
    expect(state.toast).toBe("take updated in place · newer edits kept");
    await press(key("o", { sequence: "\u000f", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect({ creates, edits }).toEqual({ creates: 0, edits: 2 });
    expect(state.payload.path.find(({ id }) => id === "p12")?.text).toBe("saved prosex");
  });

  test("an in-place save still targets the opened part when another client reroutes", async () => {
    const { source, state, press } = editorHarness();
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
    expect(documentEditor(state).target).toMatchObject({
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
    const { source, state, press } = editorHarness();
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

    expect(documentEditor(state).target).toMatchObject({ kind: "human-take" });
    expect(state.editor?.composer.text).toBe("first savex");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect({ creates, edits }).toEqual({ creates: 1, edits: 1 });
    expect(state.payload.path.some(({ text, human }) => text === "first savex" && human === true)).toBeTrue();
  });

  test("a settled save does not steal focus after the editor was closed", async () => {
    const { source, state, press } = editorHarness();
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

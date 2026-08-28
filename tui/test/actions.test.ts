import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { dispatch, handleKey, initialState, type AppSource } from "../src/app.js";
import { setComposerText } from "../src/composer-model.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { adoptReconciliationSnapshot } from "../src/story-adoption.js";
import { currentPartActions, openActions, restorePendingGenerationDraft } from "../src/story-actions.js";
import { createWrapCache } from "../src/wrap.js";
import { openRetakeComposer, suspendRetakeComposer } from "../src/composer-ownership.js";
import type { PendingGenerationDraft } from "../src/state.js";

const key = (name: string, sequence = name): KeyEvent => ({ name, sequence, shift: false, ctrl: false, meta: false }) as KeyEvent;
const STREAM_STARTED_AT = "2026-07-22T00:00:00.000Z";
const modifiedKey = (name: string, options: { sequence?: string; shift?: boolean; ctrl?: boolean }): KeyEvent => ({
  name, sequence: options.sequence ?? name, shift: options.shift ?? false, ctrl: options.ctrl ?? false, meta: false
}) as KeyEvent;

function harness() {
  const source: AppSource = demoAppSource();
  const state = initialState(source, false);
  const press = (name: string, sequence = name) => handleKey(
    key(name, sequence), state, source, createWrapCache(), () => {}, async () => {}, () => {}
  );
  const pressKey = (event: KeyEvent) => handleKey(
    event, state, source, createWrapCache(), () => {}, async () => {}, () => {}
  );
  return { source, state, press, pressKey };
}

function focusNode(state: ReturnType<typeof harness>["state"], nodeId: string): number {
  const index = rowIndexForNode(createStoryViewModel(state.payload), nodeId);
  state.focusIndex = index;
  return index;
}

describe("demo action pipeline", () => {
  test("map path sibling reroute mutates the active in-memory line", async () => {
    const { state, press } = harness();
    await press("m");
    await press("right");
    expect(state.map?.pathCursorId).toBe("p12-t4");
    await press("return", "\r");
    expect(state.mode).toBe("NAV");
    expect(state.map).toBe(null);
    expect(state.payload.path[11]?.id).toBe("p12-t4");
    expect(state.focusIndex).toBe(rowIndexForNode(createStoryViewModel(state.payload), "p12-t4"));
  });

  test("one map cycles path → tree → mass → path and Escape returns to NAV", async () => {
    const { state, press } = harness();
    await press("m");
    expect(state.mode).toBe("MAP");
    expect(state.map?.view).toBe("path");
    expect(state.map?.showSketches).toBeTrue();
    await press("m");
    expect(state.map?.view).toBe("tree");
    await press("a");
    expect(state.map?.showSketches).toBeFalse();
    await press("m");
    expect(state.map?.view).toBe("mass");
    await press("m");
    expect(state.map?.view).toBe("path");
    await press("escape");
    expect(state.mode).toBe("NAV");
    expect(state.map).toBe(null);
  });

  test("path defaults to all revealed takes and toggles to branches only", async () => {
    const { state, press } = harness();
    await press("m");
    const frame = () => frameText(renderStoryScreen(
      state, { width: 120, height: 36, wrapCache: createWrapCache() }
    ).lines);
    expect(state.map?.showSketches).toBeTrue();
    expect(frame()).not.toContain("sketches folded");
    expect(frame()).toContain("take 3/5");
    expect(frame()).toContain("path/all");
    expect(frame()).toContain("a branches");
    await press("a");
    expect(state.map?.pathShowAllTakes).toBeFalse();
    expect(frame()).toContain("path/branches");
    expect(frame()).toContain("a all");
    expect(frame()).not.toContain("take 3/5");
    await press("a");
    expect(state.map?.pathShowAllTakes).toBeTrue();
    expect(frame()).toContain("take 3/5");
  });

  test("the 80-column tree keeps its branches and the active terminus without windowing", async () => {
    const { state, press } = harness();
    await press("m");
    await press("m");
    const frame = frameText(renderStoryScreen(state, { width: 80, height: 24, wrapCache: createWrapCache() }).lines);
    expect(frame).toContain("◉");
    expect(frame).toContain("¶13");
    // Doc "10a": the whole tree draws as lanes now, a fixed rail per live line.
    expect(frame).toContain("│");
    expect(frame).toContain("├─╮");
  });

  test("leaving the lane tree onto a revealed sketch keeps it visible in path view (bug: openRowInPath)", async () => {
    // Path view hides a sketch entirely in its default branches-only mode, so
    // handing it the cursor without widening to all takes would resolve to a
    // different node the moment path view lays itself out.
    for (const followKey of ["tab", "l"] as const) {
      const { state, press } = harness();
      await press("m");
      await press("m");
      expect(state.map?.showSketches).toBeTrue();
      state.map!.pathShowAllTakes = false;
      state.map!.treeCursorId = "p12-t1";
      await press(followKey);
      expect(state.map?.view).toBe("path");
      expect(state.map?.pathCursorId).toBe("p12-t1");
      expect(state.map?.pathShowAllTakes).toBeTrue();
    }
  });

  test("tab on a cold fold opens path view there too, not wherever the cursor was left stale (bug: map-hide-lanes on cold)", async () => {
    const { state, press } = harness();
    await press("m");
    await press("m");
    state.map!.treeCursorId = "p5-alt";
    await press("tab");
    expect(state.map?.view).toBe("path");
    expect(state.map?.pathCursorId).toBe("p5-alt");
  });

  test("the page take strip rings an alternate that branches, never the take you are reading", async () => {
    // The shipped demo happens to branch only on the take being read, so give
    // one alternate a continuation of its own — that is what wears the ring.
    const demo = createDemoController();
    const payload = demo.createChild("p3-alt", "carry on", "The alternate keeps writing.");
    const { state } = harness();
    state.payload = payload;
    const model = createStoryViewModel(payload);
    const part = model.parts.find((item) => item.id === "p3-alt")!;
    expect(part).toMatchObject({ takeIndex: 2, siblingCount: 2 });
    expect(part.takeSubtakes).toEqual([true, true]);

    state.focusIndex = rowIndexForNode(model, "p3-alt");
    const frame = frameText(renderStoryScreen(state, { width: 120, height: 36, wrapCache: createWrapCache() }).lines);
    // `p3` branches but is the alternate, so it rings; the take being read
    // branches too and stays plain, because its subtakes are the page below it.
    expect(frame).toContain("◎ ●");
    expect(frame).not.toContain("◉");
  });

  test("map view cycling preserves the path cursor", async () => {
    const { state, press } = harness();
    await press("m");
    await press("right");
    const pathCursor = state.map?.pathCursorId;
    expect(pathCursor).not.toBe(null);
    await press("m");
    await press("m");
    await press("m");
    expect(state.map?.view).toBe("path");
    expect(state.map?.pathCursorId).toBe(pathCursor);
  });

  test("mass sort cycles size, recency, depth, name and resets on next open", async () => {
    const { state, press } = harness();
    await press("m");
    await press("m");
    await press("m");
    expect(state.map?.view).toBe("mass");
    expect(state.map?.massSort).toBe("size");
    for (const sort of ["recency", "depth", "name", "size"] as const) {
      await press("s");
      expect(state.map?.massSort).toBe(sort);
    }
    await press("escape");
    await press("m");
    expect(state.map?.view).toBe("path");
    expect(state.map?.massSort).toBe("size");
  });

  test("l on a tree branch stub opens that line in the path view", async () => {
    const { state, press } = harness();
    await press("m");
    await press("m");
    // alt-quiet-inn is a collapsed alternate line hanging off the trunk.
    state.map!.treeCursorId = "p11-alt";
    await press("l");
    expect(state.map?.view).toBe("path");
    expect(state.map?.pathCursorId).toBe("p11-alt");
    // Opening looks, it does not reroute: the reading line is unchanged.
    expect(state.payload.path.at(-1)?.id).toBe("p13");
  });

  test("arrows reach a cold fold, Enter leaves it closed, and l opens it", async () => {
    const { state, press } = harness();
    await press("m");
    await press("m");
    // The cursor opens on the reading line at the foot of the trunk; the cold
    // fold sits above it among the branch stubs, reachable by walking up.
    let guard = 0;
    while (state.map?.treeCursorId !== "p5-alt" && guard < 20) { await press("up"); guard += 1; }
    expect(state.map?.treeCursorId).toBe("p5-alt");
    await press("return", "\r");
    expect(state.map?.openedColdFolds.has("p5-alt")).toBeFalse();
    expect(state.map?.treeCursorId).toBe("p5-alt");
    await press("l");
    expect(state.map?.openedColdFolds.has("p5-alt")).toBeTrue();
  });

  test("a second click action unfolds the selected cold map row", async () => {
    const { source, state, press } = harness();
    await press("m");
    await press("m");
    state.map!.treeCursorId = "p5-alt";

    await dispatch(
      { action: "open-selected" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );
    expect(state.map?.openedColdFolds.has("p5-alt")).toBeTrue();
  });

  test("map entry maps decorated story rows back to their prose path index", async () => {
    const { state, press } = harness();
    focusNode(state, "p8");
    expect(state.focusIndex).toBeGreaterThan(state.payload.path.findIndex((node) => node.id === "p8"));
    await press("m");
    expect(state.map?.pathCursorId).toBe("p8");
    await press("escape");
    expect(state.mode).toBe("NAV");
    expect(state.map).toBe(null);
  });

  test("map entry and depth navigation include an in-flight direct take", async () => {
    const { state, press } = harness();
    const targetId = "stream-map-action";
    state.stream = {
      targetId,
      parentId: "p7",
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "Take the flooded road.",
      text: "The map should already know this road.",
      partNumber: 8
    };
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload, state.stream), targetId);
    expect(state.focusIndex).toBeGreaterThan(-1);

    await press("m");
    expect(state.map).toMatchObject({ pathCursorId: targetId, treeCursorId: targetId });
    await press("up");
    expect(state.map?.pathCursorId).toBe("p7");
    await press("down");
    expect(state.map?.pathCursorId).toBe(targetId);
  });

  test("tree Enter reuses reroute and preserves remembered continuations", async () => {
    const { state, press } = harness();
    await press("m");
    await press("m");
    state.map!.treeCursorId = "p11-alt";
    await press("return", "\r");
    expect(state.payload.path.at(-1)?.id).toBe("p11-alt");
    await press("m");
    await press("m");
    state.map!.treeCursorId = "p13";
    await press("return", "\r");
    expect(state.payload.path.at(-1)?.id).toBe("p13");
    expect(state.payload.nodes.find((node) => node.id === "p12")?.activeChildId).toBe("p13");
  });

  test("mass Enter reuses reroute and preserves remembered continuations", async () => {
    const { state, press } = harness();
    await press("m");
    await press("m");
    await press("m");
    await press("down");
    await press("return", "\r");
    expect(state.payload.path.at(-1)?.id).toBe("p11-alt");
    await press("m");
    await press("m");
    await press("m");
    await press("up");
    await press("return", "\r");
    expect(state.payload.path.at(-1)?.id).toBe("p13");
    expect(state.payload.nodes.find((node) => node.id === "p12")?.activeChildId).toBe("p13");
  });

  test("map Enter cannot reroute while a stream is in flight", async () => {
    const { state, press } = harness();
    await press("m");
    await press("m");
    await press("down");
    const leafId = state.payload.path.at(-1)?.id;
    state.stream = { targetId: "p13", parentId: "p12", append: true,
      startedAt: STREAM_STARTED_AT, instruction: "", text: "" };
    await press("return", "\r");
    expect(state.mode).toBe("MAP");
    expect(state.payload.path.at(-1)?.id).toBe(leafId);
    expect(state.toast).toBe("stream running · esc stops it first");
    expect(frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache()
    }).lines)).toContain(state.toast);
  });

  test("double D prunes with the armed expected count", async () => {
    const { state, press } = harness();
    await press("D", "D");
    expect(state.prune?.parts).toBe(2);
    await press("D", "D");
    expect(state.prune).toBe(null);
    expect(state.payload.nodes.some((node) => node.id === "p12" || node.id === "p13")).toBe(false);
  });

  test("capital D terminal encodings confirm before mutating tag, fact, or chapter owners", async () => {
    const shiftedD = modifiedKey("d", { sequence: "D", shift: true });

    const tag = harness();
    focusNode(tag.state, "p13");
    await tag.press("t");
    await tag.press("return", "\r");
    expect(tag.state.tag).toMatchObject({ existing: true, choosingStatus: true });
    await tag.press("d");
    expect(tag.state.payload.tags.some(({ nodeId }) => nodeId === "p13")).toBeTrue();
    await tag.pressKey(shiftedD);
    expect(tag.state.tag).not.toBe(null);
    await tag.pressKey(shiftedD);
    expect(tag.state.payload.tags.some(({ nodeId }) => nodeId === "p13")).toBeFalse();

    const fact = harness();
    const factId = fact.state.payload.facts[0]!.id;
    fact.state.mode = "FACTS";
    fact.state.facts = {
      cursor: 0, query: "", chip: 0, selectedTag: null,
      filtering: false, deleteArmedId: null
    };
    await fact.pressKey(shiftedD);
    expect(fact.state.payload.facts.some(({ id }) => id === factId)).toBeTrue();
    expect(fact.state.facts?.deleteArmedId).toBe(factId);
    await fact.pressKey(shiftedD);
    expect(fact.state.payload.facts.some(({ id }) => id === factId)).toBeFalse();

    const chapter = harness();
    focusNode(chapter.state, "p13");
    await chapter.press("c");
    await chapter.pressKey(shiftedD);
    expect(chapter.state.payload.chapterBreaks.some(({ id }) => id === "chapter-break-2")).toBeTrue();
    expect(chapter.state.chapters?.deleteArmedId).toBe("chapter-break-2");
    await chapter.pressKey(shiftedD);
    expect(chapter.state.payload.chapterBreaks.some(({ id }) => id === "chapter-break-2")).toBeFalse();
  });

  test("shift+up/down reorders the focused Fact in the unfiltered list only", async () => {
    const shiftedArrow = (name: "up" | "down") => modifiedKey(name, { shift: true });
    const { state, press, pressKey } = harness();
    await press("f");
    expect(state.mode).toBe("FACTS");
    const idsInOrder = () => state.payload.facts.map((fact) => fact.id);
    const original = idsInOrder();
    expect(original[0]).toBe("fact-1");

    // Moving the focused (first) Fact down swaps it with its neighbor; the
    // cursor follows it so a repeated move keeps walking the same Fact.
    await pressKey(shiftedArrow("down"));
    expect(idsInOrder()).toEqual([original[1], original[0], ...original.slice(2)]);
    expect(state.facts?.cursor).toBe(1);

    await pressKey(shiftedArrow("up"));
    expect(idsInOrder()).toEqual(original);
    expect(state.facts?.cursor).toBe(0);

    // Moving the topmost Fact up, or the bottommost down, is a no-op rather
    // than an error — there is nowhere further to go.
    await pressKey(shiftedArrow("up"));
    expect(idsInOrder()).toEqual(original);

    // A tag filter narrows the visual list; array order underneath is no
    // longer what "up" or "down" would mean, so the move key is inert and
    // explains why instead of reordering something unexpected.
    state.facts!.selectedTag = "people";
    await pressKey(shiftedArrow("down"));
    expect(idsInOrder()).toEqual(original);
    expect(state.toast).toBe("clear the tag and filter to reorder facts");
  });

  test("palette cleanup previews then prunes every unused leaf take", async () => {
    const { state, press } = harness();
    await press(":", ":");
    for (const character of "prune") await press(character, character);
    await press("return", "\r");
    expect(state.prune).toMatchObject({ kind: "unused-takes", takes: 5, parts: 5 });
    const activeLine = state.payload.path.map((node) => node.id);
    await press("D", "D");
    expect(state.prune).toBe(null);
    expect(state.toast).toBe("pruned 5 unused takes · 5 parts");
    expect(state.payload.path.map((node) => node.id)).toEqual(activeLine);
    expect(state.payload.nodes.some((node) => ["p12-t1", "p12-t2", "p12-t4", "p8-alt-1", "p8-alt-2"].includes(node.id))).toBeFalse();
  });

  test("tag prompt can save and delete a map path leaf", async () => {
    const { state, press } = harness();
    await press("m");
    await press("right");
    await press("t");
    for (const character of "new-line") await press(character, character);
    await press("return", "\r");
    await press("right");
    await press("right");
    await press("right");
    await press("return", "\r");
    expect(state.payload.tags.find((tag) => tag.nodeId === "p12-t4")).toMatchObject({ name: "new-line", status: "Draft" });
    expect(state.toast).toBe("~ new-line saved");
    await press("t");
    await press("return", "\r");
    await press("D", "D");
    expect(state.payload.tags.some((tag) => tag.nodeId === "p12-t4")).toBe(true);
    await press("D", "D");
    expect(state.payload.tags.some((tag) => tag.nodeId === "p12-t4")).toBe(false);
  });

  test("escape closes an overlay without cancelling a visible stream", async () => {
    const { state, press } = harness();
    state.stream = { targetId: "p13", parentId: "p12", append: true,
      startedAt: STREAM_STARTED_AT, instruction: "", text: "" };
    await press("m");
    await press("escape");
    expect(state.mode).toBe("NAV");
    expect(state.stream?.targetId).toBe("p13");
  });

  test("composer inserts at its cursor, adds lines, and peels fullscreen before closing", async () => {
    const { state, press, pressKey } = harness();
    await press("return", "\r");
    for (const character of "ac") await press(character, character);
    await press("left");
    await press("b", "b");
    expect(state.composer).toMatchObject({ text: "abc", cursor: 2, fullscreen: false });
    await press("right");
    await pressKey(modifiedKey("return", { shift: true }));
    await press("d", "d");
    expect(state.composer.text).toBe("abc\nd");
    await pressKey(modifiedKey("f", { ctrl: true }));
    expect(state.composer.fullscreen).toBeTrue();
    await press("escape");
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.fullscreen).toBeFalse();
    await press("escape");
    expect(state.mode).toBe("NAV");
    expect(state.composer.text).toBe("abc\nd");
  });

  test("plain up recalls history only from an empty single line; Ctrl+up is explicit history", async () => {
    const { state, press, pressKey } = harness();
    state.history = ["first direction", "second direction"];
    state.historyIndex = state.history.length;
    await press("return", "\r");
    await pressKey(modifiedKey("up", { shift: true }));
    await pressKey(modifiedKey("down", { shift: true }));
    expect(state.composer.text).toBe("");
    expect(state.historyIndex).toBe(2);
    await press("up");
    expect(state.composer.text).toBe("second direction");
    await press("up");
    expect(state.composer.text).toBe("second direction");
    await pressKey(modifiedKey("up", { ctrl: true }));
    expect(state.composer.text).toBe("first direction");
  });

  test("history recall restores the unsent draft at its live boundary", async () => {
    const { state, press, pressKey } = harness();
    state.history = ["first direction", "second direction"];
    state.historyIndex = state.history.length;
    await press("return", "\r");
    for (const character of "unfinished direction") await press(character, character);

    await pressKey(modifiedKey("up", { ctrl: true }));
    expect(state.composer.text).toBe("second direction");
    await pressKey(modifiedKey("down", { ctrl: true }));
    expect(state.composer.text).toBe("unfinished direction");
  });

  test("history navigation with no entries leaves the unsent draft alone", async () => {
    const { state, press, pressKey } = harness();
    await press("return", "\r");
    for (const character of "only draft") await press(character, character);

    await pressKey(modifiedKey("up", { ctrl: true }));
    expect(state.composer.text).toBe("only draft");
    await pressKey(modifiedKey("down", { ctrl: true }));
    expect(state.composer.text).toBe("only draft");
  });

  test("deleting the last story adopts a fresh one instead of dangling", async () => {
    const source = demoAppSource();
    const fresh = { ...source.payload, id: "fresh-story", path: [], nodes: [], tags: [], facts: [] };
    let created = false;
    source.api = {
      ...source.api,
      deleteStory: async () => ({ ok: true }),
      listStories: async () => [],
      createStory: async () => { created = true; return fresh; }
    };
    const state = initialState(source, false);
    const open = state.payload.id;
    state.mode = "LIBRARY";
    state.library = {
      stories: [{ id: open, title: state.payload.title, updatedAt: "", partCount: 1, words: 1, forked: false, lineCount: 1 }],
      cursor: 0,
      query: "",
      prompt: { kind: "delete", value: state.payload.title, targetId: open }
    };
    await handleKey(key("return", "\r"), state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(created).toBeTrue();
    expect(state.payload.id).toBe("fresh-story");
    expect(state.mode).toBe("NAV");
  });

  test("creating a zero-part story opens its writing choices", async () => {
    const source = demoAppSource();
    const fresh = {
      ...source.payload,
      id: "fresh-story",
      path: [],
      nodes: [],
      activeRootId: null,
      tags: [],
      recentNodeIds: [],
      facts: [],
      chapterBreaks: []
    };
    source.api = {
      ...source.api,
      createStory: async () => fresh,
      listStories: async () => [{
        id: fresh.id, title: fresh.title, updatedAt: fresh.updatedAt,
        partCount: 0, words: 0, forked: false, lineCount: 0
      }]
    };
    const state = initialState(source, false);
    state.mode = "LIBRARY";
    state.library = { stories: source.stories, cursor: 0, query: "", prompt: null };
    let repaints = 0;

    await handleKey(key("n"), state, source, createWrapCache(), () => { repaints += 1; }, async () => {}, () => {});

    expect(state.payload.id).toBe(fresh.id);
    expect(state.mode).toBe("NAV");
    expect(state.composer.text).toBe("");
    expect(state.retakePrompt).toBe(null);
    expect(repaints).toBeGreaterThan(1);
  });

  test("enter on an earlier part opens direction entry", async () => {
    const { state, press } = harness();
    state.focusIndex = 4;
    const pathLength = state.payload.path.length;

    await press("return", "\r");

    expect(state.mode).toBe("COMPOSE");
    expect(state.payload.path).toHaveLength(pathLength);
  });

  test("a zero-part story starts in navigation", () => {
    const source = demoAppSource();
    source.payload = {
      ...source.payload,
      path: [],
      nodes: [],
      activeRootId: null,
      tags: [],
      recentNodeIds: [],
      facts: [],
      chapterBreaks: []
    };
    const state = initialState(source, false);

    expect(state.mode).toBe("NAV");
    expect(state.composer.text).toBe("");
  });

  test("R retakes the focused part with an edited prompt", async () => {
    const { state, press } = harness();
    await press("i");
    setComposerText(state.composer, "keep this unrelated Direct draft");
    await press("left");
    const directComposer = state.composer;
    const directCursor = directComposer.cursor;
    await press("escape");
    focusNode(state, "p12");
    const original = state.payload.path.find((node) => node.id === "p12")!;

    await press("R", "R");

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt).toMatchObject({ nodeId: original.id });
    expect(state.composer.text).toBe(original.instruction);
    const composeFrame = frameText(renderStoryScreen(state, { width: 100, height: 30 }).lines);
    expect(composeFrame).toContain("RETAKE");
    expect(composeFrame).toContain("enter retakes with this prompt");

    setComposerText(state.composer, "let the compass point toward Maren");
    await press("return", "\r");
    for (let waited = 0; (state.stream !== null || state.abort !== null) && waited < 100; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const replacement = state.payload.path.at(-1)!;
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.parentId).toBe(original.parentId);
    expect(replacement.instruction).toBe("let the compass point toward Maren");
    expect(state.payload.nodes.some((node) => node.id === original.id)).toBeTrue();
    expect(state.retakePrompt).toBe(null);
    expect(state.composer).toBe(directComposer);
    expect(state.composer.text).toBe("keep this unrelated Direct draft");
    expect(state.composer.cursor).toBe(directCursor);
  });

  test("rewrite selection composer chrome reads REWRITE, not RETAKE", async () => {
    // promptKind turned a boolean into a tri-state ("retake" | "rewrite" |
    // null); the retake variant is asserted above — this is its rewrite
    // counterpart, the only chrome telling a writer Enter rewrites rather
    // than sends a Direct take.
    const { state, press } = harness();
    const index = focusNode(state, "p12");
    const node = state.payload.path.find((candidate) => candidate.id === "p12")!;
    const needle = "the brass compass";
    const start = node.text.indexOf(needle);
    const end = start + needle.length;
    const span = { key: "p12:text", text: node.text, start, end };

    openActions(state, index, node.text.slice(start, end), [span]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    const composeFrame = frameText(renderStoryScreen(state, { width: 100, height: 30 }).lines);
    expect(composeFrame).toContain("REWRITE");
    expect(composeFrame).not.toContain("RETAKE");
    // Issue #319: the footer must name both destinations, since the second
    // key (⌃s) has no other way to be discovered.
    expect(composeFrame).toContain("enter rewrites in place");
    expect(composeFrame).toContain("⌃s as take");
  });

  test("canceling a prompted retake restores the exact hidden Direct composer", async () => {
    const { state, press } = harness();
    await press("i");
    setComposerText(state.composer, "keep this 🧭 draft\nwith its cursor");
    await press("left");
    await press("left");
    state.composerScrollTop = 2;
    state.history = ["older direction"];
    state.historyIndex = state.history.length;
    state.historyDraft = "saved history scratch";
    const directComposer = state.composer;
    const directCursor = directComposer.cursor;

    await press("escape");
    focusNode(state, "p12");
    await press("R", "R");

    expect(state.composer).not.toBe(directComposer);
    expect(state.retakePrompt?.returnState.composer).toBe(directComposer);
    state.composer.fullscreen = true;
    state.historyIndex = 0;
    state.historyDraft = "retake-local scratch";

    await press("escape");
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.nodeId).toBe("p12");

    await press("escape");
    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);
    expect(state.composer).toBe(directComposer);
    expect(state.composer.text).toBe("keep this 🧭 draft\nwith its cursor");
    expect(state.composer.cursor).toBe(directCursor);
    expect(state.composerScrollTop).toBe(2);
    expect(state.historyIndex).toBe(1);
    expect(state.historyDraft).toBe("saved history scratch");
  });

  test("an unavailable prompted-retake target keeps both editors intact", async () => {
    const { state, press } = harness();
    await press("i");
    setComposerText(state.composer, "direct the next scene through the garden");
    const directComposer = state.composer;
    await press("escape");
    focusNode(state, "p13");
    await press("R", "R");
    setComposerText(state.composer, "rewrite the vanished part");
    const retakeComposer = state.composer;
    const retakePrompt = state.retakePrompt!;
    state.payload = {
      ...state.payload,
      path: state.payload.path.filter(({ id }) => id !== "p13"),
      nodes: state.payload.nodes.filter(({ id }) => id !== "p13")
    };

    await press("return", "\r");

    expect(state.mode).toBe("COMPOSE");
    expect(state.composer).toBe(retakeComposer);
    expect(state.composer.text).toBe("rewrite the vanished part");
    expect(state.retakePrompt).toBe(retakePrompt);
    expect(retakePrompt.returnState.composer).toBe(directComposer);
    expect(state.toast).toBe("that part is no longer available to retake · draft kept");
  });

  test("pre-stream restoration keeps an edited-prompt retake bound to its sibling target", async () => {
    const { state, press } = harness();
    focusNode(state, "p12");
    const original = state.payload.path.find((node) => node.id === "p12")!;
    const retakePrompt = openRetakeComposer(
      state, original.id, "send Maren back toward the ruined observatory", { kind: "retake" }
    );
    const draft = {
      kind: "retake",
      text: "send Maren back toward the ruined observatory",
      retakePrompt,
      restored: false
    } satisfies PendingGenerationDraft;
    state.pendingGenerationDraft = draft;
    suspendRetakeComposer(state, retakePrompt);
    state.mode = "NAV";

    expect(restorePendingGenerationDraft(state, draft)).toBeTrue();
    expect(state.composer.text).toBe(draft.text);
    expect(state.retakePrompt).toMatchObject({ nodeId: original.id });
    expect(state.mode).toBe("COMPOSE");

    await press("return", "\r");
    for (let waited = 0; (state.stream !== null || state.abort !== null) && waited < 100; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const replacement = state.payload.path.at(-1)!;
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.parentId).toBe(original.parentId);
    expect(replacement.instruction).toBe(draft.text);
  });

  test("palette Direct clears a retake target restored behind COMMANDS", async () => {
    const { state, press } = harness();
    const original = state.payload.path.find((node) => node.id === "p12")!;
    await press("i");
    setComposerText(state.composer, "preserve this Direct draft");
    const directComposer = state.composer;
    await press("escape");
    focusNode(state, original.id);
    await press("R", "R");
    setComposerText(state.composer, "send Maren back toward the ruined observatory");
    const retakePrompt = state.retakePrompt!;
    const draft = {
      kind: "retake",
      text: state.composer.text,
      retakePrompt,
      restored: false
    } satisfies PendingGenerationDraft;
    state.pendingGenerationDraft = draft;
    suspendRetakeComposer(state, retakePrompt);
    state.mode = "COMMANDS";
    state.commands = {
      query: "direct",
      cursor: 0,
      selectedId: "direct-take",
      view: "commands",
      returnMode: "COMPOSE"
    };

    expect(restorePendingGenerationDraft(state, draft)).toBeTrue();
    expect(state.mode).toBe("COMMANDS");
    expect(state.retakePrompt).toBe(null);
    expect(state.pendingGenerationDraft).toBe(draft);

    await press("return", "\r");

    expect(state.commands).toBe(null);
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer).toBe(directComposer);
    expect(state.composer.text).toBe("preserve this Direct draft");
    expect(state.retakePrompt).toBe(null);
    expect(state.pendingGenerationDraft).toBe(null);
  });

  test("changed-story recovery promotes the retake and shelves its displaced Direct draft", () => {
    const { state } = harness();
    state.history = ["submitted old-story direction"];
    state.historyIndex = 0;
    state.historyDraft = "live unsent Direct scratch";
    setComposerText(state.composer, "edited recalled Direct direction");
    const retakePrompt = openRetakeComposer(
      state, "p12", "keep the direction without its obsolete sibling target", { kind: "retake" }
    );
    const draft = {
      kind: "retake",
      text: "keep the direction without its obsolete sibling target",
      retakePrompt,
      restored: true
    } satisfies PendingGenerationDraft;
    state.pendingGenerationDraft = draft;
    state.history = ["old retake recall"];
    state.historyIndex = 0;
    state.historyDraft = retakePrompt.composer.text;
    setComposerText(state.composer, "edited recalled retake direction");

    adoptReconciliationSnapshot(state, {
      ...state.payload,
      id: "surviving-story",
      title: "Surviving story"
    }, createWrapCache());

    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("edited recalled retake direction");
    expect(state.retakePrompt).toBe(null);
    expect(state.pendingGenerationDraft).toBe(null);
    expect(state.history).toEqual([
      "keep the direction without its obsolete sibling target",
      "live unsent Direct scratch",
      "edited recalled Direct direction"
    ]);
    expect(state.historyIndex).toBe(3);
  });

  test("changed-story recovery keeps Direct visible and shelves a dormant retake", () => {
    const { state } = harness();
    state.history = ["submitted old-story direction"];
    state.historyIndex = 0;
    state.historyDraft = "live unsent Direct scratch";
    setComposerText(state.composer, "edited recalled Direct direction");
    const directComposer = state.composer;
    const retakePrompt = openRetakeComposer(state, "p12", "dormant failed retake", { kind: "retake" });
    const draft = {
      kind: "retake",
      text: retakePrompt.composer.text,
      retakePrompt,
      restored: true
    } satisfies PendingGenerationDraft;
    state.pendingGenerationDraft = draft;
    suspendRetakeComposer(state, retakePrompt);
    state.mode = "COMMANDS";
    state.commands = {
      query: "", cursor: 0, selectedId: null, view: "commands", returnMode: "COMPOSE"
    };

    adoptReconciliationSnapshot(state, {
      ...state.payload,
      id: "surviving-story",
      title: "Surviving story"
    }, createWrapCache());

    expect(state.mode).toBe("COMMANDS");
    expect(state.composer).toBe(directComposer);
    expect(state.composer.text).toBe("edited recalled Direct direction");
    expect(state.retakePrompt).toBe(null);
    expect(state.pendingGenerationDraft).toBe(null);
    expect(state.history).toEqual(["live unsent Direct scratch", "dormant failed retake"]);
    expect(state.historyIndex).toBe(2);
  });

  test("changed-story recovery shelves a Direct live scratch while recall is edited", () => {
    const { state } = harness();
    state.mode = "COMPOSE";
    state.history = ["submitted old-story direction"];
    state.historyIndex = 0;
    state.historyDraft = "live unsent Direct scratch";
    setComposerText(state.composer, "edited recalled Direct direction");

    adoptReconciliationSnapshot(state, {
      ...state.payload,
      id: "surviving-story",
      title: "Surviving story"
    }, createWrapCache());

    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("edited recalled Direct direction");
    expect(state.history).toEqual(["live unsent Direct scratch"]);
    expect(state.historyIndex).toBe(1);
  });

  test("n opens the Author's Note regardless of the focused part", async () => {
    const { state, press } = harness();
    state.focusIndex = 4;
    const previousStoryId = state.payload.id;
    await press("n");
    expect(state.payload.id).toBe(previousStoryId);
    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toMatchObject({
      kind: "document",
      target: { kind: "authors-note" }
    });
  });

  test("Space continues from the focused seam without opening Direct", async () => {
    const { state, press } = harness();
    state.focusIndex = 4;
    const anchorId = state.payload.path[4]!.id;

    await press("space", " ");
    for (let waited = 0; (state.stream !== null || state.abort !== null) && waited < 100; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(state.mode).toBe("NAV");
    expect(state.payload.path).toHaveLength(6);
    expect(state.payload.path[5]?.parentId).toBe(anchorId);
    expect(rowIndexForNode(createStoryViewModel(state.payload), state.payload.path[5]!.id))
      .toBe(state.focusIndex);
  });

  test("y copies the focused part, Y the whole line", async () => {
    const { state, press } = harness();
    focusNode(state, "p12");
    await press("y");
    expect(state.toast).toContain("¶ 12");
    await press("Y", "Y");
    expect(state.toast).toContain("line · 13 parts");
  });

  test("copy story line below is offered on a non-leaf part and hidden on the leaf; pasting it below another part becomes available only after the copy", async () => {
    const { state, press } = harness();

    // p13 is the story's leaf: nothing continues below it to copy.
    focusNode(state, "p13");
    await press("x");
    expect(currentPartActions(state).map((action) => action.id)).not.toContain("copy-line");
    expect(currentPartActions(state).map((action) => action.id)).not.toContain("paste-line");
    await press("escape");

    // p11 continues into p12 then p13: two parts to copy below it.
    focusNode(state, "p11");
    await press("x");
    const actions = currentPartActions(state);
    expect(actions.map((action) => action.id)).toContain("copy-line");
    expect(actions.map((action) => action.id)).not.toContain("paste-line");
    state.actions!.cursor = actions.findIndex(({ id }) => id === "copy-line");
    await press("return", "\r");
    expect(state.toast).toBe("copied story line · 2 parts");
    expect(state.lineClipboard).toEqual({
      storyId: state.payload.id,
      sourceNodeId: "p11",
      expectedLeafId: "p13",
      parts: 2
    });

    // A different part now offers "paste story line below" — the source
    // selection travels with the writer, it is not pinned to p11.
    focusNode(state, "p8");
    await press("x");
    expect(currentPartActions(state).map((action) => action.id)).toContain("paste-line");
  });

  test("x opens the part menu; enter runs the highlighted action", async () => {
    const { state, press } = harness();
    focusNode(state, "p12");
    await press("x");
    expect(state.actions).toEqual({ partId: "p12", cursor: 0, selectionText: null });
    expect(currentPartActions(state).map((action) => action.id)).toContain("retake-with-prompt");
    await press("down");
    await press("return", "\r");
    expect(state.actions).toBe(null);
    expect(state.mode).toBe("COMPOSE");
  });

  test("a selected-text menu copies only the selection and can turn it into an editable fact", async () => {
    const { state, press, pressKey } = harness();
    const index = focusNode(state, "p12");
    openActions(state, index, "The lantern remembers.");

    expect(currentPartActions(state).find(({ id }) => id === "copy")).toMatchObject({
      name: "Copy selection",
      description: "copy exactly the highlighted text"
    });
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "copy");
    await press("return", "\r");
    expect(state.toast).toMatch(/^(copied selection|no clipboard available for selection)/);

    openActions(state, index, "The lantern remembers.");
    state.actions!.cursor = currentPartActions(state)
      .findIndex(({ id }) => id === "fact-from-selection");
    await press("return", "\r");

    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("fact");
    if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
    expect(state.editor.target).toEqual({ kind: "fact", factId: null, base: null });
    expect(state.editor.tag.text).toBe("");
    expect(state.editor.composer.text).toBe("The lantern remembers.");
    expect(state.editor.returnMode).toBe("NAV");
    await pressKey(modifiedKey("s", { sequence: "\u0013", ctrl: true }));
    expect(state.payload.facts.some(({ text }) => text === "The lantern remembers.")).toBeTrue();
    expect(state.toast).toBe("fact created");
  });

  test("the selection-fact action keeps its description in a separate column", () => {
    const { state } = harness();
    const index = focusNode(state, "p12");
    openActions(state, index, "The lantern remembers.");
    const rendered = renderStoryScreen(
      state, { width: 80, height: 30, wrapCache: createWrapCache() }
    );
    const row = rendered.lines.map((line) => frameText([line]))
      .find((line) => line.includes("New fact from selection"));

    expect(row).toContain("New fact from selection  edit");
    expect(row).not.toContain("selectionedit");
  });
});

import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { StoryNode, StoryPayload } from "../../shared/types.js";
import { ActionRuntime } from "../src/action-runtime.js";
import type { ActionContext } from "../src/action-context.js";
import { textHash } from "../src/api.js";
import { handleKey, initialState, type AppSource } from "../src/app.js";
import { createBreakAtFocus } from "../src/chapter-actions.js";
import { demoAppSource } from "../src/demo.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { createPrunePlan } from "../src/prune-model.js";
import { adoptSameStoryPayload, adoptStoryState } from "../src/story-adoption.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import { confirmPrune } from "../src/story-mutations.js";
import { storyFrameWrapPlans } from "../src/story-wrap-build.js";
import { createWrapCache, type ProseStyle, type WrappedLine } from "../src/wrap.js";

/** Issue #330: a mutation used to clear the whole WrapCache, so the next
 * same-story frame rewrapped every unchanged part while the old frame kept
 * showing stale prose. These tests operate real mutations against one
 * persistent cache and assert, through the cache's own work counters, that
 * unchanged parts stay warm and exactly the changed parts wrap again. */
function harness() {
  const source: AppSource = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const layout = deriveStoryFrameLayout(120, state.config);
  const context: ActionContext = {
    cache,
    repaint: () => undefined,
    backend: new ActionRuntime(state, () => undefined),
    renderer: null,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };
  // The exact per-part wrap work one full frame performs, through the same
  // canonical plans the synchronous frame and the cold prewarmer both use.
  const wrapFrame = () => {
    const lines = new Map<string, WrappedLine<ProseStyle>[]>();
    for (const plan of storyFrameWrapPlans(state, layout)) {
      lines.set(plan.partId, cache.wrap(plan.partId, plan.width, plan.text, plan.runs, plan.identity));
    }
    return lines;
  };
  const press = (name: string, sequence = name) => handleKey(
    { name, sequence, shift: false, ctrl: false, meta: false } as KeyEvent,
    state, source, cache, () => undefined, async () => undefined, () => undefined
  );
  return { source, state, cache, context, wrapFrame, press };
}

describe("wrap-cache invalidation boundary", () => {
  test("a keyboard take switch keeps every part above the switch warm", async () => {
    const { state, cache, wrapFrame, press } = harness();
    const first = wrapFrame();
    const cold = cache.misses;
    expect(cold).toBe(state.payload.path.length);
    const beforeIds = new Set(state.payload.path.map(({ id }) => id));

    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    await press("right");

    const swapped = state.payload.path.filter(({ id }) => !beforeIds.has(id));
    expect(swapped.length).toBeGreaterThan(0);
    const hitsBefore = cache.hits;
    const second = wrapFrame();
    // Only the parts the new take brought in wrap again; every part that
    // stayed on the path answers from cache and keeps its exact lines.
    expect(cache.misses).toBe(cold + swapped.length);
    expect(cache.hits - hitsBefore).toBe(state.payload.path.length - swapped.length);
    expect(second.get("p1")).toBe(first.get("p1"));
    expect(second.get("p11")).toBe(first.get("p11"));
  });

  test("adding a chapter break and undoing it keep every prose part warm", async () => {
    const { state, source, cache, context, wrapFrame, press } = harness();
    wrapFrame();
    const cold = cache.misses;
    const breaksBefore = state.payload.chapterBreaks.length;

    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p6");
    await createBreakAtFocus(state, source, context);
    expect(state.payload.chapterBreaks.length).toBe(breaksBefore + 1);
    wrapFrame();
    expect(cache.misses).toBe(cold);

    await press("u");
    expect(state.payload.chapterBreaks.length).toBe(breaksBefore);
    wrapFrame();
    expect(cache.misses).toBe(cold);
  });

  test("pruning a path subtree keeps surviving parts warm and drops the pruned entries", async () => {
    const { state, source, cache, context, wrapFrame } = harness();
    wrapFrame();
    const cold = cache.misses;

    const plan = createPrunePlan(state.payload, "p13");
    expect(plan).not.toBe(null);
    state.prune = plan;
    await confirmPrune(state, source, context);

    expect(state.payload.path.some(({ id }) => id === "p13")).toBeFalse();
    expect(cache.partIds()).not.toContain("p13");
    wrapFrame();
    expect(cache.misses).toBe(cold);
  });

  test("an in-place edit misses only the edited part and shows its new prose", async () => {
    const { state, source, cache, wrapFrame } = harness();
    const before = wrapFrame();
    const cold = cache.misses;
    const target = state.payload.path[4]!;

    const payload = await source.api.editNode(state.payload.id, target, {
      text: "Rewritten prose that replaces the old paragraph entirely."
    });
    adoptSameStoryPayload(state, payload, cache);

    const after = wrapFrame();
    expect(cache.misses).toBe(cold + 1);
    expect(after.get(target.id)).not.toBe(before.get(target.id));
    expect(after.get(target.id)!.map(({ text }) => text).join(" ")).toContain("Rewritten prose");
    expect(after.get("p1")).toBe(before.get("p1"));
  });

  test("a settled append rewraps only the leaf it landed on", async () => {
    const { state, source, cache, wrapFrame } = harness();
    const before = wrapFrame();
    const cold = cache.misses;
    const leaf = state.payload.path.at(-1)!;

    const payload = await source.api.createNode(state.payload.id, {
      appendTo: leaf.id,
      expectedTextHash: await textHash(leaf.text),
      instruction: "",
      text: " The machine keeps writing where the writer stopped.",
      genId: "gen-append-330"
    });
    adoptSameStoryPayload(state, payload, cache);

    const after = wrapFrame();
    expect(cache.misses).toBe(cold + 1);
    expect(after.get(leaf.id)).not.toBe(before.get(leaf.id));
    expect(after.get("p1")).toBe(before.get("p1"));
  });

  test("rename and tag mutations keep the whole story warm", async () => {
    const { state, source, cache, wrapFrame } = harness();
    wrapFrame();
    const cold = cache.misses;

    adoptSameStoryPayload(state, await source.api.renameStory(state.payload.id, "Renamed story"), cache);
    const leafId = state.payload.path.at(-1)!.id;
    adoptSameStoryPayload(state, await source.api.putBookmark(state.payload.id, leafId, "keep", "Canon"), cache);

    wrapFrame();
    expect(cache.misses).toBe(cold);
    expect(state.payload.title).toBe("Renamed story");
  });

  test("a same-story authoritative reload through adoptStoryState keeps parts warm", async () => {
    const { state, source, cache, wrapFrame } = harness();
    wrapFrame();
    const cold = cache.misses;

    // Search travel and recovery adopt a freshly loaded payload: every node
    // object is new while the prose is not. Without identity rebinding this
    // frame would rewrap the entire story.
    adoptStoryState(state, await source.api.loadStory(state.payload.id), cache);

    wrapFrame();
    expect(cache.misses).toBe(cold);
  });

  test("opening a different story leaves no cached parts behind", async () => {
    const { state, cache, wrapFrame } = harness();
    wrapFrame();
    expect(cache.partIds().length).toBeGreaterThan(0);

    adoptStoryState(state, { ...state.payload, id: "another-story" }, cache);
    expect(cache.partIds()).toEqual([]);
  });

  test("a 400-part story rewraps exactly one part after a one-part mutation", () => {
    const { state, cache, wrapFrame } = harness();
    const parts = 400;
    const path: StoryNode[] = Array.from({ length: parts }, (_, index) => ({
      id: `big-${index}`,
      parentId: index === 0 ? null : `big-${index - 1}`,
      instruction: "",
      text: `Paragraph ${index} of a very long story, wide enough to wrap across several rendered lines. `.repeat(4),
      model: "demo",
      createdAt: "2026-08-01T00:00:00.000Z",
      activeChildId: index === parts - 1 ? null : `big-${index + 1}`
    }));
    const payload: StoryPayload = {
      ...state.payload,
      path,
      nodes: path.map((node) => ({
        id: node.id,
        parentId: node.parentId,
        preview: node.text.slice(0, 24),
        words: 16,
        tokens: 20,
        childCount: node.activeChildId === null ? 0 : 1,
        leafCount: 1,
        lastTouched: node.createdAt,
        hasInstruction: false,
        activeChildId: node.activeChildId
      })),
      activeRootId: path[0]!.id,
      tags: [],
      recentNodeIds: [],
      facts: [],
      chapterBreaks: []
    };
    state.payload = payload;

    wrapFrame();
    expect(cache.misses).toBe(parts);
    wrapFrame();
    expect(cache.misses).toBe(parts);

    const edited = path.map((node, index) => index === 250
      ? { ...node, text: `${node.text} One edited sentence at the end.` }
      : node);
    adoptSameStoryPayload(state, { ...payload, path: edited }, cache);

    const hitsBefore = cache.hits;
    const frame = wrapFrame();
    // The honest scale assertion: cache work, not wall clock. One part wraps
    // again; the other 399 answer from cache on the very next frame.
    expect(cache.misses).toBe(parts + 1);
    expect(cache.hits - hitsBefore).toBe(parts - 1);
    expect(frame.get("big-250")!.map(({ text }) => text).join(" ")).toContain("One edited sentence");
  });
});

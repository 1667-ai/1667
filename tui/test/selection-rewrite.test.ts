import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState, type AppSource } from "../src/app.js";
import type { ActionContext } from "../src/action-context.js";
import { DEMO_REWRITE_TEXT, demoAppSource } from "../src/demo.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { requestRewriteStop } from "../src/rewrite-action.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import type { StorySelectionSpan } from "../src/selection-projection.js";
import { currentPartActions, openActions, runPartAction } from "../src/story-actions.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import { storyFrameWrapPlans } from "../src/story-wrap-build.js";
import { createWrapCache } from "../src/wrap.js";

const key = (name: string, sequence = name): KeyEvent =>
  ({ name, sequence, shift: false, ctrl: false, meta: false }) as KeyEvent;

function harness() {
  const source: AppSource = demoAppSource();
  const state = initialState(source, false);
  const press = (name: string, sequence = name) => handleKey(
    key(name, sequence), state, source, createWrapCache(), () => {}, async () => {}, () => {}
  );
  return { source, state, press };
}

function focusNode(state: ReturnType<typeof harness>["state"], nodeId: string): number {
  const index = rowIndexForNode(createStoryViewModel(state.payload), nodeId);
  state.focusIndex = index;
  return index;
}

/** The exact node text a p12 rewrite splices, and the span describing it.
 *  p12 also carries the demo fixture's own human attribution range, over a
 *  later, disjoint phrase — useful for proving a rewrite does not smear that
 *  attribution onto the model's replacement. */
function rewriteFixture(state: ReturnType<typeof harness>["state"]) {
  const node = state.payload.path.find((candidate) => candidate.id === "p12")!;
  const needle = "the brass compass";
  const start = node.text.indexOf(needle);
  const end = start + needle.length;
  const span: StorySelectionSpan = { key: "p12:text", text: node.text, start, end };
  return { node, needle, start, end, span };
}

function directContext(state: ReturnType<typeof harness>["state"]): ActionContext {
  return {
    cache: createWrapCache(),
    repaint: () => undefined,
    backend: new ActionRuntime(state, () => undefined),
    renderer: null,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };
}

/** A NativeSelectionSnapshot in CliRenderer's clothing: `readNativeSelection`
 *  (tui/src/copy-actions.ts) only walks the real CliRenderer surface when
 *  `"getSelection" in selection`, so a plain snapshot object is read back
 *  directly instead — the same substitution selection-copy.test.ts uses. */
function stubSelectionRenderer(text: string): ActionContext["renderer"] {
  return { identity: {}, text, range: { start: 0, end: 1 }, backward: false } as never;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function settleStream(state: ReturnType<typeof harness>["state"]): Promise<void> {
  for (let waited = 0; (state.stream !== null || state.abort !== null) && waited < 100; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("selection rewrite", () => {
  test("the part menu offers Rewrite selection and running it replaces exactly the highlighted characters", async () => {
    const { state, press } = harness();
    const index = focusNode(state, "p12");
    const { node, needle, start, end, span } = rewriteFixture(state);
    const pathIdsBefore = state.payload.path.map((part) => part.id);
    openActions(state, index, node.text.slice(start, end), [span]);

    const actions = currentPartActions(state);
    expect(actions.find(({ id }) => id === "rewrite-selection")).toMatchObject({
      name: "Rewrite selection",
      description: "regenerate the highlighted text"
    });
    state.actions!.cursor = actions.findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");
    await settleStream(state);

    const rewritten = state.payload.path.find((candidate) => candidate.id === "p12")!;
    const tailLength = node.text.length - end;
    expect(rewritten.text.slice(0, start)).toBe(node.text.slice(0, start));
    expect(rewritten.text.slice(rewritten.text.length - tailLength)).toBe(node.text.slice(end));
    expect(rewritten.text).not.toContain(needle);
    // The demo fixture's rewrite always lands DEMO_REWRITE_TEXT — assert the
    // replacement actually landed, not just that the old words are gone
    // (which an empty splice would also satisfy).
    expect(rewritten.text).toContain(DEMO_REWRITE_TEXT);
    expect(rewritten.id).toBe("p12");
    // The rewrite splices its target in place; it never adds or removes a
    // node on the path.
    expect(state.payload.path.map((part) => part.id)).toEqual(pathIdsBefore);
    expect(state.toast).toBe("selection rewritten");
    expect(state.stream).toBe(null);
    expect(state.abort).toBe(null);
  });

  test("while it streams, the story screen shows the replacement spliced in place", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, needle, start, end, span } = rewriteFixture(state);
    const entered = deferred();
    const gate = deferred();
    source.api.rewriteNode = async (_storyId, _nodeId, _body, onDelta) => {
      onDelta("a shard of brass light");
      entered.resolve();
      await gate.promise;
    };

    openActions(state, index, node.text.slice(start, end), [span]);
    const pending = runPartAction("rewrite-selection", state, source, directContext(state));
    await entered.promise;

    expect(state.stream?.rewrite).toEqual({ start, end });
    // The riskiest branch in the whole change: without the stream-mode guard
    // that keeps a rewrite target out of the "new take" branches, the target
    // node would be yielded a second time as a fabricated virtual sibling
    // instead of being spliced in place, growing the row count.
    const streamingParts = createStoryViewModel(state.payload, state.stream).parts;
    const settledParts = createStoryViewModel(state.payload).parts;
    expect(streamingParts).toHaveLength(settledParts.length);
    const projected = streamingParts.find((part) => part.id === "p12")!.node.text;
    const tailLength = node.text.length - end;
    expect(projected.slice(0, start)).toBe(node.text.slice(0, start));
    expect(projected.slice(projected.length - tailLength)).toBe(node.text.slice(end));
    expect(projected).toContain("a shard of brass light");
    expect(projected).not.toContain(needle);

    const frame = frameText(renderStoryScreen(
      state, { width: 120, height: 40, wrapCache: createWrapCache() }
    ).lines);
    expect(frame).toContain("a shard of brass light");
    // Words on either side of the splice, still part of the same paragraph.
    expect(frame).toContain("stairs");
    expect(frame).toContain("needle");

    gate.resolve();
    await pending;
  });

  test("a node with human attribution, mid-rewrite, keeps its ranges inside the projected text and off the replaced span", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, start, end, span } = rewriteFixture(state);
    // p12 ships with a human-edit range over a later, disjoint phrase — the
    // fixture Fix 1a exists to protect.
    expect(node.attribution?.source).toBe("human");
    expect(node.attribution!.ranges.length).toBeGreaterThan(0);

    const entered = deferred();
    const gate = deferred();
    const replacement = "a shard of brass light";
    source.api.rewriteNode = async (_storyId, _nodeId, _body, onDelta) => {
      onDelta(replacement);
      entered.resolve();
      await gate.promise;
    };

    openActions(state, index, node.text.slice(start, end), [span]);
    const pending = runPartAction("rewrite-selection", state, source, directContext(state));
    await entered.promise;

    const streamed = createStoryViewModel(state.payload, state.stream).parts
      .find((part) => part.id === "p12")!;
    const replacedEnd = start + replacement.length;
    expect(streamed.humanSpans.length).toBeGreaterThan(0);
    for (const range of streamed.humanSpans) {
      expect(range.start).toBeGreaterThan(-1);
      expect(range.end).toBeLessThan(streamed.node.text.length + 1);
      // No surviving range may overlap the freshly-spliced replacement —
      // otherwise the model's own words would paint as the writer's.
      expect(range.end <= start || range.start >= replacedEnd).toBeTrue();
    }

    // Fix 1 regression guard: the wrap-planner path (story-wrap-build.ts,
    // storyWrapPlans) and the frame path above (model.ts, via
    // projectStreamedPayload) each build their own projection of the
    // streaming target. They must still agree on where the human-authored
    // prose sits — otherwise the planner wraps human-styled runs the frame
    // never draws, or drops runs the frame does. Comparing the "human"
    // style runs the planner's wrap plan carries against the frame's
    // humanSpans is the observable consequence of both readers consuming
    // the same recomputed-attribution node instead of one of them
    // re-deriving it from the settled node's now-stale ranges.
    const layout = deriveStoryFrameLayout(120, state.config);
    const wrapPlan = storyFrameWrapPlans(state, layout).find((plan) => plan.partId === "p12")!;
    const plannerHumanRuns = wrapPlan.runs
      .filter((run) => run.style === "human")
      .map((run) => ({ start: run.start, end: run.end }));
    expect(plannerHumanRuns).toEqual(streamed.humanSpans);

    gate.resolve();
    await pending;
  });

  test("escape during the rewrite stops it and the stored text is unchanged", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    const entered = deferred();
    const gate = deferred();
    let apiCalled = false;
    source.api.rewriteNode = async (_storyId, _nodeId, _body, onDelta) => {
      apiCalled = true;
      onDelta("a shard of brass light");
      entered.resolve();
      await gate.promise;
    };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    const pending = runPartAction("rewrite-selection", state, source, directContext(state));
    await entered.promise;
    expect(state.stream).not.toBe(null);
    expect(apiCalled).toBeTrue();

    requestRewriteStop(state, () => undefined);
    expect(state.stream).toBe(null);
    expect(state.toast).toContain("rewrite stopping");

    gate.resolve();
    await pending;

    expect(state.payload.path.find((candidate) => candidate.id === "p12")?.text).toBe(node.text);
    expect(state.toast).toBe("rewrite stopped · nothing saved");
    expect(state.abort).toBe(null);
  });

  test("a stale selection refuses with a toast and never calls the API", async () => {
    const { state, source, press } = harness();
    const index = focusNode(state, "p12");
    const { node, start, end } = rewriteFixture(state);
    const staleSpan: StorySelectionSpan = {
      key: "p12:text",
      text: `${node.text.slice(0, start)}a different phrase entirely${node.text.slice(end)}`,
      start,
      end
    };
    let called = false;
    source.api.rewriteNode = async () => { called = true; };

    openActions(state, index, "stale selection", [staleSpan]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");

    expect(called).toBeFalse();
    expect(state.toast).toBe("the story changed · highlight it again");
    expect(state.payload.path.find((candidate) => candidate.id === "p12")?.text).toBe(node.text);
    expect(state.stream).toBe(null);
  });

  test("a running stream refuses the menu action with a busy toast", async () => {
    const { state, press } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    state.stream = {
      targetId: "p13", parentId: "p12", append: true,
      startedAt: new Date().toISOString(), instruction: "", text: ""
    };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");

    expect(state.toast).toBe("stream running · esc stops it first");
  });

  test("an offline connection refuses the menu action with an offline toast", async () => {
    const { state, press } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    state.connection = { down: true, attempt: 1, nextRetryAt: null, error: null };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");

    expect(state.toast).toBe("offline · reading still works");
  });

  test("a selection spanning two parts does not offer Rewrite selection in the part menu", () => {
    const { state } = harness();
    const index = focusNode(state, "p12");
    const parent = state.payload.path.find((candidate) => candidate.id === "p11")!;
    const node = state.payload.path.find((candidate) => candidate.id === "p12")!;
    const spans: StorySelectionSpan[] = [
      { key: "p11:text", text: parent.text, start: 0, end: Math.min(5, parent.text.length) },
      { key: "p12:text", text: node.text, start: 0, end: Math.min(5, node.text.length) }
    ];
    openActions(state, index, "a two-part selection", spans);

    const actions = currentPartActions(state);
    expect(actions.some(({ id }) => id === "rewrite-selection")).toBeFalse();
    // Still a selection by every other measure — copy/fact entries remain.
    expect(actions.find(({ id }) => id === "copy")).toMatchObject({ name: "Copy selection" });
  });

  test("a selection over a direction line does not offer Rewrite selection in the part menu", () => {
    const { state } = harness();
    const index = focusNode(state, "p12");
    const node = state.payload.path.find((candidate) => candidate.id === "p12")!;
    const span: StorySelectionSpan = {
      key: "p12:instruction",
      text: node.instruction,
      start: 0,
      end: Math.max(1, node.instruction.length)
    };
    openActions(state, index, "a direction line", [span]);

    const actions = currentPartActions(state);
    expect(actions.some(({ id }) => id === "rewrite-selection")).toBeFalse();
    expect(actions.find(({ id }) => id === "copy")).toMatchObject({ name: "Copy selection" });
  });

  test("opening the palette with a rewritable selection captures it and Rewrite selection runs", async () => {
    const { state, source, press } = harness();
    focusNode(state, "p12");
    const { node, needle, start, end, span } = rewriteFixture(state);
    state.storySelectionProjection = [{ key: span.key, text: span.text, start: span.start, end: span.end }];

    const handled = await handleOverlayAction(
      { action: "open-commands" },
      state,
      source,
      { ...directContext(state), renderer: stubSelectionRenderer(needle) }
    );

    expect(handled).toBeTrue();
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.selection).toEqual({ text: needle, spans: [span] });

    for (const character of "rewrite selection") await press(character, character);
    expect(state.commands?.query).toBe("rewrite selection");
    await press("return", "\r");
    await settleStream(state);

    const rewritten = state.payload.path.find((candidate) => candidate.id === "p12")!;
    const tailLength = node.text.length - end;
    expect(rewritten.text.slice(0, start)).toBe(node.text.slice(0, start));
    expect(rewritten.text.slice(rewritten.text.length - tailLength)).toBe(node.text.slice(end));
    expect(rewritten.text).not.toContain(needle);
    expect(rewritten.text).toContain(DEMO_REWRITE_TEXT);
    expect(state.toast).toBe("selection rewritten");
  });

  test("opening the palette with no selection never runs Rewrite selection", async () => {
    const { state, source, press } = harness();
    focusNode(state, "p12");
    state.storySelectionProjection = null;

    const handled = await handleOverlayAction(
      { action: "open-commands" },
      state,
      source,
      { ...directContext(state), renderer: stubSelectionRenderer("something highlighted") }
    );

    expect(handled).toBeTrue();
    expect(state.mode).toBe("COMMANDS");
    expect(state.commands?.selection ?? null).toBe(null);

    for (const character of "rewrite selection") await press(character, character);
    expect(state.commands?.query).toBe("rewrite selection");
    // Nothing named "rewrite selection" can be the retained selection when
    // the command was filtered out of the palette entirely.
    expect(state.commands?.selectedId).not.toBe("rewrite-selection");

    await press("return", "\r");
    expect(state.stream).toBe(null);
    expect(state.toast).not.toBe("selection rewritten");
  });
});

import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import { handleKey, initialState, type AppSource } from "../src/app.js";
import type { ActionContext } from "../src/action-context.js";
import { setComposerText } from "../src/composer-model.js";
import { DEMO_REWRITE_TEXT, demoAppSource } from "../src/demo.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { requestRewriteStop } from "../src/rewrite-action.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import type { StorySelectionSpan } from "../src/selection-projection.js";
import { composeAction, currentPartActions, navAction, openActions, runPartAction } from "../src/story-actions.js";
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleStream(state: ReturnType<typeof harness>["state"]): Promise<void> {
  for (let waited = 0; (state.stream !== null || state.abort !== null) && waited < 100; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("selection rewrite", () => {
  test("the part menu offers Rewrite selection, opens a composer, and an empty submit runs the plain regenerate that commits a new take at p12's position", async () => {
    const { state, source, press } = harness();
    const index = focusNode(state, "p12");
    const { node, needle, start, end, span } = rewriteFixture(state);
    const pathIdsBefore = state.payload.path.map((part) => part.id);
    const p12Index = pathIdsBefore.indexOf("p12");
    openActions(state, index, node.text.slice(start, end), [span]);

    const actions = currentPartActions(state);
    expect(actions.find(({ id }) => id === "rewrite-selection")).toMatchObject({
      name: "Rewrite selection",
      description: "regenerate the highlighted text"
    });
    state.actions!.cursor = actions.findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");

    // Choosing the entry opens a composer rather than running anything —
    // seeded blank, since a rewrite instruction has nothing to do with the
    // node's own original direction the way a retake's does.
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent).toEqual({ kind: "rewrite", start, end, expected: node.text.slice(start, end) });
    expect(state.composer.text).toBe("");

    let capturedInstruction: string | undefined;
    const originalRewriteNode = source.api.rewriteNode;
    source.api.rewriteNode = (storyId, nodeId, body, onDelta, signal) => {
      capturedInstruction = body.instruction;
      return originalRewriteNode(storyId, nodeId, body, onDelta, signal);
    };

    await press("return", "\r");
    await settleStream(state);

    // An empty composer sends an empty instruction — the plain regenerate
    // path, preserved exactly.
    expect(capturedInstruction).toBe("");

    // The rewrite commits as a new take at p12's old position on the path.
    // p12 had a child (p13); that child falls off the active path with it,
    // since the new take — freshly created — has none of its own.
    const pathIdsAfter = state.payload.path.map((part) => part.id);
    expect(pathIdsAfter.length).toBe(p12Index + 1);
    expect(pathIdsAfter.slice(0, p12Index)).toEqual(pathIdsBefore.slice(0, p12Index));
    const takeId = pathIdsAfter[p12Index]!;
    expect(takeId).not.toBe("p12");

    const rewritten = state.payload.path.find((candidate) => candidate.id === takeId)!;
    const tailLength = node.text.length - end;
    expect(rewritten.text.slice(0, start)).toBe(node.text.slice(0, start));
    expect(rewritten.text.slice(rewritten.text.length - tailLength)).toBe(node.text.slice(end));
    expect(rewritten.text).not.toContain(needle);
    // The demo fixture's rewrite always lands DEMO_REWRITE_TEXT — assert the
    // replacement actually landed, not just that the old words are gone
    // (which an empty splice would also satisfy).
    expect(rewritten.text).toContain(DEMO_REWRITE_TEXT);

    // The source survives, unrewritten, reachable as a sibling of the take.
    const sourceNode = state.payload.nodes.find((candidate) => candidate.id === "p12");
    expect(sourceNode).toBeDefined();
    expect(sourceNode?.preview).not.toContain(DEMO_REWRITE_TEXT);

    expect(state.toast).toBe("selection rewritten");
    expect(state.stream).toBe(null);
    expect(state.abort).toBe(null);
  });

  test("a typed instruction reaches the transport verbatim", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, start, end, span } = rewriteFixture(state);
    const context = directContext(state);

    openActions(state, index, node.text.slice(start, end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");

    setComposerText(state.composer, "let the compass point toward Maren");

    let capturedInstruction: string | undefined;
    source.api.rewriteNode = async (_storyId, _nodeId, body) => {
      capturedInstruction = body.instruction;
      return null;
    };

    await composeAction({ action: "send" }, state, source, context);

    expect(capturedInstruction).toBe("let the compass point toward Maren");
  });

  test("escape from the rewrite composer abandons it without starting a rewrite", async () => {
    const { state, source, press } = harness();
    const index = focusNode(state, "p12");
    const { node, start, end, span } = rewriteFixture(state);
    let called = false;
    source.api.rewriteNode = async () => { called = true; return null; };

    openActions(state, index, node.text.slice(start, end), [span]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");

    setComposerText(state.composer, "a typed instruction that should vanish");
    await press("escape");

    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);
    expect(state.pendingGenerationDraft).toBe(null);
    expect(called).toBeFalse();
    expect(state.stream).toBe(null);
    expect(state.payload.path.find((candidate) => candidate.id === "p12")?.text).toBe(node.text);
  });

  test("the story moving under an open rewrite composer is refused at send with the stale-selection toast, and no request is made", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, start, end, span } = rewriteFixture(state);
    const context = directContext(state);

    openActions(state, index, node.text.slice(start, end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");

    // The story moves under the open composer: p12's text changes at exactly
    // the range the composer resolved when it opened.
    state.payload = {
      ...state.payload,
      path: state.payload.path.map((part) => part.id === "p12"
        ? { ...part, text: `${part.text.slice(0, start)}a different phrase entirely${part.text.slice(end)}` }
        : part)
    };

    let called = false;
    source.api.rewriteNode = async () => { called = true; return null; };

    await composeAction({ action: "send" }, state, source, context);

    expect(called).toBeFalse();
    expect(state.toast).toBe("the story changed · highlight it again");
    // Refused synchronously, before any ownership handoff: the composer
    // stays open with the writer's draft intact rather than bouncing to NAV.
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    expect(state.stream).toBe(null);
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
      return null;
    };

    const context = directContext(state);
    openActions(state, index, node.text.slice(start, end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    const pending = composeAction({ action: "send" }, state, source, context);
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
      return null;
    };

    const context = directContext(state);
    openActions(state, index, node.text.slice(start, end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    const pending = composeAction({ action: "send" }, state, source, context);
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

  test("escape during the rewrite stops it, restores the typed instruction into a reopened composer, and the stored text is unchanged", async () => {
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
      return null;
    };

    const context = directContext(state);
    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    setComposerText(state.composer, "steady the flame");
    const pending = composeAction({ action: "send" }, state, source, context);
    await entered.promise;
    expect(state.stream).not.toBe(null);
    expect(state.mode).toBe("NAV");
    expect(apiCalled).toBeTrue();

    // Mirrors a failed/stopped retake: the typed instruction reappears in a
    // reopened composer on the same tick as the keypress, since a stopped
    // rewrite never has partial text worth landing instead.
    requestRewriteStop(state, () => undefined);
    expect(state.stream).toBe(null);
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    expect(state.composer.text).toBe("steady the flame");
    expect(state.toast).toBe(null);

    gate.resolve();
    await pending;

    expect(state.payload.path.find((candidate) => candidate.id === "p12")?.text).toBe(node.text);
    // The reopened composer and its draft survive the async reload settling
    // behind it.
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("steady the flame");
    expect(state.toast).toBe(null);
    expect(state.abort).toBe(null);
  });

  test("a thrown rewrite request restores the typed instruction", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    const context = directContext(state);
    source.api.rewriteNode = async () => { throw new Error("provider request failed"); };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    setComposerText(state.composer, "steady the flame");

    await composeAction({ action: "send" }, state, source, context);

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    expect(state.composer.text).toBe("steady the flame");
    expect(state.toast).toBe("provider request failed");
    expect(state.pendingGenerationDraft).toMatchObject({ text: "steady the flame", restored: true });
    expect(state.payload.path.find((candidate) => candidate.id === "p12")?.text).toBe(node.text);
    expect(state.abort).toBe(null);
  });

  test("a rewrite that lands nothing (a null take id, not an abort or an error) restores the typed instruction", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    const context = directContext(state);
    source.api.rewriteNode = async () => null;

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    setComposerText(state.composer, "steady the flame");

    await composeAction({ action: "send" }, state, source, context);

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    expect(state.composer.text).toBe("steady the flame");
    expect(state.pendingGenerationDraft).toMatchObject({ text: "steady the flame", restored: true });
    expect(state.payload.path.find((candidate) => candidate.id === "p12")?.text).toBe(node.text);
    expect(state.abort).toBe(null);
  });

  test("a post-commit reload failure surfaces the error without resurrecting the composer", async () => {
    // Fix for issue #277 stage 2 review: once rewriteNode resolves a takeId
    // the take is durable server-side, so a failure past that point must not
    // be treated like a failure before it — there is no draft left to give
    // back, only an error to report.
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    const context = directContext(state);

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    setComposerText(state.composer, "steady the flame");
    source.api.loadStory = async () => { throw new Error("reload failed after the take landed"); };

    await composeAction({ action: "send" }, state, source, context);

    expect(state.toast).toBe("reload failed after the take landed");
    // The take committed server-side; nothing resurrects a composer aimed at
    // the node the new take has already replaced.
    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);
    expect(state.pendingGenerationDraft).toBe(null);
    expect(state.abort).toBe(null);
    expect(state.payload.path.find((candidate) => candidate.id === "p12")?.text).toBe(node.text);
  });

  test("Escape during the post-commit window reports the landing instead of pretending nothing was saved", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    const context = directContext(state);
    const gate = deferred<typeof state.payload>();
    let loadStoryCalled = false;
    source.api.rewriteNode = async () => "committed-take-id";
    source.api.loadStory = async () => {
      loadStoryCalled = true;
      return gate.promise;
    };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    setComposerText(state.composer, "steady the flame");
    const pending = composeAction({ action: "send" }, state, source, context);

    // rewriteNode has resolved, active.committed is set, and loadStory is now
    // in flight — exactly the window requestRewriteStop must treat
    // differently from a pre-commit stop.
    while (!loadStoryCalled) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.abort?.kind).toBe("rewrite");

    requestRewriteStop(state, () => undefined);

    // Nothing to restore and nothing left to cancel — the take already
    // landed. The composer stays closed rather than reopening aimed at a
    // node the new take has already replaced, and the stream stays up while
    // the confirming reload keeps settling behind it.
    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);
    expect(state.toast).toBe("rewrite already saved · finishing up");
    expect(state.stream).not.toBe(null);

    gate.resolve({ ...state.payload, title: "reloaded after commit" });
    await pending;

    expect(state.payload.title).toBe("reloaded after commit");
    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);
    expect(state.pendingGenerationDraft).toBe(null);
    expect(state.stream).toBe(null);
    expect(state.abort).toBe(null);
  });

  test("Fix 1: an adapter that commits and then throws does not resurrect the draft", async () => {
    // The real refresh that can reject sits *inside* rewriteNode (api.ts's
    // confirming reload, worker-story-api.ts's rememberPayload) — a level
    // below where the two tests above observe commitment. This stub
    // reproduces that shape directly: onCommitted fires, then the call
    // itself rejects, exactly the window Fix 1 closes.
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    const context = directContext(state);
    source.api.rewriteNode = async (_storyId, _nodeId, _body, _onDelta, _signal, onCommitted) => {
      onCommitted?.("committed-take-id");
      throw new Error("refresh after commit failed");
    };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    setComposerText(state.composer, "steady the flame");

    await composeAction({ action: "send" }, state, source, context);

    expect(state.toast).toBe("refresh after commit failed");
    // Committed via the hook alone — the post-resolve assignment in
    // runSelectionRewrite is never reached, since the call rejected instead
    // of resolving. The draft must not come back for a node the take has
    // already replaced.
    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);
    expect(state.pendingGenerationDraft).toBe(null);
    expect(state.abort).toBe(null);
  });

  test("Fix 1: Escape after onCommitted but before the adapter resolves reports the rewrite as landed", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    const context = directContext(state);
    const entered = deferred();
    const gate = deferred<string | null>();
    source.api.rewriteNode = async (_storyId, _nodeId, _body, _onDelta, _signal, onCommitted) => {
      onCommitted?.("committed-take-id");
      entered.resolve();
      return gate.promise;
    };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    setComposerText(state.composer, "steady the flame");
    const pending = composeAction({ action: "send" }, state, source, context);
    await entered.promise;

    // onCommitted has already run; the call itself has not returned yet —
    // the same window as "Escape during the post-commit window" above, but
    // reached before rewriteNode's own promise settles rather than after.
    requestRewriteStop(state, () => undefined);

    expect(state.toast).toBe("rewrite already saved · finishing up");
    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);

    gate.resolve("committed-take-id");
    await pending;
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
    source.api.rewriteNode = async () => { called = true; return null; };

    openActions(state, index, "stale selection", [staleSpan]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");

    expect(called).toBeFalse();
    expect(state.toast).toBe("the story changed · highlight it again");
    expect(state.payload.path.find((candidate) => candidate.id === "p12")?.text).toBe(node.text);
    expect(state.stream).toBe(null);
    // A stale selection is caught before a composer ever opens.
    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);
  });

  test("a running stream does not block opening the composer, but refuses the send", async () => {
    // Opening only stages a local composer — the same allowance
    // retake-with-prompt gets (story-actions.ts). composeAction re-checks
    // the guard at send, where it actually matters.
    const { state, source, press } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    state.stream = {
      targetId: "p13", parentId: "p12", append: true,
      startedAt: new Date().toISOString(), instruction: "", text: ""
    };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");

    const context = directContext(state);
    await composeAction({ action: "send" }, state, source, context);
    expect(state.toast).toBe("stream running · esc stops it first · draft kept");
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
  });

  test("an offline connection does not block opening the composer, but refuses the send", async () => {
    const { state, source, press } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    state.connection = { down: true, attempt: 1, nextRetryAt: null, error: null };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");

    const context = directContext(state);
    await composeAction({ action: "send" }, state, source, context);
    expect(state.toast).toBe("offline · draft kept until the connection returns");
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
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

  test("opening the palette with a rewritable selection captures it, Rewrite selection opens the same composer, and an empty submit runs the rewrite", async () => {
    const { state, source, press } = harness();
    focusNode(state, "p12");
    const { node, needle, start, end, span } = rewriteFixture(state);
    state.storySelectionProjection = [{ key: span.key, text: span.text, start: span.start, end: span.end }];
    const p12Index = state.payload.path.findIndex((part) => part.id === "p12");

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

    // The palette route opens the same composer the part menu does — it
    // never fires the rewrite itself.
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent).toEqual({ kind: "rewrite", start, end, expected: node.text.slice(start, end) });
    expect(state.composer.text).toBe("");

    await press("return", "\r");
    await settleStream(state);

    // The rewrite commits as a new take at p12's old position on the path,
    // exactly as running it from the part menu does.
    const takeId = state.payload.path[p12Index]!.id;
    expect(takeId).not.toBe("p12");
    const rewritten = state.payload.path.find((candidate) => candidate.id === takeId)!;
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

  test("Fix 2: the palette's next-request refusal for an open rewrite composer restores COMPOSE instead of stranding NAV", async () => {
    const { state, source, press } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    const context = directContext(state);

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    state.actions!.cursor = currentPartActions(state).findIndex(({ id }) => id === "rewrite-selection");
    await press("return", "\r");
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    setComposerText(state.composer, "steady the flame");

    const handled = await handleOverlayAction({ action: "open-commands" }, state, source, context);
    expect(handled).toBeTrue();
    expect(state.commands?.returnMode).toBe("COMPOSE");

    for (const character of "next request") await press(character, character);
    expect(state.commands?.query).toBe("next request");
    await press("return", "\r");

    // runCommand's own `state.mode = "NAV"` runs before the refusal branch
    // below it; without restoring `returnMode` there, the writer lands in
    // NAV with the rewrite prompt still sitting in state.retakePrompt but no
    // composer visible to show it.
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    expect(state.composer.text).toBe("steady the flame");
    expect(state.toast).toBe("a highlighted rewrite's request is not projected yet");
  });

  test("Fix 3: a dormant draft resumed after a failed rewrite reports itself as a rewrite, not a retake", async () => {
    const { state, source } = harness();
    const index = focusNode(state, "p12");
    const { node, span } = rewriteFixture(state);
    const context = directContext(state);
    const entered = deferred();
    const gate = deferred<string | null>();
    source.api.rewriteNode = async () => {
      entered.resolve();
      return gate.promise;
    };

    openActions(state, index, node.text.slice(span.start, span.end), [span]);
    await runPartAction("rewrite-selection", state, source, context);
    setComposerText(state.composer, "steady the flame");
    const pending = composeAction({ action: "send" }, state, source, context);
    await entered.promise;

    // Any keypress while the request is in flight retires this task's
    // interaction epoch, so `task.interactionCurrent()` reads false when the
    // request fails below — exactly what sends the draft dormant (restored,
    // but not reopened) instead of reopening the composer on the spot.
    beginInteraction(state);
    gate.reject(new Error("provider request failed"));
    await pending;

    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);
    // The dormant wrapper is always `kind: "retake"` — a rewrite session's
    // pending draft has no shape of its own — so this alone must not be
    // read as proof the session it wraps is a retake.
    expect(state.pendingGenerationDraft).toMatchObject({ kind: "retake", restored: true });

    await navAction({ action: "retake-with-prompt" }, state, source, context, () => undefined);

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt?.intent.kind).toBe("rewrite");
    expect(state.composer.text).toBe("steady the flame");
    expect(state.toast).toBe("rewrite draft restored");
  });
});

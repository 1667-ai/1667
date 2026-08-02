import { describe, expect, test } from "bun:test";
import { ActionRuntime, beginInteraction } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import { createComposer, setComposerText } from "../src/composer-model.js";
import {
  capturePendingDirectDraft,
  openDirectComposer,
  openRetakeComposer,
  suspendRetakeComposer
} from "../src/composer-ownership.js";
import { demoAppSource } from "../src/demo.js";
import {
  requestGenerationStop,
  restorePendingGenerationDraft,
  restoreStoppedGenerationDraft
} from "../src/generation-action.js";
import { composeAction, navAction, runPartAction } from "../src/story-actions.js";
import { createStoryViewModel, rowIndexForNode } from "../src/model.js";
import { nextRequestContext } from "../src/request-context.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import type { RuntimeState } from "../src/state.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

const STREAM_STARTED_AT = "2026-07-22T00:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function context(state: RuntimeState) {
  return {
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: null,
    applyTheme: () => undefined,
    previewTheme: () => undefined,
    backend: new ActionRuntime(state, () => undefined)
  };
}

describe("generation draft restoration", () => {
  test("a generation failure restores and reveals its submitted direction", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    state.composer = createComposer("keep this failed direction");
    source.api.continueStory = async () => { throw new Error("provider request failed"); };

    await composeAction({ action: "send" }, state, source, context(state));

    expect(state.composer.text).toBe("keep this failed direction");
    expect(state.mode).toBe("COMPOSE");
    expect(state.toast).toBe("provider request failed");
    expect(state.pendingGenerationDraft).toMatchObject({
      text: "keep this failed direction", restored: true
    });
  });

  test("a failed prompted retake restores its editor without consuming Direct", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.composer = createComposer("unrelated Direct draft");
    const directComposer = state.composer;
    const prompt = openRetakeComposer(state, "p12", "original prompt");
    setComposerText(state.composer, "edited retake prompt");
    source.api.continueStory = async () => { throw new Error("provider request failed"); };

    await composeAction({ action: "send" }, state, source, context(state));

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt).toBe(prompt);
    expect(state.composer).toBe(prompt.composer);
    expect(state.composer.text).toBe("edited retake prompt");
    expect(prompt.returnState.composer).toBe(directComposer);
    expect(prompt.returnState.composer.text).toBe("unrelated Direct draft");
    expect(state.pendingGenerationDraft).toMatchObject({ restored: true });
  });

  test("a failed retake behind another surface stays dormant until R resumes it", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.composer = createComposer("persistent Direct draft");
    const directComposer = state.composer;
    const prompt = openRetakeComposer(state, "p12", "edited failed retake");
    const draft = {
      kind: "retake" as const,
      text: prompt.composer.text,
      retakePrompt: prompt,
      restored: false
    };
    state.pendingGenerationDraft = draft;
    suspendRetakeComposer(state, prompt);
    state.mode = "COMMANDS";

    expect(restorePendingGenerationDraft(state, draft, false)).toBeTrue();
    expect(draft.restored).toBeTrue();
    expect(state.retakePrompt).toBe(null);
    expect(state.composer).toBe(directComposer);

    const targetIndex = rowIndexForNode(createStoryViewModel(state.payload), prompt.nodeId);
    expect(targetIndex).toBeGreaterThan(0);
    state.focusIndex = 0;
    state.viewScroll = 4;
    state.mode = "NAV";
    await navAction(
      { action: "retake-with-prompt" }, state, source, context(state), () => undefined
    );

    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt).toBe(prompt);
    expect(state.composer).toBe(prompt.composer);
    expect(state.composer.text).toBe("edited failed retake");
    expect(prompt.returnState.composer).toBe(directComposer);
    expect(state.focusIndex).toBe(targetIndex);
    expect(state.viewScroll).toBe(null);
    expect(nextRequestContext(state).targetId).toBe(prompt.nodeId);
    const frame = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);
    expect(frame).toContain("compose · ¶ 12");
    expect(frame).toContain("part 12/13");
    expect(state.toast).toBe("retake draft restored");
  });

  test("R resumes a dormant retake even after its active-path target disappears", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.composer = createComposer("persistent Direct draft");
    const prompt = openRetakeComposer(state, "p12", "edited failed retake");
    setComposerText(prompt.composer, "edited failed retake with cursor");
    prompt.composer.cursor = 6;
    const draft = {
      kind: "retake" as const,
      text: prompt.composer.text,
      retakePrompt: prompt,
      restored: true
    };
    state.pendingGenerationDraft = draft;
    suspendRetakeComposer(state, prompt);
    state.payload = {
      ...state.payload,
      path: state.payload.path.filter(({ id }) => id !== prompt.nodeId)
    };
    state.mode = "NAV";

    await navAction(
      { action: "retake-with-prompt" }, state, source, context(state), () => undefined
    );

    expect(state.retakePrompt).toBe(prompt);
    expect(state.composer).toBe(prompt.composer);
    expect(state.composer.text).toBe("edited failed retake with cursor");
    expect(state.composer.cursor).toBe(6);
    const missingFrame = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);
    expect(missingFrame).not.toContain("compose · ¶");
    await composeAction({ action: "send" }, state, source, context(state));
    expect(state.retakePrompt).toBe(prompt);
    expect(state.composer.text).toBe("edited failed retake with cursor");
    expect(state.toast).toBe("that part is no longer available to retake · draft kept");
  });

  test("prompted retake refuses only virtual stream targets", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const entered = deferred<void>();
    const gate = deferred<{ payload: typeof state.payload; droppedFacts: [] }>();
    state.mode = "COMPOSE";
    state.composer = createComposer("make it darker");
    source.api.continueStory = async () => {
      entered.resolve();
      return gate.promise;
    };

    const pending = composeAction({ action: "send" }, state, source, context(state));
    await entered.promise;
    const activeStream = state.stream!;
    const virtualId = activeStream.targetId;
    const submittedDraft = state.pendingGenerationDraft;
    const claimEpoch = state.composerClaimEpoch;
    expect(state.payload.nodes.some(({ id }) => id === virtualId)).toBeFalse();

    await navAction(
      { action: "retake-with-prompt" }, state, source, context(state), () => undefined
    );

    expect(state.mode).toBe("NAV");
    expect(state.retakePrompt).toBe(null);
    expect(state.stream).toBe(activeStream);
    expect(state.pendingGenerationDraft).toBe(submittedDraft);
    expect(state.composerClaimEpoch).toBe(claimEpoch);
    expect(state.toast).toBe("generation still landing · wait before changing this part");

    gate.resolve({ payload: { ...state.payload, title: "virtual stream landed" }, droppedFacts: [] });
    await pending;
    expect(state.payload.title).toBe("virtual stream landed");
    expect(state.stream).toBe(null);

    const appendSource = demoAppSource();
    const appendState = initialState(appendSource, false);
    const leaf = appendState.payload.path.at(-1)!;
    appendState.stream = {
      targetId: leaf.id,
      parentId: leaf.parentId,
      append: true,
      startedAt: STREAM_STARTED_AT,
      instruction: "",
      text: " appended words"
    };
    appendState.focusIndex = rowIndexForNode(
      createStoryViewModel(appendState.payload, appendState.stream),
      leaf.id
    );

    await navAction(
      { action: "retake-with-prompt" }, appendState, appendSource,
      context(appendState), () => undefined
    );

    expect(appendState.mode).toBe("COMPOSE");
    expect(appendState.retakePrompt?.nodeId).toBe(leaf.id);
  });

  test("late success preserves a retake edited after empty-stop restoration", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const gate = deferred<{ payload: typeof state.payload; droppedFacts: [] }>();
    state.composer = createComposer("persistent Direct draft");
    const directComposer = state.composer;
    const prompt = openRetakeComposer(state, "p12", "submitted retake");
    source.api.continueStory = async () => gate.promise;

    const pending = composeAction({ action: "send" }, state, source, context(state));
    while (state.stream === null) await new Promise((resolve) => setTimeout(resolve, 0));
    requestGenerationStop(state, () => undefined);
    beginInteraction(state);
    setComposerText(state.composer, "submitted retake + newer edit");
    await composeAction({ action: "history-previous" }, state, source, context(state));
    expect(state.composer.text).toBe("submitted retake");
    expect(state.historyDraft).toBe("submitted retake + newer edit");

    gate.resolve({ payload: { ...state.payload, title: "authoritative retake landed" }, droppedFacts: [] });
    await pending;

    expect(state.payload.title).toBe("authoritative retake landed");
    expect(state.pendingGenerationDraft).toBe(null);
    expect(state.retakePrompt).toBe(prompt);
    expect(state.composer).toBe(prompt.composer);
    expect(state.composer.text).toBe("submitted retake");
    expect(state.historyDraft).toBe("submitted retake + newer edit");
    expect(prompt.returnState.composer).toBe(directComposer);
  });

  test("late success retires only an unchanged legacy stop retake", async () => {
    const settle = async (editAfterStop: string | null) => {
      const source = demoAppSource();
      const state = initialState(source, false);
      const gate = deferred<{ payload: typeof state.payload; droppedFacts: [] }>();
      state.composer = createComposer();
      const directComposer = state.composer;
      source.api.continueStory = async () => gate.promise;

      const pending = runPartAction("retake", state, source, context(state));
      while (state.stream === null) await new Promise((resolve) => setTimeout(resolve, 0));
      requestGenerationStop(state, () => undefined);
      const restoredPrompt = state.retakePrompt!;
      if (editAfterStop !== null) {
        state.history = [restoredPrompt.composer.text];
        state.historyIndex = state.history.length;
        setComposerText(restoredPrompt.composer, editAfterStop);
        await composeAction({ action: "history-previous" }, state, source, context(state));
      }
      gate.resolve({ payload: { ...state.payload, title: "authoritative retake landed" }, droppedFacts: [] });
      await pending;
      return { state, directComposer, restoredPrompt };
    };

    const unchanged = await settle(null);
    expect(unchanged.state.retakePrompt).toBe(null);
    expect(unchanged.state.composer).toBe(unchanged.directComposer);
    expect(unchanged.state.composer.text).toBe("");

    const edited = await settle("new prompt after stopping");
    expect(edited.state.retakePrompt).toBe(edited.restoredPrompt);
    expect(edited.state.composer).toBe(edited.restoredPrompt.composer);
    expect(edited.state.historyDraft).toBe("new prompt after stopping");
    expect(edited.restoredPrompt.returnState.composer).toBe(edited.directComposer);
  });

  test("legacy retake Stop restores its draft without cancellation chatter", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const entered = deferred<void>();
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p12");
    source.api.continueStory = async (
      _storyId, _instruction, _genId, _target, _onDelta, signal
    ) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return null;
    };

    const pending = runPartAction("retake", state, source, context(state));
    await entered.promise;
    requestGenerationStop(state, () => undefined);
    const restoredPrompt = state.retakePrompt!;

    expect(state.mode).toBe("COMPOSE");
    expect(restoredPrompt.nodeId).toBe("p12");
    expect(state.composer).toBe(restoredPrompt.composer);
    expect(state.toast).toBe(null);

    await pending;

    expect(state.retakePrompt).toBe(restoredPrompt);
    expect(state.composer).toBe(restoredPrompt.composer);
    expect(state.focusIndex).toBe(rowIndexForNode(createStoryViewModel(state.payload), "p12"));
    expect(state.toast).toBe(null);
    const frame = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);
    expect(frame).toContain("compose · ¶ 12");
    expect(frame).toContain("part 12/13");
    expect(frame).not.toContain("model request");
  });

  test("late success clears only an unchanged restored Direct editor", async () => {
    const settle = async (editAfterStop: string | null) => {
      const source = demoAppSource();
      const state = initialState(source, false);
      const gate = deferred<{ payload: typeof state.payload; droppedFacts: [] }>();
      state.mode = "COMPOSE";
      state.composer = createComposer("submitted Direct");
      source.api.continueStory = async () => gate.promise;

      const pending = composeAction({ action: "send" }, state, source, context(state));
      while (state.stream === null) await new Promise((resolve) => setTimeout(resolve, 0));
      requestGenerationStop(state, () => undefined);
      if (editAfterStop !== null) {
        setComposerText(state.composer, editAfterStop);
        await composeAction({ action: "history-previous" }, state, source, context(state));
      } else await composeAction({ action: "cancel" }, state, source, context(state));
      gate.resolve({ payload: { ...state.payload, title: "authoritative Direct landed" }, droppedFacts: [] });
      await pending;
      return state;
    };

    const unchanged = await settle(null);
    expect(unchanged.pendingGenerationDraft).toBe(null);
    expect(unchanged.composer.text).toBe("");
    expect(unchanged.mode).toBe("NAV");

    const edited = await settle("new Direct after stopping");
    expect(edited.pendingGenerationDraft).toBe(null);
    expect(edited.composer.text).toBe("submitted Direct");
    expect(edited.historyDraft).toBe("new Direct after stopping");
  });

  test("canceling an empty-stop retake retires its exact late restoration", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.composer = createComposer("Direct survives the stopped retake");
    const directComposer = state.composer;
    const prompt = openRetakeComposer(state, "p12", "edited retake prompt");
    const draft = {
      kind: "retake" as const,
      text: prompt.composer.text,
      retakePrompt: prompt,
      restored: false
    };
    state.pendingGenerationDraft = draft;
    suspendRetakeComposer(state, prompt);
    state.mode = "NAV";
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), "p5");
    state.viewScroll = 4;
    const stream = {
      targetId: "pending-retake", parentId: "p11", append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: draft.text, text: "", retakeNodeId: prompt.nodeId,
      pendingDraft: draft
    };

    state.stream = stream;
    requestGenerationStop(state, () => undefined);
    expect(state.stream).toBe(null);
    expect(state.retakePrompt).toBe(prompt);
    expect(state.composer).toBe(prompt.composer);
    expect(prompt.returnState.composer).toBe(directComposer);
    expect(rowIndexForNode(createStoryViewModel(state.payload), prompt.nodeId)).toBe(state.focusIndex);
    expect(state.viewScroll).toBe(null);
    expect(nextRequestContext(state).targetId).toBe(prompt.nodeId);
    const frame = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);
    expect(frame).toContain("compose · ¶ 12");
    expect(frame).toContain("part 12/13");
    expect(frame).not.toContain("part 5/13");

    await composeAction({ action: "cancel" }, state, source, context(state));
    expect(state.composer).toBe(directComposer);
    expect(state.retakePrompt).toBe(null);
    expect(state.pendingGenerationDraft).toBe(null);

    expect(restoreStoppedGenerationDraft(state, stream)).toBeFalse();
    expect(state.composer).toBe(directComposer);
    expect(state.retakePrompt).toBe(null);
  });

  test("a null outcome after later navigation restores without stealing focus", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const entered = deferred<void>();
    const gate = deferred<null>();
    state.mode = "COMPOSE";
    state.composer = createComposer("restore without reopening");
    source.api.continueStory = async () => {
      entered.resolve();
      return gate.promise;
    };

    const pending = composeAction({ action: "send" }, state, source, context(state));
    await entered.promise;
    beginInteraction(state);
    state.focusIndex = 0;
    gate.resolve(null);
    await pending;

    expect(state.composer.text).toBe("restore without reopening");
    expect(state.pendingGenerationDraft).toMatchObject({ restored: true });
    expect(state.mode).toBe("NAV");
    expect(state.focusIndex).toBe(0);
  });

  test("instruction-only stop fallback is revealed on unowned NAV", () => {
    const state = initialState(demoAppSource(), false);

    restoreStoppedGenerationDraft(state, {
      targetId: "instruction-only", parentId: "p13", append: false,
      startedAt: STREAM_STARTED_AT,
      composerClaimEpoch: state.composerClaimEpoch,
      instruction: "instruction-only fallback", text: ""
    });

    expect(state.composer.text).toBe("instruction-only fallback");
    expect(state.mode).toBe("COMPOSE");
  });

  test("legacy stop fallback cannot replace a newer or explicitly canceled editor", async () => {
    const stream = (composerClaimEpoch: number) => ({
      targetId: "older-retake", parentId: "p11", append: false,
      startedAt: STREAM_STARTED_AT, composerClaimEpoch,
      instruction: "older retake instruction", text: "", retakeNodeId: "p12"
    });

    const directState = initialState(demoAppSource(), false);
    const directEpoch = directState.composerClaimEpoch;
    openDirectComposer(directState);
    directState.mode = "NAV";
    expect(restoreStoppedGenerationDraft(directState, stream(directEpoch))).toBeFalse();
    expect(directState.retakePrompt).toBe(null);
    expect(directState.composer.text).toBe("");

    const retakeState = initialState(demoAppSource(), false);
    const retakeEpoch = retakeState.composerClaimEpoch;
    const directComposer = retakeState.composer;
    const newerRetake = openRetakeComposer(retakeState, "p11", "");
    retakeState.mode = "NAV";
    expect(restoreStoppedGenerationDraft(retakeState, stream(retakeEpoch))).toBeFalse();
    expect(retakeState.retakePrompt).toBe(newerRetake);
    expect(retakeState.composer).toBe(newerRetake.composer);
    expect(newerRetake.returnState.composer).toBe(directComposer);

    const cancelSource = demoAppSource();
    const cancelState = initialState(cancelSource, false);
    const olderStream = stream(cancelState.composerClaimEpoch);
    cancelState.focusIndex = rowIndexForNode(createStoryViewModel(cancelState.payload), "p5");
    cancelState.viewScroll = 4;
    expect(restoreStoppedGenerationDraft(cancelState, olderStream)).toBeTrue();
    expect(cancelState.retakePrompt?.nodeId).toBe("p12");
    expect(rowIndexForNode(createStoryViewModel(cancelState.payload), "p12")).toBe(cancelState.focusIndex);
    expect(cancelState.viewScroll).toBe(null);
    expect(nextRequestContext(cancelState).targetId).toBe("p12");
    const legacyFrame = frameText(renderStoryScreen(cancelState, { width: 120, height: 36 }).lines);
    expect(legacyFrame).toContain("compose · ¶ 12");
    expect(legacyFrame).toContain("part 12/13");
    expect(legacyFrame).not.toContain("part 5/13");
    await composeAction({ action: "cancel" }, cancelState, cancelSource, context(cancelState));
    expect(cancelState.retakePrompt).toBe(null);
    expect(restoreStoppedGenerationDraft(cancelState, olderStream, false)).toBeFalse();
    expect(cancelState.retakePrompt).toBe(null);
  });

  test("restoration never peels a later transient owner or newer draft", () => {
    const owners: Array<(state: RuntimeState) => void> = [
      (state) => { state.mode = "MAP"; },
      (state) => { state.mode = "FACTS"; },
      (state) => {
        state.mode = "ACTIONS";
        state.actions = { cursor: 0, partId: "p13", selectionText: null };
      },
      (state) => {
        state.prune = {
          kind: "subtree", nodeId: "p13", part: 13, take: 1,
          takeCount: 1, parts: 1, lines: 1, tags: []
        };
      },
      (state) => { state.chapterDeleteArmedId = "chapter-break-1"; }
    ];
    for (const own of owners) {
      const state = initialState(demoAppSource(), false);
      const draft = capturePendingDirectDraft(state, "restored direction");
      state.pendingGenerationDraft = draft;
      own(state);
      const mode = state.mode;

      expect(restorePendingGenerationDraft(state, draft)).toBeTrue();
      expect(state.composer.text).toBe(draft.text);
      expect(state.mode).toBe(mode);
    }

    const state = initialState(demoAppSource(), false);
    const draft = capturePendingDirectDraft(state, "older direction");
    state.pendingGenerationDraft = draft;
    state.mode = "COMPOSE";
    state.composer = createComposer("newer direction");
    expect(restorePendingGenerationDraft(state, draft)).toBeFalse();
    expect(state.composer.text).toBe("newer direction");
    expect(state.pendingGenerationDraft).toBe(null);
  });

  test("Direct restoration cannot overwrite a newer empty Direct or retake claim", () => {
    const explicitDirect = initialState(demoAppSource(), false);
    const olderDirect = capturePendingDirectDraft(explicitDirect, "older Direct");
    explicitDirect.pendingGenerationDraft = olderDirect;
    setComposerText(explicitDirect.composer, "");
    openDirectComposer(explicitDirect);
    expect(restorePendingGenerationDraft(explicitDirect, olderDirect)).toBeFalse();
    expect(explicitDirect.composer.text).toBe("");

    const promptedRetake = initialState(demoAppSource(), false);
    const submittedDirect = capturePendingDirectDraft(promptedRetake, "older Direct");
    promptedRetake.pendingGenerationDraft = submittedDirect;
    setComposerText(promptedRetake.composer, "");
    const newerRetake = openRetakeComposer(promptedRetake, "p11", "");
    expect(restorePendingGenerationDraft(promptedRetake, submittedDirect)).toBeFalse();
    expect(promptedRetake.retakePrompt).toBe(newerRetake);
    expect(promptedRetake.composer).toBe(newerRetake.composer);
    expect(promptedRetake.composer.text).toBe("");
  });

  test("late settlement cannot resurrect a restored Direct draft the writer deleted", () => {
    const state = initialState(demoAppSource(), false);
    const draft = capturePendingDirectDraft(state, "submitted direction");
    state.pendingGenerationDraft = draft;

    expect(restorePendingGenerationDraft(state, draft)).toBeTrue();
    expect(state.composer.text).toBe(draft.text);
    setComposerText(state.composer, "");

    expect(restorePendingGenerationDraft(state, draft, false)).toBeFalse();
    expect(state.composer.text).toBe("");
    expect(state.pendingGenerationDraft).toBe(null);
  });
});

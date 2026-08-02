import { createComposer } from "./composer-model.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import type { PendingGenerationDraft, PromptIntent, RetakePromptSession, RuntimeState } from "./state.js";
import { followStoryViewport } from "./viewport-intent.js";

export type ComposerOwnershipState = Pick<RuntimeState,
  "mode" | "composer" | "composerScrollTop" | "history" | "historyIndex"
  | "historyDraft" | "retakePrompt" | "pendingGenerationDraft" | "composerClaimEpoch"
>;

type RetakeFocusState = Pick<RuntimeState,
  "payload" | "stream" | "focusIndex" | "viewScroll" | "viewScrollDelta"
>;

/** Resume the persistent Direct editor. Explicit Direct ownership also retires
 * a pending retake so late settlement cannot resurrect it. */
export function resumeDirectComposer(
  state: ComposerOwnershipState,
  expected: RetakePromptSession | null = state.retakePrompt,
  retirePending = true
): boolean {
  const prompt = state.retakePrompt;
  if (expected !== null && prompt !== expected) return false;
  if (prompt !== null) {
    const returning = prompt.returnState;
    state.retakePrompt = null;
    state.composer = returning.composer;
    state.composerScrollTop = returning.composerScrollTop;
    state.historyIndex = returning.historyWasLive
      ? state.history.length
      : Math.min(returning.historyIndex, state.history.length);
    state.historyDraft = returning.historyDraft;
  }
  if (retirePending && state.pendingGenerationDraft?.kind === "retake") {
    state.pendingGenerationDraft = null;
  }
  return prompt !== null;
}

export function openDirectComposer(state: ComposerOwnershipState): void {
  claimDirectComposer(state);
  state.mode = "COMPOSE";
}

export function capturePendingDirectDraft(
  state: ComposerOwnershipState,
  text: string
): Extract<PendingGenerationDraft, { kind: "direct" }> {
  return {
    kind: "direct",
    text,
    composer: state.composer,
    composerClaimEpoch: state.composerClaimEpoch,
    cursor: state.composer.cursor,
    fullscreen: state.composer.fullscreen,
    composerScrollTop: state.composerScrollTop,
    restored: false
  };
}

/** Record an explicit choice of the persistent Direct editor. Internal
 * suspension/settlement uses resumeDirectComposer directly and does not claim. */
export function claimDirectComposer(state: ComposerOwnershipState): boolean {
  const resumed = resumeDirectComposer(state);
  state.composerClaimEpoch += 1;
  return resumed;
}

export function openRetakeComposer(
  state: ComposerOwnershipState & RetakeFocusState,
  nodeId: string,
  instruction: string,
  intent: PromptIntent
): RetakePromptSession {
  resumeDirectComposer(state);
  const prompt = createRetakeSession(state, nodeId, instruction, intent);
  revealRetakeComposer(state, prompt);
  state.composerClaimEpoch += 1;
  return prompt;
}

/** Explicitly reclaim a dormant failed retake without treating async
 * restoration itself as fresh writer input. */
export function resumeRetakeComposer(
  state: ComposerOwnershipState & RetakeFocusState,
  prompt: RetakePromptSession
): void {
  revealRetakeComposer(state, prompt);
  state.composerClaimEpoch += 1;
}

/** Move a submitted retake offscreen while its exact pending draft owns it. */
export function suspendRetakeComposer(state: ComposerOwnershipState, prompt: RetakePromptSession): boolean {
  if (state.retakePrompt === prompt) prompt.composerScrollTop = state.composerScrollTop;
  return resumeDirectComposer(state, prompt, false);
}

/** Restore a failed/stopped prompt without touching its saved Direct editor. */
function activateRetakeComposer(state: ComposerOwnershipState, prompt: RetakePromptSession): void {
  if (state.retakePrompt !== prompt && state.composer !== prompt.composer) {
    prompt.returnState = captureReturnState(state);
  }
  state.retakePrompt = prompt;
  state.composer = prompt.composer;
  state.composerScrollTop = prompt.composerScrollTop;
  state.historyIndex = state.history.length;
  state.historyDraft = null;
}

/** A visible retake owns both its editor and the story focus used by chrome and
 * next-request projection. Missing targets remain recoverable without lying. */
export function revealRetakeComposer(
  state: ComposerOwnershipState & RetakeFocusState,
  prompt: RetakePromptSession
): boolean {
  activateRetakeComposer(state, prompt);
  const focused = focusVisibleRetakeTarget(state, prompt);
  state.mode = "COMPOSE";
  return focused;
}

/** Re-assert target focus after a stream row-set transition without touching
 * editor/history ownership. */
export function focusVisibleRetakeTarget(
  state: RetakeFocusState,
  prompt: RetakePromptSession
): boolean {
  const targetIndex = rowIndexForNode(createStoryViewModel(state.payload, state.stream), prompt.nodeId);
  if (targetIndex < 0) return false;
  state.focusIndex = targetIndex;
  followStoryViewport(state);
  return true;
}

/** Bind a restored legacy/implicit retake draft to the same atomic model.
 *  Only `generate()`'s own stopped-stream reconstruction calls this, and it
 *  only ever rebuilds a retake — a rewrite never threads through that path. */
export function createRestoredRetakeComposer(
  state: ComposerOwnershipState,
  nodeId: string,
  instruction: string,
  intent: PromptIntent
): RetakePromptSession {
  const prompt = createRetakeSession(state, nodeId, instruction, intent);
  activateRetakeComposer(state, prompt);
  return prompt;
}

function createRetakeSession(
  state: ComposerOwnershipState,
  nodeId: string,
  instruction: string,
  intent: PromptIntent
): RetakePromptSession {
  return {
    nodeId,
    intent,
    composer: createComposer(instruction),
    composerScrollTop: 0,
    returnState: captureReturnState(state)
  };
}

function captureReturnState(state: ComposerOwnershipState): RetakePromptSession["returnState"] {
  return {
    composer: state.composer,
    composerScrollTop: state.composerScrollTop,
    historyIndex: state.historyIndex,
    historyDraft: state.historyDraft,
    historyWasLive: state.historyIndex === state.history.length
  };
}

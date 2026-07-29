import type { StoryNode, StoryPayload } from "../../shared/types.js";
import type { ActionTask } from "./action-runtime.js";
import { textHash } from "./api.js";
import type { AppSource } from "./app.js";
import { setComposerText } from "./composer-model.js";
import {
  createRestoredRetakeComposer,
  focusVisibleRetakeTarget,
  revealRetakeComposer,
  resumeDirectComposer
} from "./composer-ownership.js";
import { continuationIntent } from "./continuation-intent.js";
import { isPlainNavigation } from "./keys.js";
import { createStoryViewModel, lastPartRowIndex, rowIndexForNode, rowPart } from "./model.js";
import type { PendingGenerationDraft, RuntimeState, StoryScreenState, StreamView } from "./state.js";
import {
  adoptSameStoryPayload,
  captureStoryFocus,
  reconcileMapNavigation,
  reconcileStoryActions,
  restoreStoryFocus
} from "./story-adoption.js";
import type { ProseStyle, WrapCache } from "./wrap.js";
import { followStoryViewport } from "./viewport-intent.js";
import { rememberFocus } from "./reading-position-persist.js";
import {
  appendStreamText,
  emptyStreamText,
  streamHasSubstantiveText,
  streamTrimmedText
} from "./stream-text.js";

/** Generation owns the line from the pre-stream claim through adoption. */
export function generationBusy(state: Pick<StoryScreenState, "stream" | "abort">): boolean {
  return state.stream !== null || state.abort?.kind === "generation";
}

/** Escape hides the transient stream now; its task keeps the abort fence. */
export function requestGenerationStop(state: RuntimeState, repaint: () => void): void {
  const active = state.abort?.kind === "generation" ? state.abort : null;
  if (active === null && state.stream === null) return;
  const stream = state.stream;
  const focus = captureStoryFocus(state);
  const restoredDraft = stream !== null
    && !streamHasSubstantiveText(stream)
    && restoreStoppedGenerationDraft(state, stream, true);
  active?.controller.abort();
  state.stream = null;
  restoreStoryFocus(state, focus);
  if (restoredDraft && state.mode === "COMPOSE" && state.retakePrompt !== null) {
    focusVisibleRetakeTarget(state, state.retakePrompt);
  }
  reconcileStoryActions(state);
  reconcileMapNavigation(state);
  state.toast = null;
  repaint();
}

export async function generate(
  state: RuntimeState,
  source: AppSource,
  cache: WrapCache<ProseStyle>,
  repaint: () => void,
  instruction: string,
  regenerateNode: StoryNode | null,
  pendingDraft: PendingGenerationDraft | null,
  task: ActionTask
): Promise<void> {
  if (state.abort !== null) return;
  const controller = new AbortController();
  const active = { kind: "generation" as const, controller };
  state.abort = active;
  const signal = controller.signal;
  const storyId = task.storyId;
  const composerClaimEpoch = state.composerClaimEpoch;
  const owns = task.owns;
  const storyCurrent = task.storyCurrent;
  const interactionCurrent = task.interactionCurrent;
  let stopInteractionVersion: number | null = null;
  signal.addEventListener("abort", () => {
    stopInteractionVersion = state.interactionVersion;
  }, { once: true });
  const restorationMayOwnFocus = () => interactionCurrent()
    || (stopInteractionVersion !== null
      && state.interactionVersion === stopInteractionVersion);
  const focusPart = rowPart(createStoryViewModel(state.payload), state.focusIndex);
  const intent = continuationIntent(state.payload, focusPart?.id ?? null, instruction, regenerateNode);
  const path = state.payload.path;
  const leaf = intent.leaf;
  const fromSeam = intent.fromSeam;
  // A chapter boundary turns an empty Continue into a new child. Mirror that
  // effective server shape while streaming so the text appears below the
  // divider instead of temporarily extending the closed chapter.
  const append = intent.appendLast;
  const targetId = append ? leaf!.id : `stream-${crypto.randomUUID()}`;
  const genId = crypto.randomUUID();
  let appendBaseHash: string | undefined;
  try {
    appendBaseHash = append ? await textHash(leaf!.text) : undefined;
  } catch (error) {
    if (state.abort === active) state.abort = null;
    if (signal.aborted) {
      restorePendingGenerationDraft(
        state,
        pendingDraft,
        restorationMayOwnFocus()
      );
    } else if (owns() && storyCurrent()) {
      restorePendingGenerationDraft(
        state,
        pendingDraft,
        restorationMayOwnFocus()
      );
      state.toast = error instanceof Error ? error.message : String(error);
    }
    return repaint();
  }
  if (signal.aborted || !owns() || !storyCurrent()) {
    if (state.abort === active) state.abort = null;
    if (signal.aborted) {
      restorePendingGenerationDraft(
        state,
        pendingDraft,
        restorationMayOwnFocus()
      );
    }
    return repaint();
  }
  const parentId = intent.parentId;
  const virtualNumber = regenerateNode !== null
    ? path.findIndex((node) => node.id === regenerateNode.id) + 1
    : fromSeam ? intent.focusPathIndex + 2 : undefined;
  const stream: StreamView = {
    targetId,
    parentId,
    append,
    startedAt: new Date().toISOString(),
    composerClaimEpoch,
    instruction,
    ...emptyStreamText(),
    genId,
    ...(pendingDraft === null ? {} : { pendingDraft }),
    ...(appendBaseHash === undefined ? {} : { appendBaseHash }),
    ...(virtualNumber === undefined ? {} : { partNumber: virtualNumber }),
    ...(regenerateNode === null ? {} : { retakeNodeId: regenerateNode.id })
  };
  const preStreamFocus = captureStoryFocus(state);
  state.stream = stream;
  const previousFocus = state.focusIndex;
  let adopted = false;
  let preserveStoppedStream = false;
  const streamingView = createStoryViewModel(state.payload, stream);
  const targetRow = rowIndexForNode(streamingView, targetId);
  if (interactionCurrent()) {
    state.focusIndex = targetRow < 0 ? lastPartRowIndex(streamingView) : targetRow;
    followStoryViewport(state);
  } else restoreStoryFocus(state, preStreamFocus);
  repaint();
  try {
    const apiTarget = append
      ? { appendTo: leaf!.id, expectedTextHash: appendBaseHash! }
      : { parentId };
    const updated = await source.api.continueStory(
      storyId,
      instruction,
      genId,
      apiTarget,
      (delta) => {
        if (!owns()
          || !storyCurrent()
          || (state.stream !== stream && !signal.aborted)) return;
        appendStreamText(stream, delta);
        // Content identity makes exact reads miss while the completed prior
        // entry remains available for resumable append-prefix reuse.
        if (state.stream === stream) repaint();
      },
      signal
    );
    if (updated !== null && storyCurrent()) {
      adoptSameStoryPayload(state, updated);
      const landed = new Map(state.freshLandedAt);
      const landedId = updated.path.at(-1)?.id;
      if (landedId !== undefined) landed.set(landedId, Date.now());
      state.freshLandedAt = landed;
      if (interactionCurrent()) {
        state.focusIndex = lastPartRowIndex(createStoryViewModel(updated));
        rememberFocus(state, source);
      }
      adopted = true;
      clearPendingGenerationDraft(state, pendingDraft, stream);
    }
  } catch (error) {
    if (!signal.aborted && storyCurrent()) {
      restorePendingGenerationDraft(
        state,
        pendingDraft,
        restorationMayOwnFocus()
      );
      state.toast = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (signal.aborted
      && owns()
      && storyCurrent()
      && !adopted) {
      const settlement = await settleStoppedGeneration(
        state,
        source,
        stream,
        pendingDraft,
        storyId,
        storyCurrent,
        interactionCurrent,
        restorationMayOwnFocus
      );
      adopted = settlement.adopted;
      preserveStoppedStream = settlement.preserveStream;
    } else if (!adopted) {
      restorePendingGenerationDraft(
        state,
        pendingDraft,
        restorationMayOwnFocus()
      );
    }
    if (state.abort === active) state.abort = null;
    if (state.stream === stream && !preserveStoppedStream) {
      const focus = captureStoryFocus(state);
      state.stream = null;
      restoreStoryFocus(state, focus);
      reconcileStoryActions(state);
      reconcileMapNavigation(state);
    }
    if (!adopted && interactionCurrent()) {
      state.focusIndex = Math.min(previousFocus, Math.max(0, createStoryViewModel(state.payload).rows.length - 1));
    }
    cache.invalidate();
    repaint();
  }
}

/** Restore the exact submitted direction and optionally return focus to it. */
export function restorePendingGenerationDraft(
  state: RuntimeState,
  draft: PendingGenerationDraft | null,
  revealIfUnclaimed = true
): boolean {
  if (draft === null || state.pendingGenerationDraft !== draft) return false;
  if (draft.kind === "retake") {
    const retakePrompt = draft.retakePrompt;
    if (state.retakePrompt !== null && state.retakePrompt !== retakePrompt) {
      state.pendingGenerationDraft = null;
      return false;
    }
    if (state.retakePrompt === null) {
      // A visible Direct composer is a newer owner. A transient surface keeps
      // the failed retake dormant until the writer explicitly resumes it.
      if (state.mode === "COMPOSE") {
        state.pendingGenerationDraft = null;
        return false;
      }
      draft.restored = true;
      if (!revealIfUnclaimed || !isPlainNavigation(state)) return true;
    }
    draft.restored = true;
    if (revealIfUnclaimed && isPlainNavigation(state)) revealRetakeComposer(state, retakePrompt);
    return true;
  }
  if (state.composer !== draft.composer
    || state.composerClaimEpoch !== draft.composerClaimEpoch
    || state.retakePrompt !== null) {
    state.pendingGenerationDraft = null;
    return false;
  }
  if (state.composer.text.length > 0 && state.composer.text !== draft.text) {
    state.pendingGenerationDraft = null;
    return false;
  }
  if (draft.restored && state.composer.text.length === 0) {
    state.pendingGenerationDraft = null;
    return false;
  }
  draft.restored = true;
  if (state.composer.text.length === 0) {
    setComposerText(state.composer, draft.text);
    state.composer.cursor = draft.cursor;
    state.composer.fullscreen = draft.fullscreen;
    state.composerScrollTop = draft.composerScrollTop;
    // Mode restoration is focus transfer, not merely data recovery. Claim it
    // only as the direct result of this request while the original NAV screen
    // is otherwise untouched; late input and transient surfaces keep focus.
    if (revealIfUnclaimed && isPlainNavigation(state)) state.mode = "COMPOSE";
  }
  return true;
}

/** Return an empty stopped request to the composer without taking ownership
 * from a newer direction the user wrote while that request was in flight. */
export function restoreStoppedGenerationDraft(
  state: RuntimeState,
  stream: StreamView | null,
  revealIfUnclaimed = true
): boolean {
  // An abort in generate's pre-stream await has no StreamView yet; generate's
  // finally block still holds and restores that request's exact draft object.
  if (stream === null) return false;
  if (stream.pendingDraft !== undefined) {
    return restorePendingGenerationDraft(state, stream.pendingDraft, revealIfUnclaimed);
  }
  const olderDraft = state.pendingGenerationDraft;
  if (olderDraft?.kind === "direct" && state.composer.text !== olderDraft.text) {
    state.pendingGenerationDraft = null;
  }
  if (state.retakePrompt === null
    && state.pendingGenerationDraft === null
    && stream.composerClaimEpoch === state.composerClaimEpoch
    && state.composer.text.length === 0
    && (stream.instruction.trim().length > 0 || stream.retakeNodeId !== undefined)) {
    if (stream.retakeNodeId === undefined) {
      setComposerText(state.composer, stream.instruction);
      if (revealIfUnclaimed && isPlainNavigation(state)) state.mode = "COMPOSE";
    } else {
      const restoredRetake = createRestoredRetakeComposer(
        state, stream.retakeNodeId, stream.instruction
      );
      stream.restoredRetakePrompt = restoredRetake;
      if (revealIfUnclaimed && isPlainNavigation(state)) {
        revealRetakeComposer(state, restoredRetake);
      }
    }
    return true;
  }
  return false;
}

async function settleStoppedGeneration(
  state: RuntimeState,
  source: AppSource,
  stream: StreamView,
  pendingDraft: PendingGenerationDraft | null,
  storyId: string,
  storyCurrent: () => boolean,
  interactionCurrent: () => boolean,
  restorationMayOwnFocus: () => boolean
): Promise<{
  readonly adopted: boolean;
  readonly preserveStream: boolean;
}> {
  const substantive = streamHasSubstantiveText(stream);
  const text = stream.append ? stream.text : streamTrimmedText(stream);
  try {
    let payload: StoryPayload;
    if (!substantive) {
      payload = await source.api.loadStory(storyId);
    } else {
      const genId = stream.genId;
      if (genId === undefined) throw new Error("Stopped generation lost its identity");
      if (stream.append) {
        const expectedTextHash = stream.appendBaseHash;
        if (expectedTextHash === undefined) throw new Error("Stopped append lost its source hash");
        payload = await source.api.createNode(storyId, {
          appendTo: stream.targetId,
          expectedTextHash,
          instruction: stream.instruction,
          text,
          genId
        });
      } else {
        payload = await source.api.createNode(storyId, {
          parentId: stream.parentId,
          instruction: stream.instruction,
          text,
          genId
        });
      }
    }
    if (!storyCurrent()) {
      return { adopted: false, preserveStream: false };
    }
    adoptSameStoryPayload(state, payload);
    if (!substantive) {
      restoreStoppedGenerationDraft(
        state,
        stream,
        restorationMayOwnFocus()
      );
    }
    if (substantive) clearPendingGenerationDraft(state, pendingDraft, stream);
    if (interactionCurrent() && substantive) {
      state.focusIndex = lastPartRowIndex(createStoryViewModel(payload));
      rememberFocus(state, source);
    }
    return { adopted: true, preserveStream: false };
  } catch (error) {
    if (!storyCurrent()) {
      return { adopted: false, preserveStream: false };
    }
    const payload = await source.api.loadStory(storyId).catch(() => null);
    const adopted = payload !== null && storyCurrent();
    if (adopted) adoptSameStoryPayload(state, payload);
    if (substantive) {
      state.stream = stream;
    }
    restorePendingGenerationDraft(
      state,
      pendingDraft,
      restorationMayOwnFocus()
    );
    if (restorationMayOwnFocus() && storyCurrent()) {
      state.toast = error instanceof Error ? error.message : String(error);
    }
    return { adopted, preserveStream: substantive };
  }
}

function clearPendingGenerationDraft(
  state: RuntimeState,
  draft: PendingGenerationDraft | null,
  stream?: StreamView
): void {
  if (stream?.restoredRetakePrompt !== undefined) {
    const restoredPrompt = stream.restoredRetakePrompt;
    if (state.retakePrompt === restoredPrompt
      && restoredPrompt.composer.text === stream.instruction
      && state.historyDraft === null) {
      resumeDirectComposer(state, restoredPrompt, false);
    }
    delete stream.restoredRetakePrompt;
  }
  if (draft === null || state.pendingGenerationDraft !== draft) return;
  if (draft.kind === "direct") {
    const unchangedRestoredOwner = draft.restored
      && state.composer === draft.composer
      && state.composerClaimEpoch === draft.composerClaimEpoch
      && state.retakePrompt === null
      && state.composer.text === draft.text
      && state.historyDraft === null;
    if (unchangedRestoredOwner) {
      setComposerText(state.composer, "");
      state.composer.fullscreen = false;
      state.composerScrollTop = 0;
    }
    state.pendingGenerationDraft = null;
    return;
  }
  if (draft.kind === "retake" && state.retakePrompt === draft.retakePrompt) {
    const promptEditedAfterRestore = draft.restored
      && (draft.retakePrompt.composer.text !== draft.text || state.historyDraft !== null);
    if (!promptEditedAfterRestore) resumeDirectComposer(state, draft.retakePrompt, false);
  }
  state.pendingGenerationDraft = null;
}

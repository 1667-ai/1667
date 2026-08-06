import type { CreateNodeRequest, StoryNode, StoryPayload } from "../../shared/types.js";
import { isTimeoutClassFailure } from "../../shared/failure-envelope.js";
import type { ActionTask } from "./action-runtime.js";
import { ApiFailureError } from "./api-error.js";
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
import { factDropNotice } from "./facts-model.js";
import { isPlainNavigation } from "./keys.js";
import { createStoryViewModel, lastPartRowIndex, rowIndexForNode, rowPart } from "./model.js";
import { recordNotice } from "./notice-log.js";
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
  if (active !== null) {
    active.stopInteractionVersion = state.interactionVersion;
    active.controller.abort();
  }
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

/** Matches exactly the failures whose envelope carries a clean-timeout
 *  provenance stamp (issue #345): the worker request deadline, the provider
 *  idle/total/header/first-token deadlines, and the HTTP operation lease
 *  deadline. `isTimeoutClassFailure` (shared/failure-envelope.ts) is a
 *  positive allowlist over that one `timeout` field — no status/code
 *  inference, no message matching.
 *
 *  Only the code that owns a deadline stamps the field, and only when the
 *  deadline itself is the whole failure. A timeout that masks a different
 *  rejection — an exact-echo rejection racing a worker deadline
 *  (server/worker-request-cancellation.ts builds that as a
 *  `DiagnosticServiceError` without the stamp), or a provider timeout after
 *  the echo contract already failed (server/generation-http.ts rethrows the
 *  rejection) — arrives without provenance and takes the plain
 *  restore-and-toast path, because committing that prose would durably save
 *  output the server refused. A new failure type defaults to *not* matching
 *  here. */
export function isTimeoutClassApiFailure(error: unknown): boolean {
  return error instanceof ApiFailureError
    && isTimeoutClassFailure(error.failure);
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
  const active = {
    kind: "generation" as const,
    controller,
    stopInteractionVersion: null as number | null
  };
  state.abort = active;
  const signal = controller.signal;
  const storyId = task.storyId;
  const composerClaimEpoch = state.composerClaimEpoch;
  const owns = task.owns;
  const storyCurrent = task.storyCurrent;
  const interactionCurrent = task.interactionCurrent;
  const settlementMayOwnFocus = () => interactionCurrent()
    || (active.stopInteractionVersion !== null
      && state.interactionVersion === active.stopInteractionVersion);
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
        settlementMayOwnFocus()
      );
    } else if (owns() && storyCurrent()) {
      restorePendingGenerationDraft(
        state,
        pendingDraft,
        settlementMayOwnFocus()
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
        settlementMayOwnFocus()
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
  // Set only for a genuine failure (not the writer's Escape) that leaves
  // substantive prose behind.
  let failedWithText: string | null = null;
  try {
    const apiTarget = append
      ? { appendTo: leaf!.id, expectedTextHash: appendBaseHash! }
      : { parentId };
    const result = await source.api.continueStory(
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
      signal,
      // Text that arrived after Stop: the transport withholds it from
      // onDelta and hands the whole tail here at terminal settlement, so
      // the stopped-generation commit below still saves every byte the
      // server delivered.
      (tail) => {
        if (!owns() || !storyCurrent()) return;
        appendStreamText(stream, tail);
        if (state.stream === stream) repaint();
      }
    );
    if (result !== null && storyCurrent()) {
      const updated = result.payload;
      adoptSameStoryPayload(state, updated, cache);
      const landed = new Map(state.freshLandedAt);
      const landedId = updated.path.at(-1)?.id;
      if (landedId !== undefined) landed.set(landedId, Date.now());
      state.freshLandedAt = landed;
      focusLandedGeneration(state, source, updated, settlementMayOwnFocus());
      adopted = true;
      clearPendingGenerationDraft(state, pendingDraft, stream);
      // Admission's real, post-shedding drop set — not the pre-flight guess
      // the context meter shows before the request is sent (see issue #281
      // review finding C). A toast is the one honest way to say what this
      // specific request actually dropped, after the fact.
      const notice = factDropNotice(result.droppedFacts);
      if (notice !== null) state.toast = notice;
    }
  } catch (error) {
    if (!signal.aborted && storyCurrent()) {
      const message = error instanceof Error ? error.message : String(error);
      // A rejection this late that isTimeoutClassApiFailure positively
      // identifies as a clean timeout — never the writer's Escape — still
      // leaves prose in `stream.text` that is exactly as real as a Stop's,
      // and just as worth keeping (issues #326/#345). Everything else,
      // including a provider outright rejecting the continuation, takes the
      // plain restore-and-toast path below — see isTimeoutClassApiFailure's
      // own comment for why this is an allowlist, not a denylist.
      if (streamHasSubstantiveText(stream) && isTimeoutClassApiFailure(error)) {
        failedWithText = message;
      } else {
        restorePendingGenerationDraft(
          state,
          pendingDraft,
          settlementMayOwnFocus()
        );
        state.toast = message;
      }
    }
  } finally {
    if ((signal.aborted || failedWithText !== null)
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
        settlementMayOwnFocus,
        cache
      );
      adopted = settlement.adopted;
      preserveStoppedStream = settlement.preserveStream;
      // This block must never overwrite settle's own toast — it is the one
      // actionable message the writer needs.
      if (failedWithText !== null && storyCurrent()) {
        const notice = settlement.committed
          ? `${failedWithText} · generation stopped · text kept`
          : failedWithText;
        // recordNotices only sweeps state.toast into the C-37 log when the
        // channel's value changes (notice-log.ts), so a toast this settlement
        // never owns focus to show is never recorded anywhere either. A
        // 30-minute deadline is likeliest to fire exactly when the writer has
        // walked away or moved on — precisely when settlement no longer owns
        // focus. Set the toast or record the notice directly, never both: a
        // shown toast is already swept into the log by the app's own repaint
        // (recordSessionNotices, app.ts), so recording it here too would be a
        // second, duplicate entry for the one fact this branch has to say.
        if (settlement.committed && settlementMayOwnFocus()) state.toast = notice;
        else recordNotice(state.notices, "toast", notice);
      }
    } else if (!adopted) {
      restorePendingGenerationDraft(
        state,
        pendingDraft,
        settlementMayOwnFocus()
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
        state, stream.retakeNodeId, stream.instruction, { kind: "retake" }
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
  settlementMayOwnFocus: () => boolean,
  cache: WrapCache<ProseStyle>
): Promise<{
  readonly adopted: boolean;
  readonly preserveStream: boolean;
  /** True only when this call's own createNode actually committed the
   *  streamed text. `adopted` is not a substitute for this: the catch
   *  branch below can also report `adopted: true` when its loadStory
   *  fallback succeeds after a failed commit, and in that case nothing
   *  was durably saved — the caller's "text kept" toast/notice must gate
   *  on this flag, never on `adopted`. */
  readonly committed: boolean;
}> {
  const substantive = streamHasSubstantiveText(stream);
  const text = stream.append ? stream.text : streamTrimmedText(stream);
  // A story-mutation gate rejects every other mutating call while a
  // recovery warning is outstanding (tui/src/worker-transport.ts's
  // `beginCall`) — including this one, if a deadline (or any other stopped
  // generation) happens to land while an unrelated warning is still
  // unresolved. This commit is exactly the kind of mutation
  // RecoveryWarningFeed.runRecoveryMutation exists to admit: it resolves
  // this generation by landing its own already-streamed text under its own
  // genId, the same idempotent, hash-guarded commit any other stopped
  // generation uses. Without this, the commit fails, the stream stays
  // preserved for display, and recovery's own reconciliation refuses to run
  // while a stream is visible (recovery-orchestration.ts's
  // `refreshAfterRecovery`) — a deadlock, not a discard. `demoAppSource`
  // (used by this file's tests) has no `backendRecovery`, so the fallback
  // calls `source.api.createNode` directly, matching every other caller of
  // this pattern (see retireUnknownGenerations and loadReconciliationTarget
  // in recovery-orchestration.ts).
  const commitNode = (body: CreateNodeRequest) =>
    source.backendRecovery?.runRecoveryMutation(() => source.api.createNode(storyId, body))
      ?? source.api.createNode(storyId, body);
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
        payload = await commitNode({
          appendTo: stream.targetId,
          expectedTextHash,
          instruction: stream.instruction,
          text,
          genId
        });
      } else {
        payload = await commitNode({
          parentId: stream.parentId,
          instruction: stream.instruction,
          text,
          genId
        });
      }
    }
    if (!storyCurrent()) {
      return { adopted: false, preserveStream: false, committed: substantive };
    }
    adoptSameStoryPayload(state, payload, cache);
    if (!substantive) {
      restoreStoppedGenerationDraft(
        state,
        stream,
        settlementMayOwnFocus()
      );
    }
    if (substantive) clearPendingGenerationDraft(state, pendingDraft, stream);
    if (substantive) {
      focusLandedGeneration(state, source, payload, settlementMayOwnFocus());
    }
    return { adopted: true, preserveStream: false, committed: substantive };
  } catch (error) {
    if (!storyCurrent()) {
      return { adopted: false, preserveStream: false, committed: false };
    }
    const payload = await source.api.loadStory(storyId).catch(() => null);
    const adopted = payload !== null && storyCurrent();
    if (adopted) adoptSameStoryPayload(state, payload, cache);
    if (substantive) {
      state.stream = stream;
    }
    restorePendingGenerationDraft(
      state,
      pendingDraft,
      settlementMayOwnFocus()
    );
    const message = error instanceof Error ? error.message : String(error);
    // Set the toast or record the notice directly, never both: a shown
    // toast is already swept into the C-37 log by the app's own repaint
    // (recordSessionNotices, app.ts), so recording it here too would be a
    // second, duplicate entry for the one fact this branch has to say. The
    // writer still needs to learn a stopped generation's recovery save also
    // failed even when nothing shows it, since its prose is still sitting,
    // undurable, in state.stream — this does not change what a
    // user-initiated Stop displays, only what its failure leaves behind.
    if (settlementMayOwnFocus() && storyCurrent()) {
      state.toast = message;
    } else {
      recordNotice(state.notices, "toast", message);
    }
    return { adopted, preserveStream: substantive, committed: false };
  }
}

/** Focus a landed generation only while the request or its Stop action is
 * still the latest writer interaction. */
function focusLandedGeneration(
  state: RuntimeState,
  source: AppSource,
  payload: StoryPayload,
  mayOwnFocus: boolean
): void {
  if (!mayOwnFocus) return;
  state.focusIndex = lastPartRowIndex(createStoryViewModel(payload));
  rememberFocus(state, source);
}

/** Exported so the rewrite composer's send path (rewrite-action.ts) can
 *  finalize its own `retake`-kind draft on success, the same as `generate()`
 *  does here — the function only ever looks at the session object a draft
 *  wraps, never at what operation produced it. */
export function clearPendingGenerationDraft(
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

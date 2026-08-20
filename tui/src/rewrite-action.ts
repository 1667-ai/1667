import type { RewriteDestination, StoryNode, StoryPayload, TextRange } from "../../shared/types.js";
import { rewriteStreamDigest } from "../../shared/rewrite-partial-contract.js";
import type { ActionTask } from "./action-runtime.js";
import type { AppSource } from "./app.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import { openRetakeComposer, suspendRetakeComposer } from "./composer-ownership.js";
import { clearPendingGenerationDraft, isTimeoutClassApiFailure, restorePendingGenerationDraft } from "./generation-action.js";
import { recordHumanWords } from "./config.js";
import { humanWordsOf } from "./rail.js";
import type { PendingGenerationDraft, PromptIntent, RetakePromptSession, RuntimeState, StreamView } from "./state.js";
import type { ActionContext } from "./action-context.js";
import { rememberFocus } from "./reading-position-persist.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import {
  attachReasoningPresentation,
  attachStreamPresentation,
  appendStreamReasoning,
  appendStreamText,
  drainStreamPresentation,
  disposeStreamPresentation,
  emptyStreamText,
  resumeStreamPresentation,
  suspendStreamPresentation,
  streamHasSubstantiveText
} from "./stream-text.js";
import { canRewriteSelection, type StorySelectionSpan } from "./selection-projection.js";

export interface RewriteTarget extends TextRange {
  readonly node: StoryNode;
  readonly expected: string;
}

export interface RewriteTargetError {
  readonly error: string;
}

const NO_SELECTION_MESSAGE = "highlight story text before rewriting it";
const STALE_SELECTION_MESSAGE = "the story changed · highlight it again";

/** Pure and independent of `state.actions` so both the part-actions menu
 * (bound to a menu-opened part) and the command palette (bound only to a
 * captured selection) can resolve the same target from their own inputs. */
export function resolveRewriteTarget(
  payload: StoryPayload,
  partId: string,
  spans: readonly StorySelectionSpan[]
): RewriteTarget | RewriteTargetError {
  if (!canRewriteSelection(spans)) return { error: NO_SELECTION_MESSAGE };
  const span = spans[0]!;
  if (span.key !== `${partId}:text`) return { error: NO_SELECTION_MESSAGE };
  return resolveRewriteRange(payload, partId, span.start, span.end, span.text.slice(span.start, span.end));
}

/** The staleness check behind `resolveRewriteTarget`, factored out so the
 * open-composer path and the send-time re-check can share it. A span only
 * exists at the moment a selection is captured; by send time the composer
 * has kept nothing but these three values (see `PromptIntent`'s `rewrite`
 * case), so re-validation calls this directly instead of reconstructing one. */
function resolveRewriteRange(
  payload: StoryPayload,
  partId: string,
  start: number,
  end: number,
  expected: string
): RewriteTarget | RewriteTargetError {
  const node = payload.path.find((candidate) => candidate.id === partId);
  if (node === undefined) return { error: NO_SELECTION_MESSAGE };
  // Recompute against the live node rather than trusting the captured range:
  // the story can change under a highlighted passage between the moment the
  // selection was made and the moment the writer confirms the rewrite.
  const live = node.text.slice(start, end);
  if (live !== expected) return { error: STALE_SELECTION_MESSAGE };
  return { node, start, end, expected: live };
}

/** The palette captures a selection independent of any menu-bound part, so
 * it recovers which part owns the highlighted prose from the span's own key
 * instead of trusting a caller-supplied id. Only a prose-text span qualifies
 * — an instruction/direction-line span answers a different key suffix. */
export function partIdFromTextSelection(spans: readonly StorySelectionSpan[]): string | null {
  if (!canRewriteSelection(spans)) return null;
  const suffix = ":text";
  return spans[0]!.key.slice(0, -suffix.length);
}

type RewriteActionContext = Pick<ActionContext, "backend" | "cache" | "repaint">;

const REWRITE_STOPPING_TOAST = "rewrite stopping · nothing saved yet";
const REWRITE_STOPPING_PARTIAL_TOAST = "rewrite stopping · keeping streamed text";
const REWRITE_ALREADY_SAVED_TOAST = "rewrite already saved · finishing up";

/** Choosing "Rewrite selection" opens the composer this returns rather than
 * running anything — the writer may leave it empty for a plain regenerate
 * or type an instruction, and only `submitRewriteComposer` (the composer's
 * send path) ever calls the API. Seeded blank: unlike a retake, a rewrite
 * instruction has nothing to do with the node's own original instruction. */
export function openRewriteComposer(
  state: RuntimeState,
  target: RewriteTarget
): RetakePromptSession {
  return openRetakeComposer(state, target.node.id, "", {
    kind: "rewrite",
    start: target.start,
    end: target.end,
    expected: target.expected
  });
}

/** The composer's send path for a rewrite intent — the counterpart of
 * `composeAction`'s inline retake branch (story-actions.ts), factored out
 * here since it belongs beside the operation it drives. Re-resolves the
 * target against the live payload (the story may have moved while the
 * composer sat open); everything past that — history, human-word tracking,
 * the pending draft, and composer/mode ownership — runs *inside*
 * `context.backend.run`'s callback, the same discipline the retake send path
 * uses (story-actions.ts's `composeAction`). If `ActionRuntime.run` refuses
 * because another task already owns the backend, none of that handoff has
 * happened: the composer, history, and typed instruction are all untouched
 * rather than abandoned mid-flight with nothing left to restore them from. */
export async function submitRewriteComposer(
  state: RuntimeState,
  source: AppSource,
  context: RewriteActionContext,
  prompt: RetakePromptSession,
  intent: Extract<PromptIntent, { kind: "rewrite" }>,
  instruction: string,
  /** Absent means "in-place" — the ordinary send. `"take"` only ever arrives
   *  from the composer's second fixed key (story-actions.ts's composeAction). */
  destination?: RewriteDestination
): Promise<void> {
  const resolved = resolveRewriteRange(state.payload, prompt.nodeId, intent.start, intent.end, intent.expected);
  if ("error" in resolved) {
    state.composer.fullscreen = false;
    state.toast = resolved.error;
    return;
  }
  await context.backend.run("rewriting prose", async (task) => {
    if (instruction.trim().length > 0) {
      state.history.push(instruction);
      if (!state.demo) {
        source.config = recordHumanWords(source.config, humanWordsOf(instruction));
        state.config = source.config;
      }
    }
    state.historyIndex = state.history.length;
    state.historyDraft = null;
    const pendingDraft: PendingGenerationDraft = { kind: "retake", text: instruction, retakePrompt: prompt, restored: false };
    state.pendingGenerationDraft = pendingDraft;
    state.composer.fullscreen = false;
    suspendRetakeComposer(state, prompt);
    state.mode = "NAV";
    await runSelectionRewrite(state, source, context, resolved, instruction, pendingDraft, task, destination);
  });
}

/** The rewrite request itself, run from inside `submitRewriteComposer`'s
 * `context.backend.run` callback so this task owns the line through
 * reload/adopt settlement — the same discipline `summary-action.ts` uses for
 * its own claimed operation. `pendingDraft` is the composer's own draft;
 * threading it through and recovering it on failure/stop gives a rewrite the
 * same "typed instruction survives an unlucky request" guarantee a retake
 * gets from the identical object shape — until the take commits server-side,
 * past which recovering it would resurrect a composer aimed at a node the
 * new take has already replaced (see the `committed` handling below and in
 * `requestRewriteStop`). This has exactly one caller, so it stays local. */
async function runSelectionRewrite(
  state: RuntimeState,
  source: AppSource,
  context: RewriteActionContext,
  target: RewriteTarget,
  instruction: string,
  pendingDraft: PendingGenerationDraft,
  task: ActionTask,
  destination?: RewriteDestination
): Promise<void> {
  const node = target.node;
  const controller = new AbortController();
  // Unlike generate(), this never re-checks state.abort: ActionRuntime.run
  // refuses a second task while state.backendTask is set, and this task
  // holds that ownership through settlement. `active` is kept as a local
  // reference (rather than re-reading state.abort each time) so the
  // finally block's identity check and requestRewriteStop's `committed`
  // read always agree on exactly which claim they mean.
  const active = {
    kind: "rewrite" as const,
    controller,
    committed: false,
    explicitStop: false
  };
  state.abort = active;
  const stream: StreamView = {
    targetId: node.id,
    parentId: node.parentId,
    append: false,
    rewrite: { start: target.start, end: target.end },
    instruction,
    startedAt: new Date().toISOString(),
    composerClaimEpoch: state.composerClaimEpoch,
    ...emptyStreamText()
  };
  attachStreamPresentation(stream, () => {
    if (state.stream === stream && state.payload.id === task.storyId) context.repaint();
  });
  state.stream = stream;
  context.repaint();

  // Every byte the stream delivered, display guards aside — the exact text
  // the settle after a Stop or a clean timeout identifies for the backend's
  // partial-rewrite commit (issue #339). The stopped tail arrives through
  // `onStopped` exactly once, at terminal settlement, so after the call
  // resolves this equals what the backend's own stash holds.
  let streamedText = "";
  const attemptId = crypto.randomUUID();
  try {
    const takeId = await source.api.rewriteNode(
      task.storyId,
      node.id,
      {
        start: target.start, end: target.end, instruction, expected: target.expected,
        attemptId,
        // Absent means "in-place" (shared/types.ts's resolveRewriteDestination) —
        // omitted rather than always stamped, so a plain send keeps sending the
        // exact body shape it always has.
        ...(destination === undefined ? {} : { destination })
      },
      (delta) => {
        streamedText += delta;
        if (!task.owns() || !task.storyCurrent()) return;
        appendStreamText(stream, delta);
      },
      controller.signal,
      // Fires inside the adapter, before its own confirming refresh — the
      // one layer lower than this call's own resolution where commitment
      // actually happens (api.ts, worker-story-api.ts). Recording it here
      // closes the window where that refresh rejects (or Escape races it)
      // between a durable take and this task ever learning about it.
      () => { active.committed = true; },
      {
        onStopped: (tail) => {
          streamedText += tail;
          if (!task.owns() || !task.storyCurrent()) return;
          appendStreamText(stream, tail);
        },
        // Same ownership guard as onDelta, on the reasoning channel. Reasoning
        // is not part of the rewrite's committed replacement text — it never
        // touches `streamedText` — it only ever lives on the live stream view.
        onReasoning: (delta) => {
          if (!task.owns() || !task.storyCurrent()) return;
          const presentation = attachReasoningPresentation(stream, () => {
            if (state.stream === stream && state.payload.id === task.storyId) context.repaint();
          });
          if (active.explicitStop) presentation.suspend();
          appendStreamReasoning(stream, delta.text, delta.tokenCount);
          if (delta.text.length === 0) context.repaint();
        },
        // Same withheld-tail contract as onStopped, on the reasoning channel.
        onReasoningStopped: (tail) => {
          if (!task.owns() || !task.storyCurrent()) return;
          const presentation = attachReasoningPresentation(stream, () => {
            if (state.stream === stream && state.payload.id === task.storyId) context.repaint();
          });
          if (active.explicitStop) presentation.suspend();
          appendStreamReasoning(stream, tail, stream.reasoning?.tokenCount ?? 0);
        }
      }
    );
    if (controller.signal.aborted) {
      return await settleStoppedRewrite(
        state,
        source,
        task,
        stream,
        node.id,
        streamedText,
        attemptId,
        pendingDraft,
        null,
        context.cache
      );
    }
    if (takeId === null) {
      // Not an abort and not an error — the request simply landed nothing.
      // The draft is otherwise indistinguishable from a failed one: restore
      // it here too, but only on this story (a story switch already means
      // some newer surface, never this dormant draft, owns the composer).
      if (task.storyCurrent()) restorePendingGenerationDraft(state, pendingDraft, task.interactionCurrent());
      return;
    }
    // Reassigning here is normally a no-op — the `onCommitted` hook above
    // already set this before this call resolved — but it is the only
    // record of commitment for an adapter (or test stub) that resolves a
    // take id without ever calling that hook. Neither a failed confirming
    // reload below nor an Escape racing this window may resurrect the
    // pre-rewrite draft or claim nothing was saved — requestRewriteStop
    // reads this same flag on `active` (== state.abort while it is current).
    active.committed = true;
    if (!task.storyCurrent()) return;

    await drainStreamPresentation(stream);
    if (!task.storyCurrent()) return;
    const payload = await source.api.loadStory(task.storyId);
    if (!task.storyCurrent()) return;
    if (state.stream === stream) state.stream = null;
    adoptSameStoryPayload(state, payload, context.cache);
    const landed = new Map(state.freshLandedAt);
    landed.set(takeId, Date.now());
    state.freshLandedAt = landed;
    if (task.interactionCurrent()) {
      state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(payload), takeId));
      rememberFocus(state, source);
    }
    clearPendingGenerationDraft(state, pendingDraft);
    // Mirrors the manual-edit pair's "edited take created" / "take updated in
    // place" (editor-action.ts): the writer needs to know which one just
    // happened, not just that a rewrite did.
    state.toast = destination === "take" ? "selection rewritten as a new take" : "selection rewritten in place";
  } catch (error) {
    if (controller.signal.aborted) {
      await settleStoppedRewrite(
        state,
        source,
        task,
        stream,
        node.id,
        streamedText,
        attemptId,
        pendingDraft,
        null,
        context.cache
      );
    } else if (task.storyCurrent()) {
      if (active.committed) {
        // Only the confirming reload failed; the take itself already landed.
        // Clear the stale draft instead of resurrecting a composer aimed at
        // a node the new take has already replaced on the active path, and
        // let the error speak for what actually went wrong.
        clearPendingGenerationDraft(state, pendingDraft);
        state.toast = error instanceof Error ? error.message : String(error);
      } else if (isTimeoutClassApiFailure(error) && streamedText.trim().length > 0) {
        // A clean timeout — never the writer's Escape and never a provider
        // rejection — leaves prose exactly as real as a Stop's (issue
        // #345). The settle decides between "text kept" and the plain
        // restore below; the failure itself stays visible either way.
        await settleStoppedRewrite(
          state,
          source,
          task,
          stream,
          node.id,
          streamedText,
          attemptId,
          pendingDraft,
          error instanceof Error ? error.message : String(error),
          context.cache
        );
      } else {
        restorePendingGenerationDraft(state, pendingDraft, task.interactionCurrent());
        state.toast = error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    if (state.abort === active) state.abort = null;
    if (state.stream === stream) state.stream = null;
    disposeStreamPresentation(stream);
    context.repaint();
  }
}

/** Escape restores the local UI immediately for a rewrite that has not yet
 * committed — an aborted rewrite before that point saves nothing
 * server-side, so restoration is safe.
 *
 * Mirrors `requestGenerationStop`'s instant draft restoration: the typed
 * instruction reappears in a reopened composer on the same tick as the
 * keypress, before the abort signal even reaches the in-flight request.
 * Restoration is unconditional (not gated on "nothing substantive streamed
 * yet") because — before commitment — a rewrite never has partial text worth
 * landing: it either fails outright or resolves one complete replacement,
 * never a growing draft the way generation's append/continue does. Falling
 * back to the stopping/stopped toast pair only covers the one case
 * restoration itself reports failure: a newer Direct claim already retired
 * this draft out from under the request.
 *
 * Once `runSelectionRewrite` marks its claim committed, that premise no
 * longer holds: the replacement is already durable server-side, so this
 * reports the landing instead of resurrecting a composer aimed at a node the
 * new take has already replaced. */
export function requestRewriteStop(state: RuntimeState, repaint: () => void): void {
  const active = state.abort;
  if (active?.kind !== "rewrite") return;
  const stream = state.stream;
  // Stop is an explicit user action. Freeze both visible channels before the
  // abort or partial-save path starts. Authoritative text still accepts
  // terminal tails, but the live view must not advance after Stop.
  active.explicitStop = true;
  if (stream !== null) suspendStreamPresentation(stream);
  if (active.committed) {
    state.toast = REWRITE_ALREADY_SAVED_TOAST;
    repaint();
    return;
  }
  // Substantive streamed prose is worth landing (issue #339): keep the
  // stream visible and the draft unrestored, and let the settle after
  // terminal settlement decide between "text kept" and full restoration.
  if (stream !== null && stream.rewrite !== undefined && streamHasSubstantiveText(stream)) {
    active.controller.abort();
    state.toast = REWRITE_STOPPING_PARTIAL_TOAST;
    repaint();
    return;
  }
  const restored = restorePendingGenerationDraft(state, state.pendingGenerationDraft, true);
  active.controller.abort();
  state.stream = null;
  state.toast = restored ? null : REWRITE_STOPPING_TOAST;
  repaint();
}

/** The rewrite counterpart of `settleStoppedGeneration`: ask the backend to
 * commit the verified partial it stashed for this part. The request sends a
 * digest of the exact prose this client watched stream. A refusal (nothing stashed, a byte
 * difference, a rejected seam, a restarted backend) commits nothing; only a
 * real commit ever reports text kept, so the writer is never told a save
 * happened that did not. `failureMessage` is non-null when a clean timeout —
 * not the writer's Escape — ended the stream; it stays in the toast either
 * way. */
async function settleStoppedRewrite(
  state: RuntimeState,
  source: AppSource,
  task: ActionTask,
  stream: StreamView,
  nodeId: string,
  streamedText: string,
  attemptId: string,
  pendingDraft: PendingGenerationDraft,
  failureMessage: string | null,
  cache: ActionContext["cache"]
): Promise<void> {
  if (!task.storyCurrent()) return;
  let committed: { payload: StoryPayload; nodeId: string } | null = null;
  if (streamedText.trim().length > 0) {
    const streamedDigest = rewriteStreamDigest(streamedText);
    try {
      // Routed through the recovery feed when one is active — a worker
      // deadline publishes a recovery warning that would otherwise fence
      // this save, the same reason settleStoppedGeneration routes its
      // createNode this way.
      committed = await (
        source.backendRecovery?.runRecoveryMutation(() =>
          source.api.commitPartialRewrite(
            task.storyId,
            nodeId,
            streamedDigest,
            attemptId
          )
        ) ?? source.api.commitPartialRewrite(
          task.storyId,
          nodeId,
          streamedDigest,
          attemptId
        )
      );
    } catch {
      committed = null;
    }
  }
  if (!task.storyCurrent()) return;
  if (committed !== null) {
    // The committed rewrite replaces the live stream. Drain its visible
    // prefix first so the durable payload does not cause a final jump. An
    // explicit Stop suspended this work while the save was gated; resume
    // only after the save succeeds, so the Stop freeze still covers abort,
    // save, and the first settlement attempt.
    if (state.stream !== null && state.stream !== stream) return;
    // Stop detaches the stream immediately. Reattach only after the partial
    // save succeeds, then drain through the normal presentation lifecycle so
    // the committed payload cannot jump past queued prose or reasoning.
    state.stream = stream;
    resumeStreamPresentation(stream);
    await drainStreamPresentation(stream);
    if (!task.storyCurrent()) return;
    if (state.stream === stream) state.stream = null;
    adoptSameStoryPayload(state, committed.payload, cache);
    const landed = new Map(state.freshLandedAt);
    landed.set(committed.nodeId, Date.now());
    state.freshLandedAt = landed;
    clearPendingGenerationDraft(state, pendingDraft);
    if (task.interactionCurrent()) {
      state.focusIndex = Math.max(
        0,
        rowIndexForNode(createStoryViewModel(committed.payload), committed.nodeId)
      );
      rememberFocus(state, source);
    }
    state.toast = failureMessage === null
      ? "rewrite stopped · streamed text kept"
      : `${failureMessage} · rewrite stopped · text kept`;
    return;
  }
  restorePendingGenerationDraft(state, pendingDraft, task.interactionCurrent());
  if (failureMessage !== null) {
    state.toast = failureMessage;
    return;
  }
  await reloadAfterStop(state, source, task.storyId, task.storyCurrent, cache);
}

async function reloadAfterStop(
  state: RuntimeState,
  source: AppSource,
  storyId: string,
  storyCurrent: () => boolean,
  cache: ActionContext["cache"]
): Promise<void> {
  if (!storyCurrent()) return;
  try {
    const payload = await source.api.loadStory(storyId);
    if (storyCurrent()) adoptSameStoryPayload(state, payload, cache);
    if (state.toast === REWRITE_STOPPING_TOAST
      || state.toast === REWRITE_STOPPING_PARTIAL_TOAST) {
      state.toast = "rewrite stopped · nothing saved";
    }
  } catch (error) {
    if (state.toast === REWRITE_STOPPING_TOAST
      || state.toast === REWRITE_STOPPING_PARTIAL_TOAST) {
      state.toast = error instanceof Error ? error.message : String(error);
    }
  }
}

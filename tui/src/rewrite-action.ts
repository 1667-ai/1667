import type { StoryNode, StoryPayload, TextRange } from "../../shared/types.js";
import type { AppSource } from "./app.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import type { RuntimeState, StreamView } from "./state.js";
import type { ActionContext } from "./action-context.js";
import { rememberFocus } from "./reading-position-persist.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { appendStreamText, emptyStreamText } from "./stream-text.js";
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
  const node = payload.path.find((candidate) => candidate.id === partId);
  if (node === undefined) return { error: NO_SELECTION_MESSAGE };
  // Recompute against the live node rather than trusting the captured span:
  // the story can change under a highlighted passage between the moment the
  // selection was made and the moment the writer confirms the rewrite.
  const expected = node.text.slice(span.start, span.end);
  if (expected !== span.text.slice(span.start, span.end)) {
    return { error: STALE_SELECTION_MESSAGE };
  }
  return { node, start: span.start, end: span.end, expected };
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

/** The backend task owns the rewrite through reload/adopt settlement, the
 * same discipline `summary-action.ts` uses for its own claimed operation. */
export async function startSelectionRewrite(
  state: RuntimeState,
  source: AppSource,
  context: RewriteActionContext,
  target: RewriteTarget
): Promise<void> {
  await context.backend.run("rewriting prose", async (task) => {
    const node = target.node;
    const controller = new AbortController();
    // Unlike generate(), this never re-checks state.abort: ActionRuntime.run
    // refuses a second task while state.backendTask is set, and this task
    // holds that ownership through settlement.
    state.abort = { kind: "rewrite", controller };
    const stream: StreamView = {
      targetId: node.id,
      parentId: node.parentId,
      append: false,
      rewrite: { start: target.start, end: target.end },
      instruction: node.instruction,
      startedAt: new Date().toISOString(),
      composerClaimEpoch: state.composerClaimEpoch,
      ...emptyStreamText()
    };
    state.stream = stream;
    context.repaint();

    try {
      await source.api.rewriteNode(
        task.storyId,
        node.id,
        { start: target.start, end: target.end, instruction: "", expected: target.expected },
        (delta) => {
          if (!task.owns() || !task.storyCurrent() || state.stream !== stream) return;
          appendStreamText(stream, delta);
          context.repaint();
        },
        controller.signal
      );
      if (controller.signal.aborted) {
        return await reloadAfterStop(state, source, task.storyId, task.storyCurrent);
      }
      if (!task.storyCurrent()) return;

      const payload = await source.api.loadStory(task.storyId);
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload);
      const landed = new Map(state.freshLandedAt);
      landed.set(node.id, Date.now());
      state.freshLandedAt = landed;
      if (task.interactionCurrent()) {
        state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(payload), node.id));
        rememberFocus(state, source);
      }
      state.toast = "selection rewritten";
    } catch (error) {
      if (controller.signal.aborted) {
        await reloadAfterStop(state, source, task.storyId, task.storyCurrent);
      } else if (task.storyCurrent()) {
        state.toast = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (state.abort !== null && state.abort.kind === "rewrite" && state.abort.controller === controller) {
        state.abort = null;
      }
      if (state.stream === stream) state.stream = null;
      context.cache.invalidate();
      context.repaint();
    }
  });
}

/** Escape restores the local UI immediately; the owner keeps settling and
 * nothing lands, since an aborted rewrite saves nothing server-side. */
export function requestRewriteStop(state: RuntimeState, repaint: () => void): void {
  if (state.abort?.kind !== "rewrite") return;
  state.abort.controller.abort();
  state.stream = null;
  state.toast = REWRITE_STOPPING_TOAST;
  repaint();
}

async function reloadAfterStop(
  state: RuntimeState,
  source: AppSource,
  storyId: string,
  storyCurrent: () => boolean
): Promise<void> {
  if (!storyCurrent()) return;
  try {
    const payload = await source.api.loadStory(storyId);
    if (storyCurrent()) adoptSameStoryPayload(state, payload);
    if (state.toast === REWRITE_STOPPING_TOAST) state.toast = "rewrite stopped · nothing saved";
  } catch (error) {
    if (state.toast === REWRITE_STOPPING_TOAST) {
      state.toast = error instanceof Error ? error.message : String(error);
    }
  }
}

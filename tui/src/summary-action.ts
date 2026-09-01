import { activeLineFingerprintSource } from "../../shared/story-text.js";
import { textHash } from "./api.js";
import type { AppSource } from "./app.js";
import { createStoryViewModel, rowIndexForNode } from "./model.js";
import type { RuntimeState, SummaryOverlayState } from "./state.js";
import { narrowedSummaryToast, summaryStretch } from "./summary-model.js";
import { retireGenerationBusyToast } from "./generation-action.js";
import type { ActionContext } from "./action-context.js";
import { rememberFocus } from "./reading-position-persist.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { createTextPresentation, drainTextPresentation } from "./text-presentation.js";
import { settleModeUnderPalette } from "./palette-owner.js";

type SummaryActionContext = Pick<ActionContext, "backend" | "cache" | "repaint">;

const SUMMARY_STOPPING_TOAST = "summary draft discarded · waiting for backend settlement";

/** The backend task owns summary creation through switch/reload settlement. */
export async function startSummary(
  state: RuntimeState,
  source: AppSource,
  context: SummaryActionContext
): Promise<void> {
  if (state.abort !== null || state.stream !== null) {
    state.toast = "stream running · esc stops it first";
    return;
  }
  const leaf = state.payload.path.at(-1);
  if (leaf === undefined) {
    state.toast = "nothing to summarize";
    return;
  }

  await context.backend.run("summarizing story", async (task) => {
    const requestedPath = state.payload.path;
    const stretch = summaryStretch(requestedPath);
    const controller = new AbortController();
    const summary: SummaryOverlayState = {
      start: stretch.start,
      end: stretch.end,
      totalParts: stretch.total,
      text: "",
      controller
    };
    summary.presentation = createTextPresentation({
      onPresented: () => {
        if (state.summary === summary && state.payload.id === task.storyId) context.repaint();
      }
    });
    const fingerprint = textHash(activeLineFingerprintSource(state.payload.title, state.payload.path));
    state.summary = summary;
    state.mode = "SUMMARY";
    const active = { kind: "summary" as const, controller };
    state.abort = active;
    context.repaint();

    try {
      const result = await source.api.createSummaryTake(task.storyId, { nodeId: leaf.id }, (delta) => {
        if (!task.owns() || state.summary !== summary) return;
        summary.text += delta;
        summary.presentation?.receive(delta);
        if (summary.presentation === undefined) context.repaint();
      }, controller.signal);
      if (controller.signal.aborted) {
        return await reloadAfterStop(state, source, task.storyId, task.storyCurrent, context.cache);
      }
      if (result === null || !task.storyCurrent()) return;
      // Start presentation drain while the fingerprint and line switch are
      // in flight. Keep the promise so adoption waits for the visible prefix
      // after switchLine returns, without changing create/switch ordering.
      const presentationDrain = summary.presentation === undefined
        ? Promise.resolve(true)
        : drainTextPresentation(summary.presentation);
      const { nodeId, narrowedTo } = result;

      const expectedLineFingerprint = await fingerprint;
      if (controller.signal.aborted) {
        return await reloadAfterStop(state, source, task.storyId, task.storyCurrent, context.cache);
      }
      if (!task.storyCurrent()) return;
      const switched = await source.api.switchLine(task.storyId, nodeId, {
        stopAtNode: true,
        expectedLineFingerprint
      });
      if (controller.signal.aborted) {
        return await reloadAfterStop(state, source, task.storyId, task.storyCurrent, context.cache);
      }
      if (!task.storyCurrent()) return;

      const drained = await presentationDrain;
      if (controller.signal.aborted) {
        return await reloadAfterStop(state, source, task.storyId, task.storyCurrent, context.cache);
      }
      if (!drained || !task.storyCurrent()) return;
      adoptSameStoryPayload(state, switched, context.cache);
      if (!task.interactionCurrent() || state.summary !== summary) return;
      const index = switched.path.findIndex((node) => node.id === nodeId);
      if (index === -1) {
        state.focusIndex = Math.min(state.focusIndex, Math.max(0, createStoryViewModel(switched).rows.length - 1));
        state.toast = "◈ summary saved as a take · line changed while it wrote";
      } else {
        state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(switched), switched.path[index]!.id));
        state.toast = narrowedTo === null ? "◈ summary take saved" : narrowedSummaryToast(requestedPath, stretch, narrowedTo);
      }
      rememberFocus(state, source);
      settleSummarySurface(state, summary);
    } catch (error) {
      if (controller.signal.aborted) {
        await reloadAfterStop(state, source, task.storyId, task.storyCurrent, context.cache);
      } else if (task.storyCurrent()) {
        state.toast = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (state.abort === active) {
        state.abort = null;
        retireGenerationBusyToast(state);
      }
      summary.presentation?.dispose();
      if (state.summary === summary) {
        settleSummarySurface(state, summary);
      }
      context.repaint();
    }
  });
}

/** Escape restores the local UI immediately; the owner keeps settling. */
export function cancelSummary(state: RuntimeState): void {
  const summary = state.summary;
  if (summary === null) return;
  summary.controller.abort();
  summary.presentation?.dispose();
  state.summary = null;
  // A palette opened over Summary remains visible while the request settles.
  // Release its Summary owner now so a command chosen during cancellation
  // returns to a real post-summary surface.
  settleModeUnderPalette(state, "SUMMARY", "NAV");
  state.toast = SUMMARY_STOPPING_TOAST;
}

/** Release Summary ownership without stranding a palette opened over it. */
function settleSummarySurface(state: RuntimeState, summary: SummaryOverlayState): void {
  if (state.summary !== summary) return;
  state.summary = null;
  settleModeUnderPalette(state, "SUMMARY", "NAV");
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
    if (state.toast === SUMMARY_STOPPING_TOAST) state.toast = "summary stopped · draft discarded";
  } catch (error) {
    if (state.toast === SUMMARY_STOPPING_TOAST) {
      state.toast = error instanceof Error ? error.message : String(error);
    }
  }
}

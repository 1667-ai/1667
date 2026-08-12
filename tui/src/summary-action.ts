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
        context.repaint();
      }, controller.signal);
      if (controller.signal.aborted) return await reloadAfterStop(state, source, task.storyId, task.storyCurrent, context.cache);
      if (result === null || !task.storyCurrent()) return;
      const { nodeId, narrowedTo } = result;

      const expectedLineFingerprint = await fingerprint;
      if (controller.signal.aborted) return await reloadAfterStop(state, source, task.storyId, task.storyCurrent, context.cache);
      if (!task.storyCurrent()) return;
      const switched = await source.api.switchLine(task.storyId, nodeId, {
        stopAtNode: true,
        expectedLineFingerprint
      });
      if (controller.signal.aborted) return await reloadAfterStop(state, source, task.storyId, task.storyCurrent, context.cache);
      if (!task.storyCurrent()) return;

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
      state.summary = null;
      state.mode = "NAV";
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
      if (state.summary === summary) {
        state.summary = null;
        if (state.mode === "SUMMARY") state.mode = "NAV";
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
  state.summary = null;
  state.mode = "NAV";
  state.toast = SUMMARY_STOPPING_TOAST;
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

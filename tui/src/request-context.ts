import type { StoryPayload } from "../../shared/types.js";
import { createStoryViewModel, rowPart, type StoryViewModel } from "./model.js";
import type { NextRequestContext } from "./request-projection.js";
import type { StoryScreenState } from "./state.js";
import { streamHasSubstantiveText } from "./stream-text.js";

type RequestContextState = Pick<
  StoryScreenState,
  "payload" | "stream" | "focusIndex" | "mode" | "composer" | "retakePrompt"
  | "systemPrompt" | "assistantPrefill" | "request"
>;

/** The generation seam and prompt settings used by every next-request meter.
 *
 * A rewrite composer's own request has a different shape entirely (excerpt
 * and seam contract, word band, clamped temperature, tight output budget)
 * that lives in `server/generation-prompts.ts` and is not available to this
 * layer. Rather than mis-describe it as a retake of the whole part, or feed
 * its typed instruction into a continuation plan it has nothing to do with,
 * a rewrite composer projects the same baseline the story would show with no
 * composer open at all — truthful, if incomplete, until a real rewrite
 * projection exists. */
export function nextRequestContext(
  state: RequestContextState,
  view: StoryViewModel = createStoryViewModel(state.payload, state.stream)
): NextRequestContext {
  const focused = rowPart(view, state.focusIndex);
  const composeRequest = state.mode === "COMPOSE"
    || state.mode === "REQUEST" && state.request?.returnMode === "COMPOSE";
  const rewriteComposer = composeRequest && state.retakePrompt?.intent.kind === "rewrite";
  const activeRetakeNodeId = composeRequest && state.retakePrompt?.intent.kind === "retake"
    ? state.retakePrompt.nodeId
    : null;
  const base = {
    systemPrompt: state.systemPrompt,
    instruction: composeRequest && !rewriteComposer ? state.composer.text : "",
    assistantPrefill: state.assistantPrefill
  };
  return activeRetakeNodeId !== null
    && view.visiblePayload.path.some((node) => node.id === activeRetakeNodeId)
    ? { ...base, operation: "retake", targetId: activeRetakeNodeId }
    : {
      ...base,
      operation: "continue",
      targetId: focused?.id ?? view.visiblePayload.path.at(-1)?.id ?? null
    };
}

export interface ProjectedNextRequest {
  payload: StoryPayload;
  context: NextRequestContext;
}

/** Project an in-flight generation as the prompt-ready story it will become,
 * then derive the next request from that same snapshot. */
export function projectNextRequest(
  state: RequestContextState,
  visibleView: StoryViewModel = createStoryViewModel(state.payload, state.stream)
): ProjectedNextRequest {
  const visibleContext = nextRequestContext(state, visibleView);
  // The view already owns the canonical substantive stream projection. Reuse
  // it so a frame never rebuilds and remeasures the same growing prose twice.
  const payload = state.stream !== null && !streamHasSubstantiveText(state.stream)
    ? state.payload
    : visibleView.visiblePayload;
  if (visibleContext.operation === "retake") return { payload, context: visibleContext };
  const targetId = payload.path.some((part) => part.id === visibleContext.targetId)
    ? visibleContext.targetId
    : payload.path.at(-1)?.id ?? null;
  return {
    payload,
    context: { ...visibleContext, targetId }
  };
}

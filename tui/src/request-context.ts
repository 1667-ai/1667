import type { StoryPayload } from "../../shared/types.js";
import { createStoryViewModel, rowPart, type StoryViewModel } from "./model.js";
import type { NextRequestContext } from "./request-projection.js";
import type { StoryScreenState } from "./state.js";
import { streamHasSubstantiveText } from "./stream-text.js";

type RequestContextState = Pick<
  StoryScreenState,
  "payload" | "stream" | "focusIndex" | "mode" | "composer" | "retakePrompt"
  | "systemPrompt" | "assistantPrefill"
>;

/** The generation seam and prompt settings used by every next-request meter. */
export function nextRequestContext(
  state: RequestContextState,
  view: StoryViewModel = createStoryViewModel(state.payload, state.stream)
): NextRequestContext {
  const focused = rowPart(view, state.focusIndex);
  const activeRetakeNodeId = state.mode === "COMPOSE" ? state.retakePrompt?.nodeId ?? null : null;
  const base = {
    systemPrompt: state.systemPrompt,
    instruction: state.mode === "COMPOSE" ? state.composer.text : "",
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

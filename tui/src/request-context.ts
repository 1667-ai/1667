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

/** The generation seam and prompt settings used by every next-request meter. */
export function nextRequestContext(
  state: RequestContextState,
  view: StoryViewModel = createStoryViewModel(state.payload, state.stream)
): NextRequestContext {
  const focused = rowPart(view, state.focusIndex);
  const composeRequest = state.mode === "COMPOSE"
    || state.mode === "REQUEST" && state.request?.returnMode === "COMPOSE";
  const activeRetakeNodeId = composeRequest ? state.retakePrompt?.nodeId ?? null : null;
  const base = {
    systemPrompt: state.systemPrompt,
    instruction: composeRequest ? state.composer.text : "",
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

/**
 * Everything the next-request projection reads, in the derived form it reads
 * it. Two identities that match project the same messages, so a token count
 * taken under one describes the other exactly.
 *
 * This is what a token count is held against. Comparing the rendered messages
 * instead would mean hashing the whole prompt on every frame; comparing only
 * their roles and lengths is cheap but blind — swapping a take for another of
 * the same length, or ASCII for the same length of CJK, changes the token
 * count while leaving those lengths alone.
 *
 * It takes the derived context rather than raw state on purpose. `mode` moves
 * when the request viewer opens, and the composer's draft only reaches the
 * prompt in some modes, so raw fields would retire a count that still
 * describes the very request the viewer was opened to inspect. `payload` is
 * replaced whole on every mutation, and the stream's text is taken by value
 * because deltas append to it in place.
 */
export interface PromptProjectionIdentity {
  readonly payload: StoryPayload;
  readonly streamText: string | null;
  readonly streamTargetId: string | null;
  readonly systemPrompt: string;
  readonly instruction: string;
  readonly assistantPrefill: boolean;
  readonly operation: string;
  readonly targetId: string | null;
}

export function promptProjectionIdentity(
  state: RequestContextState,
  context: NextRequestContext
): PromptProjectionIdentity {
  return {
    payload: state.payload,
    streamText: state.stream?.text ?? null,
    streamTargetId: state.stream?.targetId ?? null,
    systemPrompt: context.systemPrompt,
    instruction: context.instruction,
    assistantPrefill: context.assistantPrefill,
    operation: context.operation,
    targetId: context.targetId
  };
}

export function sameProjectionIdentity(
  left: PromptProjectionIdentity,
  right: PromptProjectionIdentity
): boolean {
  return left.payload === right.payload
    && left.streamText === right.streamText
    && left.streamTargetId === right.streamTargetId
    && left.systemPrompt === right.systemPrompt
    && left.instruction === right.instruction
    && left.assistantPrefill === right.assistantPrefill
    && left.operation === right.operation
    && left.targetId === right.targetId;
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

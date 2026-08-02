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
 * Every state field the next-request projection reads. Two states with the
 * same identity project the same messages, so a token count taken under one
 * describes the other exactly.
 *
 * This is what a token count is held against. Comparing the rendered messages
 * instead would mean hashing the whole prompt on every frame; comparing only
 * their roles and lengths is cheap but blind — swapping a take for another of
 * the same length, or ASCII for the same length of CJK, changes the token
 * count while leaving those lengths alone. Reading the inputs costs nothing
 * and misses nothing: `payload` is replaced whole on every mutation, and the
 * stream's text is taken by value because deltas append to it in place.
 */
export interface PromptProjectionIdentity {
  readonly payload: StoryPayload;
  readonly streamText: string | null;
  readonly streamTargetId: string | null;
  readonly focusIndex: number;
  readonly mode: string;
  readonly composerText: string;
  readonly retakeNodeId: string | null;
  readonly systemPrompt: string;
  readonly assistantPrefill: boolean;
  readonly returnMode: string | null;
}

export function promptProjectionIdentity(state: RequestContextState): PromptProjectionIdentity {
  return {
    payload: state.payload,
    streamText: state.stream?.text ?? null,
    streamTargetId: state.stream?.targetId ?? null,
    focusIndex: state.focusIndex,
    mode: state.mode,
    composerText: state.composer.text,
    retakeNodeId: state.retakePrompt?.nodeId ?? null,
    systemPrompt: state.systemPrompt,
    assistantPrefill: state.assistantPrefill,
    returnMode: state.request?.returnMode ?? null
  };
}

export function sameProjectionIdentity(
  left: PromptProjectionIdentity,
  right: PromptProjectionIdentity
): boolean {
  return left.payload === right.payload
    && left.streamText === right.streamText
    && left.streamTargetId === right.streamTargetId
    && left.focusIndex === right.focusIndex
    && left.mode === right.mode
    && left.composerText === right.composerText
    && left.retakeNodeId === right.retakeNodeId
    && left.systemPrompt === right.systemPrompt
    && left.assistantPrefill === right.assistantPrefill
    && left.returnMode === right.returnMode;
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

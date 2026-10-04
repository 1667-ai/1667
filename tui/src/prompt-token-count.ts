import type { ChatMessage } from "../../shared/prompt-plan.js";
import { nextRequestEstimate } from "../../shared/request-projection.js";
import {
  startPromptTokenCountLane as startSharedLane,
  type PromptTokenCountApi,
  type PromptTokenCountHost,
  type PromptTokenCountLane,
  type TimerHandle
} from "../../shared/prompt-token-count-lane.js";
import { promptCountFingerprint } from "../../shared/tokenize-source.js";
import { projectNextRequest, promptProjectionIdentity, type PromptProjectionIdentity } from "./request-context.js";
import type { RuntimeState } from "./state.js";

// The lane itself lives in `shared/` (the web composer runs the same one).
export type { PromptTokenCountApi, PromptTokenCountLane } from "../../shared/prompt-token-count-lane.js";

export interface PromptTokenCountDependencies {
  readonly state: RuntimeState;
  readonly api: PromptTokenCountApi;
  readonly repaint: () => void;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel?: (timer: TimerHandle) => void;
}

/** Keeps `state.promptTokenCount` answering the prompt currently projected,
 * without ever touching `ActionRuntime` (see action-runtime.ts). The scheduling
 * rules are the shared lane's; this file only says where the TUI keeps its
 * state. */
export function startPromptTokenCountLane(
  dependencies: PromptTokenCountDependencies
): PromptTokenCountLane {
  const { state } = dependencies;
  const host: PromptTokenCountHost<PromptProjectionIdentity> = {
    storyId: () => state.payload.id,
    route: () => state.generationRoute,
    // The abort claim is the provider-work lifetime. It starts before a stream,
    // remains through settlement, and excludes a preserved ownerless stream.
    providerBusy: () => state.abort !== null,
    requestViewerOpen: () => state.mode === "REQUEST",
    project: () => {
      const projected = projectNextRequest(state);
      return {
        messages: nextRequestEstimate(projected.payload, projected.context).messages,
        identity: promptProjectionIdentity(state, projected.context)
      };
    },
    hasAnswer: () => state.promptTokenCount !== null,
    setAnswer: (answer) => { state.promptTokenCount = answer; },
    repaint: dependencies.repaint
  };
  return startSharedLane({
    host,
    api: dependencies.api,
    fingerprint: (messages: readonly ChatMessage[], route: string) => promptCountFingerprint(messages, route),
    ...dependencies.schedule === undefined ? {} : { schedule: dependencies.schedule },
    ...dependencies.cancel === undefined ? {} : { cancel: dependencies.cancel }
  });
}

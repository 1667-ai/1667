import type {
  AnthropicOptions,
  Context,
  Model,
  OpenAICodexResponsesOptions
} from "@earendil-works/pi-ai";
import {
  adjustMaxTokensForThinking,
  clampMaxTokensToContext
} from "@earendil-works/pi-ai/api/simple-options";
import type {
  ConnectionTimeoutsV2,
  GenerationEffortV2
} from "../shared/settings-v2-types.js";
import type {
  ReasoningPolicyResolution
} from "../shared/reasoning-capabilities.js";
import { ProviderError } from "./errors.js";

export const SUBSCRIPTION_EFFECTIVE_FIELDS = [
  "max_tokens",
  "temperature",
  "thinking.type",
  "thinking.display",
  "thinking.budget_tokens",
  "top_p",
  "top_k",
  "output_config.effort",
  "reasoning.effort",
  "tool_choice",
  "tool_choice.type",
  "stream"
] as const;

export function openAiReasoningOptions(
  effort: GenerationEffortV2,
  policy?: ReasoningPolicyResolution | null
): Pick<OpenAICodexResponsesOptions, "reasoningEffort"> {
  if (policy?.kind === "unavailable") throw new ProviderError(policy.message);
  if (policy?.kind === "available") {
    switch (policy.wire.kind) {
      case "openai":
      case "compatible-openai":
        return policy.wire.openaiEffort === undefined
          ? {}
          : { reasoningEffort: policy.wire.openaiEffort };
      case "anthropic":
      case "compatible-anthropic":
      case "compatible":
      case "none":
        return {};
    }
  }
  return effort === "default"
    ? {}
    : { reasoningEffort: effort === "off" ? "none" : effort };
}

export function anthropicReasoningOptions(
  model: Model<"anthropic-messages">,
  context: Context,
  effort: GenerationEffortV2,
  maxTokens: number,
  policy?: ReasoningPolicyResolution | null
): Pick<AnthropicOptions, "thinkingEnabled" | "effort" | "thinkingBudgetTokens" | "thinkingDisplay" | "maxTokens"> {
  if (policy?.kind === "unavailable") throw new ProviderError(policy.message);
  if (policy?.kind === "available") {
    switch (policy.wire.kind) {
      case "anthropic": {
        const thinking = policy.wire.thinking;
        if (thinking === undefined) return {};
        if (thinking.type === "disabled") return { thinkingEnabled: false };
        const adaptive: Pick<AnthropicOptions, "thinkingEnabled" | "effort" | "thinkingDisplay"> = {
          thinkingEnabled: true,
          ...(policy.wire.anthropicEffort === undefined ? {} : { effort: policy.wire.anthropicEffort }),
          ...(thinking.display === undefined ? {} : { thinkingDisplay: thinking.display })
        };
        return adaptive;
      }
      case "openai":
      case "compatible-openai":
      case "compatible-anthropic":
      case "compatible":
      case "none":
        return {};
    }
  }
  if (effort === "default" || effort === "off") return { thinkingEnabled: false };
  if (model.compat?.forceAdaptiveThinking === true) {
    return { thinkingEnabled: true, effort };
  }
  // Match Pi's Anthropic stream path: admit the configured answer limit first,
  // then reserve thinking, and clamp the combined ceiling to the context.
  const admittedMaxTokens = clampMaxTokensToContext(model, context, maxTokens);
  const adjusted = adjustMaxTokensForThinking(admittedMaxTokens, model.maxTokens, effort);
  const requestMaxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
  return {
    maxTokens: requestMaxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, requestMaxTokens - 1_024))
  };
}

export function createRequestSignal(signal: AbortSignal, totalMs: number): {
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  clear(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(
    new ProviderError("Model request exceeded its total deadline.", null, "", {
      timeout: "provider-total"
    })
  ), totalMs);
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    controller,
    clear: () => clearTimeout(timer)
  };
}

/** Let caller cancellation or the total deadline release a provider gate. */
export function awaitSubscriptionGate(
  gate: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Model request was cancelled"));
    if (signal.aborted) {
      gate.catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createTimeoutState(timeouts: ConnectionTimeoutsV2, controller: AbortController): {
  failure: ProviderError | null;
  responseHeader(): void;
  start(): void;
  activity(): void;
  clear(): void;
} {
  let responseTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  const state = {
    failure: null as ProviderError | null,
    responseHeader() {
      if (
        state.failure !== null
        || started
        || responseTimer !== null
        || controller.signal.aborted
      ) return;
      responseTimer = setTimeout(
        () => fail("Model provider did not return a response header before the configured deadline.", "provider-response-header"),
        timeouts.responseHeaderMs
      );
    },
    start() {
      if (state.failure !== null || started || controller.signal.aborted) return;
      started = true;
      if (responseTimer !== null) clearTimeout(responseTimer);
      responseTimer = null;
    },
    activity() {
      if (state.failure !== null) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => fail("Model stream was idle beyond the configured deadline.", "provider-idle"),
        timeouts.idleMs
      );
    },
    clear() {
      if (responseTimer !== null) clearTimeout(responseTimer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      responseTimer = null;
      idleTimer = null;
    }
  };
  function fail(message: string, timeout: "provider-response-header" | "provider-idle"): void {
    if (state.failure !== null) return;
    state.failure = new ProviderError(message, null, "", { timeout });
    controller.abort(state.failure);
  }
  return state;
}

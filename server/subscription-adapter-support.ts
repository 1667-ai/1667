import type {
  Api,
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
import type { GenerationSettings } from "../shared/types.js";
import type {
  ReasoningPolicyResolution
} from "../shared/reasoning-capabilities.js";
import type { StorySamplingBias } from "./sampling-phrase-bias.js";
import {
  isSchema4ProviderRuntime,
  providerReasoningPolicyFor,
  providerRuntimeFor,
  type ProviderRuntime
} from "./provider-runtime.js";
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

export interface SubscriptionReasoningResolution {
  readonly policy: ReasoningPolicyResolution | null;
  /** The value lowered to Pi. Null means that the subscription protocol must
   * omit the writer's stored temperature from this request. */
  readonly temperature: number | null;
}

/** Resolve one subscription request at the adapter boundary. The first pass
 * asks the shared policy about the request with temperature omitted. This
 * allows ChatGPT and Pi's Claude compatibility metadata to lower a stored
 * temperature without making that persisted preference invalid. A second
 * pass restores the value only when this protocol, model, and reasoning state
 * can send it, so joint restrictions such as Claude temperature plus top p
 * remain refusals. */
export function subscriptionReasoningPolicyFor(
  settings: GenerationSettings,
  model: Pick<Model<Api>, "api" | "compat">,
  storySampling?: StorySamplingBias
): SubscriptionReasoningResolution {
  const runtime = providerRuntimeFor(settings);
  const withoutTemperature = providerReasoningPolicyFor(
    settings,
    storySampling,
    { temperature: null }
  );
  const temperatureCanBeSent = subscriptionTemperatureCanBeSent(
    runtime,
    model,
    withoutTemperature
  );
  if (!temperatureCanBeSent) {
    return { policy: withoutTemperature, temperature: null };
  }

  const withTemperature = providerReasoningPolicyFor(settings, storySampling);
  return {
    policy: withTemperature,
    temperature: withTemperature?.kind === "unavailable"
      ? null
      : settings.temperature
  };
}

function subscriptionTemperatureCanBeSent(
  runtime: ProviderRuntime,
  model: Pick<Model<Api>, "api" | "compat">,
  policy: ReasoningPolicyResolution | null
): boolean {
  if (runtime.protocol === "openai-codex-responses") return false;
  if (runtime.protocol !== "anthropic-subscription-messages") return false;
  if (runtime.capabilities.temperature === "unsupported") return false;
  if (model.api !== "anthropic-messages") return false;
  if ((model.compat as { readonly supportsTemperature?: boolean } | undefined)?.supportsTemperature === false) {
    return false;
  }
  if (policy?.kind === "unavailable") {
    // The subscription policy reports its own unsupported sampling after the
    // shared Anthropic temperature/top-p check. Re-run that check with the
    // stored temperature so the more useful joint refusal is preserved.
    return policy.reason === "sampling-unsupported";
  }
  if (policy?.kind === "available") return policy.temperatureAllowed;
  if (policy !== null) return false;
  // Legacy profiles have no schema-4 policy. Pi enables Anthropic thinking
  // for every non-default legacy effort, where its adapter omits temperature.
  return isSchema4ProviderRuntime(runtime)
    || runtime.effort === "default"
    || runtime.effort === "off";
}

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

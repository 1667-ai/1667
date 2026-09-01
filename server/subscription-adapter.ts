import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  AnthropicOptions,
  Context,
  OpenAICodexResponsesOptions,
  Model,
  Models
} from "@earendil-works/pi-ai";
import { hasApi } from "@earendil-works/pi-ai";
import type { GenerationSettings } from "../shared/types.js";
import type { StorySamplingBias } from "./sampling-phrase-bias.js";
import {
  renderPromptPlan,
  activeImageAttachments,
  type ChatMessage,
  type PromptPlan
} from "../shared/prompt-plan.js";
import { lowerPromptForProvider } from "./provider-request-body.js";
import { ProviderError } from "./errors.js";
import {
  createProviderStreamRedactor,
  legacyGenerationEffortFor,
  isSubscriptionProviderRuntime,
  providerRuntimeFor,
  redactProviderSecrets,
  type SubscriptionProviderRuntime
} from "./provider-runtime.js";
import { requireLogitBiasFamilyAvailable } from "./provider-sampling.js";
import { createReasoningRelay } from "./provider-reasoning-relay.js";
import {
  providerOutputByteLimit,
  requireProviderOutputWithinLimit
} from "./provider-stream-output.js";
import {
  subscriptionProviderForProtocol
} from "./subscription-protocol.js";
import type {
  GenerationRecordCollector
} from "./generation-record-capture.js";
import type {
  ProviderSecretsCollector,
  ReasoningConsumer,
  StreamOutcome
} from "./providers.js";
import { createGenerationRecordCapture } from "./generation-record-capture.js";
import {
  anthropicReasoningOptions,
  awaitSubscriptionGate,
  createRequestSignal,
  createTimeoutState,
  openAiReasoningOptions,
  subscriptionReasoningPolicyFor,
  SUBSCRIPTION_EFFECTIVE_FIELDS
} from "./subscription-adapter-support.js";
import {
  createSubscriptionEventPump,
  observeSubscriptionEvent,
  type SubscriptionEventPump
} from "./subscription-event-pump.js";

export interface SubscriptionStreamOptions {
  readonly outcome?: StreamOutcome;
  readonly providerStarted?: () => void | Promise<void>;
  readonly storySampling?: StorySamplingBias;
  readonly onReasoning?: ReasoningConsumer;
  readonly providerSecrets?: ProviderSecretsCollector;
  readonly generationRecord?: GenerationRecordCollector;
}

/** Stream one fixed Pi subscription protocol through the existing contract. */
export async function* streamSubscription(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  options: SubscriptionStreamOptions
): AsyncGenerator<string> {
  const runtime = providerRuntimeFor(settings);
  if (!isSubscriptionProviderRuntime(runtime)) {
    throw new ProviderError("Subscription protocol is not supported.");
  }
  if (runtime.tokenProbabilities !== null) {
    throw new ProviderError(
      "Token probabilities are unavailable because the pinned subscription adapter cannot serialize token probabilities."
    );
  }
  const protocol = runtime.protocol;
  requireLogitBiasFamilyAvailable(settings, protocol, options.storySampling);
  const dependencies = runtime.subscription;
  const providerId = subscriptionProviderForProtocol(protocol);
  const modelValue = dependencies.models.getModel(providerId, settings.model);
  if (modelValue === undefined) {
    throw new ProviderError(
      `Subscription model ${redactProviderSecrets(settings.model, [])} is not in the pinned provider catalog.`
    );
  }
  const model = modelValue;
  const reasoningResolution = subscriptionReasoningPolicyFor(
    settings,
    model,
    options.storySampling
  );
  const reasoningPolicy = reasoningResolution.policy;
  const requestTemperature = reasoningResolution.temperature;
  if (reasoningPolicy?.kind === "unavailable") {
    throw new ProviderError(reasoningPolicy.message);
  }
  const legacyEffort = reasoningPolicy === null
    ? legacyGenerationEffortFor(runtime)
    : "default" as const;
  if (activeImageAttachments(prompt).length > 0) {
    throw new ProviderError("Subscription providers do not support image prompts.");
  }
  const requestSignal = createRequestSignal(signal, runtime.timeouts.totalMs);
  const timeoutState = createTimeoutState(runtime.timeouts, requestSignal.controller);
  const wireProtocol = protocol;
  const generationRecord = createGenerationRecordCapture(
    options.generationRecord,
    wireProtocol,
    SUBSCRIPTION_EFFECTIVE_FIELDS
  );
  let secrets: readonly string[] = [];
  let outputRedactor: ReturnType<typeof createProviderStreamRedactor> | undefined;
  let reasoning: ReturnType<typeof createReasoningRelay> | undefined;
  let decodedBytes = 0;
  let terminal = false;
  let terminalReason: "stop" | "length" | null = null;
  let streamed = false;
  let completed = false;
  let cleanupReason: unknown;
  let generationRecordFinished = false;
  let piStarted = false;
  let textByIndex = new Map<number, string>();
  let wirePayload: Record<string, unknown> | undefined;
  let providerStart: Promise<void> | undefined;
  let activeEventPump: SubscriptionEventPump | undefined;
  const onPayload = async (payload: unknown): Promise<undefined> => {
    if (!isRecord(payload)) {
      throw new ProviderError("Subscription provider returned an invalid request payload.");
    }
    wirePayload = payload;
    providerStart ??= Promise.resolve(options.providerStarted?.());
    await awaitSubscriptionGate(providerStart, requestSignal.signal);
    if (requestSignal.controller.signal.aborted) {
      throw requestSignal.controller.signal.reason
        ?? new Error("Model request was cancelled");
    }
    timeoutState.responseHeader();
    return undefined;
  };
  try {
    const auth = await resolveSubscriptionAuth(
      dependencies,
      model,
      providerId,
      requestSignal.signal
    );
    const credential = await dependencies.credentials.read(providerId, {
      signal: requestSignal.signal
    });
    secrets = uniqueSecrets([
      auth,
      credential?.type === "oauth" ? credential.access : undefined,
      credential?.type === "oauth" ? credential.refresh : undefined
    ]);
    if (options.providerSecrets !== undefined) options.providerSecrets.secrets = secrets;
    const context = contextForPrompt(settings, prompt, model);
    const redactor = createProviderStreamRedactor(secrets);
    outputRedactor = redactor;
    const reasoningRelay = createReasoningRelay(settings, secrets, options.onReasoning);
    reasoning = reasoningRelay;
    if (timeoutState.failure !== null) throw timeoutState.failure;
    if (signal.aborted) throw signal.reason ?? new Error("Model request was cancelled");
    let stream: AssistantMessageEventStream;
    if (protocol === "openai-codex-responses") {
      if (!hasApi(model, "openai-codex-responses")) {
        throw new ProviderError("Subscription protocol and Pi model API do not match.");
      }
      const streamOptions: OpenAICodexResponsesOptions = {
        signal: requestSignal.signal,
        apiKey: auth,
        maxTokens: settings.maxTokens,
        ...(requestTemperature === null ? {} : { temperature: requestTemperature }),
        toolChoice: "none",
        timeoutMs: runtime.timeouts.totalMs,
        onPayload,
        ...openAiReasoningOptions(legacyEffort, reasoningPolicy)
      };
      stream = dependencies.models.stream(model, context, streamOptions);
    } else {
      if (!hasApi(model, "anthropic-messages")) {
        throw new ProviderError("Subscription protocol and Pi model API do not match.");
      }
      const maxTokens = Math.min(settings.maxTokens, model.maxTokens);
      const streamOptions: AnthropicOptions = {
        signal: requestSignal.signal,
        apiKey: auth,
        maxTokens,
        ...(requestTemperature === null ? {} : { temperature: requestTemperature }),
        toolChoice: "none",
        timeoutMs: runtime.timeouts.totalMs,
        onPayload,
        ...anthropicReasoningOptions(model, context, legacyEffort, maxTokens, reasoningPolicy)
      };
      stream = dependencies.models.stream(model, context, streamOptions);
    }
    const eventPump = createSubscriptionEventPump(
      stream,
      requestSignal.signal,
      (event) => observeSubscriptionEvent(event, timeoutState, requestSignal),
      providerOutputByteLimit(settings),
      requestSignal.controller
    );
    activeEventPump = eventPump;
    for await (const event of eventPump.events) {
      if (signal.aborted) throw signal.reason ?? new Error("Model request was cancelled");
      if (timeoutState.failure !== null) throw timeoutState.failure;
      if (terminal) throw new ProviderError("Subscription stream emitted an event after completion.");
      switch (event.type) {
        case "start":
          piStarted = true;
          break;
        case "text_start":
        case "thinking_start":
          requirePiStart(piStarted);
          break;
        case "text_delta": {
          requirePiStart(piStarted);
          const delta = requireTextDelta(event);
          if (delta.length === 0) break;
          streamed = true;
          decodedBytes = requireProviderOutputWithinLimit(settings, decodedBytes, delta);
          textByIndex.set(
            event.contentIndex,
            `${textByIndex.get(event.contentIndex) ?? ""}${delta}`
          );
          const safe = redactor.push(delta);
          if (safe.length > 0) yield safe;
          break;
        }
        case "text_end": {
          requirePiStart(piStarted);
          const content = requireTextDelta(event);
          const emitted = textByIndex.get(event.contentIndex) ?? "";
          if (content !== emitted) {
            if (emitted.length !== 0) {
              throw new ProviderError("Subscription stream text boundary was inconsistent.");
            }
            if (content.length > 0) {
              streamed = true;
              decodedBytes = requireProviderOutputWithinLimit(settings, decodedBytes, content);
              const safe = redactor.push(content);
              if (safe.length > 0) yield safe;
            }
          }
          break;
        }
        case "thinking_delta":
          requirePiStart(piStarted);
          await reasoningRelay.push(requireTextDelta(event));
          break;
        case "thinking_end":
          requirePiStart(piStarted);
          break;
        case "done":
          requirePiStart(piStarted);
          if (event.reason !== "stop" && event.reason !== "length") {
            throw new ProviderError("Subscription provider returned an unsupported terminal reason.");
          }
          terminal = true;
          terminalReason = event.reason;
          break;
        case "error":
          throw subscriptionEventError(event, secrets, signal);
        case "toolcall_start":
        case "toolcall_delta":
        case "toolcall_end":
          throw new ProviderError("Subscription providers cannot return tool calls.");
        default:
          throw new ProviderError("Subscription provider returned an unexpected stream event.");
      }
    }
    if (!terminal) {
      if (signal.aborted) throw signal.reason ?? new Error("Model request was cancelled");
      if (timeoutState.failure !== null) throw timeoutState.failure;
      throw new ProviderError("Subscription stream ended before its terminal event.");
    }
    const result = await stream.result();
    if (result.stopReason !== "stop" && result.stopReason !== "length") {
      throw new ProviderError("Subscription provider returned an unsupported terminal result.");
    }
    if (options.outcome !== undefined) {
      options.outcome.providerTerminal = true;
      options.outcome.finishReason = terminalReason ?? result.stopReason;
    }
    generationRecord.finish(requireWirePayload(wirePayload));
    generationRecordFinished = true;
    const tail = redactor.finish();
    if (tail.length > 0) yield tail;
    await reasoningRelay.finish();
    completed = true;
  } catch (error) {
    cleanupReason = error;
    if (!requestSignal.controller.signal.aborted) {
      requestSignal.controller.abort(
        error instanceof Error ? error : new Error("Subscription stream failed")
      );
    }
    const tail = outputRedactor?.finish() ?? "";
    if (tail.length > 0) yield tail;
    if (signal.aborted) throw signal.reason ?? error;
    if (timeoutState.failure !== null) throw timeoutState.failure;
    if (requestSignal.controller.signal.reason instanceof ProviderError) {
      throw requestSignal.controller.signal.reason;
    }
    if (error instanceof ProviderError) throw error;
    throw subscriptionError(error, secrets);
  } finally {
    activeEventPump?.cancel();
    if (streamed && wirePayload !== undefined && !generationRecordFinished) {
      generationRecord.finish(wirePayload);
      generationRecordFinished = true;
    }
    textByIndex = new Map();
    timeoutState.clear();
    if (!completed && !requestSignal.controller.signal.aborted) {
      requestSignal.controller.abort(
        cleanupReason instanceof Error
          ? cleanupReason
          : new Error("Subscription stream closed before completion")
      );
    }
    requestSignal.clear();
    outputRedactor?.finish();
    await reasoning?.finish();
  }
}

async function resolveSubscriptionAuth(
  dependencies: SubscriptionProviderRuntime["subscription"],
  model: Model<Api>,
  providerId: "openai-codex" | "anthropic",
  signal: AbortSignal
): Promise<string> {
  let resolved: Awaited<ReturnType<Models["getAuth"]>>;
  try {
    resolved = await dependencies.models.getAuth(model, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw subscriptionAuthError(providerId, "failed");
  }
  if (typeof resolved?.auth.apiKey !== "string" || resolved.auth.apiKey.length === 0) {
    throw subscriptionAuthError(providerId, "missing");
  }
  return resolved.auth.apiKey;
}

function subscriptionAuthError(
  providerId: "openai-codex" | "anthropic",
  kind: "missing" | "failed"
): ProviderError {
  const presentation = providerId === "openai-codex"
    ? { label: "ChatGPT plan", login: "chatgpt" }
    : { label: "Claude plan", login: "claude" };
  const message = kind === "missing"
    ? `${presentation.label} is not signed in.`
    : `${presentation.label} authentication failed.`;
  return new ProviderError(`${message} Run 1667 auth login ${presentation.login}.`);
}

function contextForPrompt(
  settings: GenerationSettings,
  prompt: PromptPlan,
  model: Model<Api>
): Context {
  const rendered = renderPromptPlan(lowerPromptForProvider(settings, prompt));
  const systems: string[] = [];
  const messages: Context["messages"] = [];
  for (const message of rendered) {
    if (message.role === "system") {
      systems.push(message.content);
      continue;
    }
    if (message.role === "user") {
      messages.push({
        role: "user",
        content: message.content,
        timestamp: Date.now()
      });
      continue;
    }
    messages.push(assistantMessage(message, model));
  }
  return {
    ...(systems.length === 0 ? {} : { systemPrompt: systems.join("\n\n") }),
    messages,
    tools: []
  };
}

function assistantMessage(
  message: ChatMessage,
  model: Model<Api>
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

function requireTextDelta(
  event: { readonly delta?: unknown; readonly content?: unknown }
): string {
  const value = "delta" in event ? event.delta : event.content;
  if (typeof value !== "string") {
    throw new ProviderError("Subscription provider returned invalid text content.");
  }
  return value;
}

function requirePiStart(started: boolean): void {
  if (!started) throw new ProviderError("Subscription provider emitted an event before start.");
}

function subscriptionEventError(
  event: Extract<AssistantMessageEvent, { type: "error" }>,
  secrets: readonly string[],
  signal: AbortSignal
): Error {
  if (event.reason === "aborted" && signal.aborted) {
    return signal.reason ?? new Error("Model request was cancelled");
  }
  const message = typeof event.error.errorMessage === "string"
    ? redactProviderSecrets(event.error.errorMessage, secrets)
    : "Subscription provider returned an error.";
  return new ProviderError(`Subscription provider request failed: ${message.slice(0, 512)}`);
}

function subscriptionError(error: unknown, secrets: readonly string[]): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(
    `Subscription provider request failed: ${redactProviderSecrets(message, secrets).slice(0, 512)}`
  );
}

function uniqueSecrets(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function requireWirePayload(
  payload: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (payload === undefined) {
    throw new ProviderError("Subscription provider did not expose its request payload.");
  }
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

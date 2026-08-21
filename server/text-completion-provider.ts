import { renderPromptPlan, type PromptPlan } from "../shared/prompt-plan.js";
import { renderTextPrompt } from "../shared/text-prompt.js";
import type { GenerationSettings } from "../shared/types.js";
import { ProviderError } from "./errors.js";
import { assertImageContextAdmitted } from "./generation-admission.js";
import type { PromptCacheRequest } from "./provider-cache-policy.js";
import { llamaCppTemplateRequest } from "./llama-cpp-template.js";
import { postProviderJson } from "./provider-json.js";
import { applySamplingFields } from "./provider-sampling.js";
import {
  createProviderStreamRedactor,
  providerReasoningPolicyFor,
  providerRuntimeFor,
  redactProviderSecrets,
  resolveProviderHeaders
} from "./provider-runtime.js";
import {
  isProviderObject,
  parseProviderStreamEvent,
  requireProviderOutputWithinLimit
} from "./provider-stream-output.js";
import { providerSseEvents } from "./provider-sse.js";
import { providerRoot, providerUrl } from "./provider-url.js";
import {
  createReasoningRelay,
  type ReasoningConsumer
} from "./provider-reasoning-relay.js";
import { createThinkTagSplitter } from "../shared/think-tag-split.js";
/** Structural mirror of `ProviderSecretsCollector` (server/providers.ts).
 *  Declared here rather than imported: that module imports this one, so any
 *  back-import closes a cycle, and a cycle through the provider entry point
 *  leaves it half-initialised for an unrelated importer. */
interface TextProviderSecretsCollector {
  secrets: readonly string[];
}
import type { StorySamplingBias } from "./sampling-phrase-bias.js";
import {
  snapshotEffectiveFields,
  TEXT_COMPLETION_EFFECTIVE_FIELDS,
  type GenerationRecordCollector
} from "./generation-record-capture.js";

interface TextCompletionOutcome {
  finishReason: "stop" | "length" | null;
  providerTerminal: boolean;
}

interface TextCompletionOptions {
  readonly outcome?: TextCompletionOutcome;
  readonly providerStarted?: () => void | Promise<void>;
  readonly promptCache?: PromptCacheRequest;
  readonly storySampling?: StorySamplingBias;
  readonly generationRecord?: GenerationRecordCollector;
  readonly onReasoning?: ReasoningConsumer;
  readonly providerSecrets?: TextProviderSecretsCollector;
}

type TextEndpoint = "llama-cpp" | "koboldcpp" | "openai";

interface TextRequest {
  readonly endpoint: TextEndpoint;
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** Stream one raw prompt through a text-completion endpoint. */
export async function* streamTextCompletion(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  options: TextCompletionOptions
): AsyncGenerator<string> {
  const reasoningPolicy = providerReasoningPolicyFor(settings, options.storySampling);
  if (reasoningPolicy?.kind === "unavailable") {
    throw new ProviderError(reasoningPolicy.message);
  }
  if (reasoningPolicy?.kind === "available"
    && providerRuntimeFor(settings).tokenProbabilities !== null
    && !reasoningPolicy.tokenProbabilitiesAllowed) {
    throw new ProviderError("Token probabilities are unavailable with the selected reasoning state.");
  }
  // No text-completion protocol authorizes images
  // (shared/image-input-capabilities.ts), so any image on this prompt is
  // refused here rather than silently dropped from the raw prompt text.
  assertImageContextAdmitted(prompt);
  const preparedCache = options.promptCache?.runtime.prepare(
    options.promptCache.context,
    options.promptCache.scope,
    prompt
  );
  const promptText = await lowerTextPrompt(settings, prompt, signal);
  const request = await buildTextRequest(settings, promptText, options.storySampling);
  const { headers, secrets } = resolveProviderHeaders(settings, {
    "content-type": "application/json"
  });
  // A split thought and its prose leave through two separate redactors, so a
  // credential divided between them survives both. `reasoningSafeToStore`
  // catches exactly that at commit time, and only if the caller is told which
  // secrets this route resolved.
  if (options.providerSecrets !== undefined) options.providerSecrets.secrets = secrets;
  const outputRedactor = createProviderStreamRedactor(secrets);
  // A text route carries one undifferentiated token stream, so a thinking
  // model's `<think>` block arrives inside the prose. The splitter is the
  // only part that knows the tag; everything past the relay is the same code
  // the chat route's `reasoning_content` already travels through. Opt-in per
  // connection, because a raw route otherwise passes tokens through untouched
  // and an always-on split would eat a literal tag out of a take.
  const splitter = providerRuntimeFor(settings).splitThinkTags === true
    ? createThinkTagSplitter()
    : null;
  const reasoning = createReasoningRelay(settings, secrets, options.onReasoning);
  let decodedBytes = 0;
  let redactorFinished = false;
  let successfulTerminal = false;
  let streamed = false;
  const finishRedactor = (): string => {
    if (redactorFinished) return "";
    redactorFinished = true;
    return outputRedactor.finish();
  };
  /** Both tails at once, in the one order that works: the splitter's held
   *  bytes were never a tag, so they have to reach the prose redactor before
   *  it flushes, and the relay closes only once its own tail is in. */
  const finishStream = async (): Promise<string> => {
    let tail = "";
    if (splitter !== null && !redactorFinished) {
      const rest = splitter.finish();
      if (rest.reasoning.length > 0) await reasoning.push(rest.reasoning);
      if (rest.prose.length > 0) {
        decodedBytes = requireProviderOutputWithinLimit(settings, decodedBytes, rest.prose);
        tail = outputRedactor.push(rest.prose);
      }
    }
    await reasoning.finish();
    return tail + finishRedactor();
  };
  const finishGenerationRecord = (): void => {
    if (options.generationRecord === undefined) return;
    options.generationRecord.effective = {
      wireProtocol: "text-completions",
      fields: snapshotEffectiveFields(request.body, TEXT_COMPLETION_EFFECTIVE_FIELDS),
      adjustments: []
    };
  };
  try {
    try {
      for await (const data of providerSseEvents(
        settings,
        request.url,
        request.body,
        headers,
        secrets,
        signal,
        redactProviderSecrets,
        options.providerStarted,
        preparedCache?.commit,
        (event) => textEventHasContent(request.endpoint, event),
        (event) => textEventIsTerminal(request.endpoint, event)
      )) {
        if (data === "[DONE]") {
          if (!successfulTerminal) {
            throw new ProviderError(
              "OpenAI-compatible generation ended without a successful finish reason."
            );
          }
          if (options.outcome !== undefined) {
            options.outcome.providerTerminal = true;
          }
          break;
        }
        const event = parseProviderStreamEvent(data, secrets);
        successfulTerminal = requireSuccessfulTextEvent(request.endpoint, event)
          || successfulTerminal;
        updateOutcome(options.outcome, request.endpoint, event);
        const delta = textEventContent(request.endpoint, event);
        if (delta.length === 0) continue;
        const split = splitter === null
          ? { prose: delta, reasoning: "" }
          : splitter.push(delta);
        // Reasoning keeps the relay's own redactor and byte budget, never the
        // prose ones, so neither stream can spend the other's allowance.
        if (split.reasoning.length > 0) await reasoning.push(split.reasoning);
        if (split.prose.length === 0) continue;
        decodedBytes = requireProviderOutputWithinLimit(settings, decodedBytes, split.prose);
        const safe = outputRedactor.push(split.prose);
        if (safe.length > 0) {
          streamed = true;
          yield safe;
        }
      }
    } catch (error) {
      const tail = await finishStream();
      if (tail.length > 0) {
        streamed = true;
        yield tail;
      }
      // Any text already streamed is what a stopped-partial commit will
      // save, so the request body that produced it is worth recording even
      // though this attempt is failing. A secret redactor can buffer a short
      // delta and only release it here, on the tail flush — that release is
      // still delivered prose, so it must count as streamed too.
      if (streamed) finishGenerationRecord();
      throw error;
    }
    const tail = await finishStream();
    if (tail.length > 0) yield tail;
    finishGenerationRecord();
  } finally {
    finishRedactor();
  }
}

async function lowerTextPrompt(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal
): Promise<string> {
  const runtime = providerRuntimeFor(settings);
  const format = runtime.textPromptFormat ?? "raw";
  if (format !== "server-template") {
    return renderTextPrompt(prompt, format);
  }
  const messages = renderPromptPlan(prompt);
  const response = await postProviderJson(
    settings,
    `${providerRoot(settings)}/apply-template`,
    llamaCppTemplateRequest(settings.model, messages),
    {},
    { signal }
  );
  if (!isProviderObject(response) || typeof response.prompt !== "string") {
    throw new Error("llama.cpp apply-template returned an unusable response shape");
  }
  return response.prompt;
}

async function buildTextRequest(
  settings: GenerationSettings,
  prompt: string,
  storySampling: StorySamplingBias | undefined
): Promise<TextRequest> {
  const runtime = providerRuntimeFor(settings);
  const common: Record<string, unknown> = { prompt };
  if (
    settings.temperature !== null
    && runtime.capabilities.temperature !== "unsupported"
  ) {
    common.temperature = settings.temperature;
  }
  await applySamplingFields(common, settings, "text-completions", { storySampling });
  if (runtime.preset === "llama-cpp") {
    const model = settings.model.length === 0 ? {} : { model: settings.model };
    return {
      endpoint: "llama-cpp",
      url: `${providerRoot(settings)}/completion`,
      body: {
        ...common,
        ...model,
        n_predict: settings.maxTokens,
        stream: true
      }
    };
  }
  if (runtime.preset === "koboldcpp") {
    const model = settings.model.length === 0 ? {} : { model: settings.model };
    return {
      endpoint: "koboldcpp",
      url: `${providerRoot(settings)}/api/extra/generate/stream`,
      body: { ...common, ...model, max_length: settings.maxTokens }
    };
  }
  return {
    endpoint: "openai",
    url: providerUrl(settings, "/completions"),
    body: {
      ...common,
      model: settings.model,
      max_tokens: settings.maxTokens,
      stream: true
    }
  };
}

function textEventHasContent(endpoint: TextEndpoint, data: string): boolean {
  if (data === "[DONE]") return false;
  try {
    return textEventContent(
      endpoint,
      JSON.parse(data) as Record<string, unknown>
    ).length > 0;
  } catch {
    return false;
  }
}

function textEventIsTerminal(endpoint: TextEndpoint, data: string): boolean {
  if (endpoint === "openai") return data === "[DONE]";
  try {
    const event = JSON.parse(data) as unknown;
    if (!isProviderObject(event)) return false;
    return endpoint === "llama-cpp"
      ? event.stop === true
      : typeof event.finish_reason === "string";
  } catch {
    return false;
  }
}

function textEventContent(
  endpoint: TextEndpoint,
  event: Record<string, unknown>
): string {
  if (endpoint === "llama-cpp") {
    return typeof event.content === "string" ? event.content : "";
  }
  if (endpoint === "koboldcpp") {
    return typeof event.token === "string" ? event.token : "";
  }
  const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
  return isProviderObject(choice) && typeof choice.text === "string"
    ? choice.text
    : "";
}

function requireSuccessfulTextEvent(
  endpoint: TextEndpoint,
  event: Record<string, unknown>
): boolean {
  if (endpoint === "llama-cpp") return event.stop === true;
  const reason = endpoint === "openai"
    ? openAiFinishReason(event)
    : event.finish_reason;
  if (typeof reason !== "string") return false;
  if (reason === "stop" || reason === "length") return true;
  const provider = endpoint === "koboldcpp" ? "KoboldCpp" : "OpenAI-compatible";
  throw new ProviderError(`${provider} generation failed.`);
}

function openAiFinishReason(event: Record<string, unknown>): unknown {
  const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
  return isProviderObject(choice) ? choice.finish_reason : undefined;
}

function updateOutcome(
  outcome: TextCompletionOutcome | undefined,
  endpoint: TextEndpoint,
  event: Record<string, unknown>
): void {
  if (outcome === undefined) return;
  if (endpoint === "llama-cpp") {
    if (event.stop !== true) return;
    outcome.providerTerminal = true;
    outcome.finishReason = event.stop_type === "limit" ? "length" : "stop";
    return;
  }
  if (endpoint === "koboldcpp") {
    if (typeof event.finish_reason !== "string") return;
    outcome.providerTerminal = true;
    outcome.finishReason = event.finish_reason === "length" ? "length" : "stop";
    return;
  }
  const reason = openAiFinishReason(event);
  if (typeof reason !== "string") return;
  outcome.finishReason = reason === "length" ? "length" : "stop";
}

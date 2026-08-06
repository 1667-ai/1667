import { renderPromptPlan, type PromptPlan } from "../shared/prompt-plan.js";
import { renderTextPrompt } from "../shared/text-prompt.js";
import type { GenerationSettings } from "../shared/types.js";
import { ProviderError } from "./errors.js";
import type { PromptCacheRequest } from "./provider-cache-policy.js";
import { llamaCppTemplateRequest } from "./llama-cpp-template.js";
import { postProviderJson } from "./provider-json.js";
import { applySamplingFields } from "./provider-sampling.js";
import {
  createProviderStreamRedactor,
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
import type { StorySamplingBias } from "./sampling-phrase-bias.js";

interface TextCompletionOutcome {
  finishReason: "stop" | "length" | null;
}

interface TextCompletionOptions {
  readonly outcome?: TextCompletionOutcome;
  readonly providerStarted?: () => void | Promise<void>;
  readonly promptCache?: PromptCacheRequest;
  readonly storySampling?: StorySamplingBias;
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
  const outputRedactor = createProviderStreamRedactor(secrets);
  let decodedBytes = 0;
  let redactorFinished = false;
  let successfulTerminal = false;
  const finishRedactor = (): string => {
    if (redactorFinished) return "";
    redactorFinished = true;
    return outputRedactor.finish();
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
          break;
        }
        const event = parseProviderStreamEvent(data, secrets);
        successfulTerminal = requireSuccessfulTextEvent(request.endpoint, event)
          || successfulTerminal;
        updateOutcome(options.outcome, request.endpoint, event);
        const delta = textEventContent(request.endpoint, event);
        if (delta.length === 0) continue;
        decodedBytes = requireProviderOutputWithinLimit(settings, decodedBytes, delta);
        const safe = outputRedactor.push(delta);
        if (safe.length > 0) yield safe;
      }
    } catch (error) {
      const tail = finishRedactor();
      if (tail.length > 0) yield tail;
      throw error;
    }
    const tail = finishRedactor();
    if (tail.length > 0) yield tail;
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
    outcome.finishReason = event.stop_type === "limit" ? "length" : "stop";
    return;
  }
  if (endpoint === "koboldcpp") {
    if (typeof event.finish_reason !== "string") return;
    outcome.finishReason = event.finish_reason === "length" ? "length" : "stop";
    return;
  }
  const reason = openAiFinishReason(event);
  if (typeof reason !== "string") return;
  outcome.finishReason = reason === "length" ? "length" : "stop";
}

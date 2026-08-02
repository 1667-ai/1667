import type { GenerationSettings } from "../shared/types.js";
import {
  renderPromptPlan,
  type ChatMessage,
  type PromptOperation,
  type PromptPlan
} from "../shared/prompt-plan.js";
import { ProviderError } from "./errors.js";
import {
  PROMPT_CACHE_POLICY_OFF,
  type PreparedPromptCachePlan,
  type PromptCacheRequest
} from "./provider-cache-policy.js";
import {
  buildAnthropicMessagesRequestBody,
  buildOpenAiChatRequestBody
} from "./provider-request-body.js";
import {
  createProviderStreamRedactor,
  providerRuntimeFor,
  redactProviderSecrets,
  resolveProviderHeaders
} from "./provider-runtime.js";
import { providerSseEvents } from "./provider-sse.js";
export { ProviderError } from "./errors.js";
export type { ChatMessage, PromptPlan } from "../shared/prompt-plan.js";

/** Why the stream ended, when the provider said so: "length" means the output
 *  limit cut generation short; "stop" means the model finished on its own.
 *  Callers that need it pass a box the provider fills as the stream closes. */
export interface StreamOutcome {
  finishReason: "stop" | "length" | null;
}

const MAX_DECODED_OUTPUT_BYTES = 16 * 1024 * 1024;

export function streamCompletion(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  outcome?: StreamOutcome,
  providerStarted?: () => void | Promise<void>,
  promptCache?: PromptCacheRequest
): AsyncGenerator<string> {
  switch (settings.provider) {
    case "dry-run":
      return streamDryRun(prompt, signal, outcome);
    case "anthropic":
      return streamAnthropic(settings, prompt, signal, outcome, providerStarted, promptCache);
    case "openai-compatible":
      return streamOpenAiCompatible(settings, prompt, signal, outcome, providerStarted, promptCache);
  }
}

async function* streamOpenAiCompatible(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  outcome?: StreamOutcome,
  providerStarted?: () => void | Promise<void>,
  promptCache?: PromptCacheRequest
): AsyncGenerator<string> {
  const { headers, secrets } = resolveProviderHeaders(settings, {
    "content-type": "application/json"
  });
  const prepared = preparePromptCache(promptCache, prompt);
  const body = await buildOpenAiChatRequestBody(settings, prompt, prepared.wire, signal);
  const runtime = providerRuntimeFor(settings);
  const explicitEffort = runtime.effort !== "default";
  let totalDeadlineReached = false;
  const totalDeadline = new AbortController();
  const totalTimer = setTimeout(() => {
    totalDeadlineReached = true;
    totalDeadline.abort();
  }, runtime.timeouts.totalMs);
  const requestSignal = AbortSignal.any([signal, totalDeadline.signal]);
  // Reasoning-family models reject `max_tokens` (renamed `max_completion_tokens`)
  // and any non-default temperature. The rejection is a 400 that arrives before
  // any stream data, so the request can be retried with the body adjusted; a
  // stream that has already produced data is never retried.
  try {
    for (let attempt = 0; ; attempt++) {
      let streamed = false;
      const outputRedactor = createProviderStreamRedactor(secrets);
      try {
        let decodedBytes = 0;
        for await (const data of providerSseEvents(
          settings,
          providerUrl(settings, "/chat/completions"),
          body,
          headers,
          secrets,
          requestSignal,
          redactProviderSecrets,
          providerStarted,
          prepared.commit,
          isOpenAiContentDelta,
          isOpenAiTerminalEvent,
          signal,
          () => clearTimeout(totalTimer)
        )) {
          streamed = true;
          if (data === "[DONE]") {
            const tail = outputRedactor.finish();
            if (tail.length > 0) yield tail;
            return;
          }
          const parsed = parseEvent(data, secrets);
          const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
          if (isObject(choice) && typeof choice.finish_reason === "string" && outcome !== undefined) {
            outcome.finishReason = choice.finish_reason === "length" ? "length" : "stop";
          }
          const delta = isObject(choice) && isObject(choice.delta) ? choice.delta.content : undefined;
          if (typeof delta === "string" && delta.length > 0) {
            decodedBytes = requireOutputWithinLimit(settings, decodedBytes, delta);
            const safe = outputRedactor.push(delta);
            if (safe.length > 0) yield safe;
          }
        }
        const tail = outputRedactor.finish();
        if (tail.length > 0) yield tail;
        return;
      } catch (error) {
        const tail = outputRedactor.finish();
        if (tail.length > 0) yield tail;
        if (totalDeadlineReached) {
          if (error instanceof ProviderError && error.status !== null) {
            throw new ProviderError(
              "Model request exceeded its total deadline.",
              error.status,
              error.body
            );
          }
          throw new ProviderError("Model request exceeded its total deadline.");
        }
        if (
          streamed
          || attempt >= 3
          || !adjustRejectedParameter(body, error, prompt.operation, explicitEffort)
        ) throw error;
      }
    }
  } finally {
    clearTimeout(totalTimer);
  }
}

/** Rewrites the request body to drop or rename a parameter an OpenAI-style 400
 *  names as unsupported. Returns whether a retry is worthwhile. */
function adjustRejectedParameter(
  body: Record<string, unknown>,
  error: unknown,
  kind: PromptOperation,
  explicitEffort: boolean
): boolean {
  if (!(error instanceof ProviderError) || error.status !== 400) return false;
  let detail: Record<string, unknown>;
  try {
    const parsed = JSON.parse(error.body) as unknown;
    detail = isObject(parsed) && isObject(parsed.error) ? parsed.error : {};
  } catch {
    return false;
  }
  if (detail.code === "unsupported_parameter" && detail.param === "max_tokens" && "max_tokens" in body) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    // Only reasoning models reject max_tokens, and their hidden reasoning would
    // spend the small fixed budgets of the precision tasks (a plain rewrite gets
    // ~100 tokens, a title 64) before any prose comes out.
    if (!explicitEffort && (kind === "rewrite" || kind === "title")) {
      body.reasoning_effort = "minimal";
    }
    return true;
  }
  if (detail.code === "unsupported_parameter" && detail.param === "reasoning_effort" && "reasoning_effort" in body) {
    if (explicitEffort) return false;
    delete body.reasoning_effort;
    return true;
  }
  if (
    (detail.code === "unsupported_value" || detail.code === "unsupported_parameter")
    && detail.param === "temperature"
    && "temperature" in body
  ) {
    delete body.temperature;
    return true;
  }
  return false;
}

async function* streamAnthropic(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  outcome?: StreamOutcome,
  providerStarted?: () => void | Promise<void>,
  promptCache?: PromptCacheRequest
): AsyncGenerator<string> {
  const { headers, secrets } = resolveProviderHeaders(settings, {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01"
  });
  const prepared = preparePromptCache(promptCache, prompt);
  const body = await buildAnthropicMessagesRequestBody(settings, prompt, prepared.wire, signal);
  const refusalKey = samplingRefusalKey(settings);
  if (SAMPLING_REFUSED.has(refusalKey)) delete body.temperature;
  const runtime = providerRuntimeFor(settings);
  let decodedBytes = 0;
  // One deadline covers the retry too. Each attempt starts its own total timer,
  // so a rejection arriving near the deadline would otherwise buy the retry a
  // second full budget.
  let totalDeadlineReached = false;
  const totalDeadline = new AbortController();
  const totalTimer = setTimeout(() => {
    totalDeadlineReached = true;
    totalDeadline.abort();
  }, runtime.timeouts.totalMs);
  const requestSignal = AbortSignal.any([signal, totalDeadline.signal]);
  // The catalog records which models dropped sampling, but a model typed by
  // hand — or added after the last catalog read — has no such record. The
  // rejection is a 400 that arrives before any stream data, so the request can
  // be retried without the parameter; a stream that has already produced data
  // is never retried.
  try {
    for (let attempt = 0; ; attempt++) {
      const outputRedactor = createProviderStreamRedactor(secrets);
      let streamed = false;
      try {
        for await (const data of providerSseEvents(
          settings,
          providerUrl(settings, "/v1/messages"),
          body,
          headers,
          secrets,
          requestSignal,
          redactProviderSecrets,
          providerStarted,
          prepared.commit,
          isAnthropicContentDelta,
          isAnthropicTerminalEvent,
          signal,
          () => clearTimeout(totalTimer)
        )) {
          streamed = true;
          const parsed = parseEvent(data, secrets);
          if (parsed.type === "error") {
            const err = isObject(parsed.error) ? parsed.error : {};
            const detail = redactProviderSecrets(
              typeof err.message === "string" ? err.message : data,
              secrets
            ).slice(0, 300);
            throw new ProviderError(`Anthropic stream error: ${detail}`);
          }
          if (parsed.type === "message_stop") {
            const tail = outputRedactor.finish();
            if (tail.length > 0) yield tail;
            return;
          }
          if (parsed.type === "message_delta" && isObject(parsed.delta) && typeof parsed.delta.stop_reason === "string" && outcome !== undefined) {
            outcome.finishReason = parsed.delta.stop_reason === "max_tokens" ? "length" : "stop";
          }
          if (parsed.type === "content_block_delta" && isObject(parsed.delta) && parsed.delta.type === "text_delta") {
            const text = parsed.delta.text;
            if (typeof text === "string" && text.length > 0) {
              decodedBytes = requireOutputWithinLimit(settings, decodedBytes, text);
              const safe = outputRedactor.push(text);
              if (safe.length > 0) yield safe;
            }
          }
        }
        const tail = outputRedactor.finish();
        if (tail.length > 0) yield tail;
        return;
      } catch (error) {
        const tail = outputRedactor.finish();
        if (tail.length > 0) yield tail;
        if (totalDeadlineReached) {
          if (error instanceof ProviderError && error.status !== null) {
            throw new ProviderError(
              "Model request exceeded its total deadline.",
              error.status,
              error.body
            );
          }
          throw new ProviderError("Model request exceeded its total deadline.");
        }
        if (
          streamed
          || attempt >= 1
          || !dropRejectedAnthropicSampling(body, error)
        ) throw error;
        SAMPLING_REFUSED.add(refusalKey);
      }
    }
  } finally {
    clearTimeout(totalTimer);
  }
}

/** Models observed to reject sampling outright, keyed by endpoint and model.
 * The writer's stored temperature is their preference and stays untouched; this
 * records only what a provider has already refused, so the refusal is paid once
 * per model rather than on every request. Process-local by design: it is an
 * observation about a remote endpoint, not settings. */
const SAMPLING_REFUSED = new Set<string>();

function samplingRefusalKey(settings: GenerationSettings): string {
  return `${settings.baseUrl} ${settings.model}`;
}

export function forgetRefusedSampling(): void {
  SAMPLING_REFUSED.clear();
}

/** Anthropic names a rejected parameter in prose rather than in a `param`
 * field, so the match has to read the sentence. It stays narrow deliberately:
 * an invalid-request 400 that both names the parameter this request sent and
 * says the model does not take it. "temperature must be between 0 and 1" names
 * the same parameter and means something else entirely — that one is the
 * writer's to see, not ours to silently paper over. */
function dropRejectedAnthropicSampling(
  body: Record<string, unknown>,
  error: unknown
): boolean {
  if (!(error instanceof ProviderError) || error.status !== 400) return false;
  if (!("temperature" in body)) return false;
  let detail: Record<string, unknown>;
  try {
    const parsed = JSON.parse(error.body) as unknown;
    detail = isObject(parsed) && isObject(parsed.error) ? parsed.error : {};
  } catch {
    return false;
  }
  if (detail.type !== "invalid_request_error") return false;
  const message = typeof detail.message === "string" ? detail.message : "";
  if (!/\btemperature\b/iu.test(message)) return false;
  if (!/\b(?:deprecated|unsupported|not supported|unexpected|unrecognized)\b/iu.test(message)) {
    return false;
  }
  delete body.temperature;
  return true;
}

function isOpenAiContentDelta(data: string): boolean {
  if (data === "[DONE]") return false;
  try {
    const parsed = JSON.parse(data) as unknown;
    const choice = isObject(parsed) && Array.isArray(parsed.choices)
      ? parsed.choices[0]
      : undefined;
    const content = isObject(choice) && isObject(choice.delta)
      ? choice.delta.content
      : undefined;
    return typeof content === "string" && content.length > 0;
  } catch {
    return false;
  }
}

function isOpenAiTerminalEvent(data: string): boolean {
  return data === "[DONE]";
}

function isAnthropicContentDelta(data: string): boolean {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isObject(parsed)
      && parsed.type === "content_block_delta"
      && isObject(parsed.delta)
      && parsed.delta.type === "text_delta"
      && typeof parsed.delta.text === "string"
      && parsed.delta.text.length > 0;
  } catch {
    return false;
  }
}

function isAnthropicTerminalEvent(data: string): boolean {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isObject(parsed) && parsed.type === "message_stop";
  } catch {
    return false;
  }
}

async function* streamDryRun(
  prompt: PromptPlan,
  signal: AbortSignal,
  outcome?: StreamOutcome
): AsyncGenerator<string> {
  const messages = renderPromptPlan(prompt);
  const instruction = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const text = prompt.operation === "rewrite"
    ? dryRunRewrite(prompt)
    : prompt.operation === "title"
      ? instruction.includes("fork of the different story") ? "Embers on Another Road" : "The Quiet After Rain"
      : prompt.operation === "summary"
        ? dryRunSummary(prompt)
        : dryRunContinuation(instruction);
  // Keep the first chunk's leading boundary character: append continuations are
  // joined byte-for-byte, so a leading space is meaningful.
  for (const word of text.match(/\s*\S+/g) ?? []) {
    if (signal.aborted) return;
    yield word;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  if (outcome !== undefined) outcome.finishReason = "stop";
}

function dryRunSummary(prompt: PromptPlan): string {
  const blocks = prompt.turns.flatMap((turn) => turn.blocks);
  const source = blocks.find((block) => block.kind === "source")?.text ?? "";
  const completionMarker = blocks.find((block) => block.kind === "completion-marker")
    ?.text.match(/\[\[summary-complete-[a-f0-9]+\]\]/)?.[0]
    ?? "[[summary-complete-dry-run]]";
  const excerpt = source.replace(/^\[Part \d+\]\n/gm, "").trim().slice(0, 1_200);
  return [
    "STORY SO FAR",
    "",
    excerpt || "No source prose was available.",
    "",
    "BRANCH-POINT STATE",
    "",
    "This summary was prepared in dry-run mode. Connect a model in Settings for a detailed continuity record.",
    "",
    completionMarker
  ].join("\n");
}

/** The rewrite save path refuses output that doesn't end with the exact right
 *  boundary plus the end marker. Read both back out of the prompt so dry-run
 *  satisfies the same contract as a real model instead of always failing it.
 *  The stand-in matches the highlighted length: a one-word thesaurus tap must
 *  get a word back, not a fixed sentence spliced into the prose. */
function dryRunRewrite(prompt: PromptPlan): string {
  const standIn = "placeholder prose from dry-run mode — connect a real model in Settings for real rewrites".split(" ");
  const blocks = prompt.turns.flatMap((turn) => turn.blocks);
  const selectionText = blocks.find((block) => block.kind === "selection")?.text ?? "";
  const boundaryText = blocks.filter((block) => block.kind === "boundary").map((block) => block.text).join("\n");
  // Phrase rewrites carry no end marker; their tag is on the excerpt block.
  const marker = /\[\[end-(rw-[a-f0-9]+)\]\]/.exec(boundaryText);
  const tag = marker?.[1] ?? /<(rw-[a-f0-9]+)-excerpt>/.exec(selectionText)?.[1];
  const selection = tag === undefined
    ? null
    : new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(selectionText)?.[1];
  const words = selection == null ? standIn.length : Math.max(1, selection.match(/\S+/g)?.length ?? 1);
  const replacement = Array.from({ length: words }, (_, i) => standIn[i % standIn.length]).join(" ");
  if (marker === null) return replacement;
  const rightAnchor = new RegExp(`<${marker[1]}-right>([\\s\\S]*?)</${marker[1]}-right>`).exec(boundaryText)?.[1] ?? "";
  return `${replacement}${rightAnchor}${marker[0]}`;
}

function dryRunContinuation(instruction: string): string {
  const echo = /<(ct-[a-f0-9]+)-left>([\s\S]*?)<\/\1-left>/u
    .exec(instruction)?.[2] ?? "";
  const quoted = (
    echo === ""
      ? instruction
      : "Continue the unfinished passage"
  ).trim().replace(/[.!?]+$/, "");
  return (
    `${echo} The page had gone quiet when the request arrived: "${quoted}". ` +
    "No model is connected yet, so 1667 improvises in its place. Rain ticked against the window, " +
    "the lamp settled into its work, and somewhere past the margin a sentence that was not quite " +
    "finished began to pace. This is dry-run text; open Settings to connect a real model and the " +
    "story will continue in earnest from exactly this point."
  );
}

function preparePromptCache(
  request: PromptCacheRequest | undefined,
  prompt: PromptPlan
): PreparedPromptCachePlan {
  return request === undefined
    ? { wire: PROMPT_CACHE_POLICY_OFF, commit: () => {} }
    : request.runtime.prepare(request.context, request.scope, prompt);
}

/** Join a provider API path exactly as every probe and generation request will.
 *  Anthropic users commonly include /v1 in the base even though its documented
 *  base omits it; avoid silently producing /v1/v1 for those settings. */
export function providerUrl(settings: GenerationSettings, pathName: string): string {
  const base = settings.baseUrl.replace(/\/+$/, "");
  let path = pathName.replace(/^\/+/, "");
  if (settings.provider === "anthropic" && base.endsWith("/v1") && path.startsWith("v1/")) {
    path = path.slice(3);
  }
  return `${base}/${path}`;
}

function parseEvent(data: string, secrets: readonly string[]): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    const detail = redactProviderSecrets(data, secrets).slice(0, 200);
    throw new ProviderError(`Model sent a non-JSON stream event: ${detail}`);
  }
}

function requireOutputWithinLimit(
  settings: GenerationSettings,
  currentBytes: number,
  delta: string
): number {
  const next = currentBytes + Buffer.byteLength(delta);
  const tokenDerived = Math.min(MAX_DECODED_OUTPUT_BYTES, settings.maxTokens * 32 + 64 * 1024);
  if (next > tokenDerived) {
    throw new ProviderError("provider_response_too_large: decoded model output exceeded its safety limit.");
  }
  return next;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

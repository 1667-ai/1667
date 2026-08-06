import type { GenerationSettings } from "../shared/types.js";
import {
  renderPromptPlan,
  type ChatMessage,
  type PromptOperation,
  type PromptPlan
} from "../shared/prompt-plan.js";
import { ProviderError } from "./errors.js";
import {
  isProviderObject as isObject,
  parseProviderStreamEvent as parseEvent,
  requireProviderOutputWithinLimit as requireOutputWithinLimit
} from "./provider-stream-output.js";
import { streamTextCompletion } from "./text-completion-provider.js";
import { providerUrl } from "./provider-url.js";
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
import {
  createTokenProbabilityCapture,
  dryRunProbabilityStep,
  refuseTokenProbabilities,
  tokenProbabilitiesRefused,
  tokenProbabilityRefusalKey,
  type TokenProbabilityCollector
} from "./token-probability-capture.js";
import { requireLogitBiasFamilyAvailable } from "./provider-sampling.js";
import type { StorySamplingBias } from "./sampling-phrase-bias.js";
export { ProviderError } from "./errors.js";
export type { ChatMessage, PromptPlan } from "../shared/prompt-plan.js";
export { forgetRefusedTokenProbabilities } from "./token-probability-capture.js";
export type { TokenProbabilityCollector } from "./token-probability-capture.js";

/** Why the stream ended, when the provider said so: "length" means the output
 *  limit cut generation short; "stop" means the model finished on its own.
 *  Callers that need it pass a box the provider fills as the stream closes. */
export interface StreamOutcome {
  finishReason: "stop" | "length" | null;
}

/** `streamCompletion`'s optional trailing values, grouped into one object
 * (issue #341) rather than a growing run of positional parameters — adding
 * `storySampling` as a fourth trailing optional would have made a seventh
 * positional parameter overall. `storySampling` is the one story's own
 * phraseBias/bannedStrings overlay; every caller that has no story in play
 * (title and summary generation) omits it, which resolves exactly as it did
 * before a story could contribute anything (`resolveSamplingBiasForSettings`,
 * server/sampling-phrase-bias.ts). The three private generators below each
 * take this same object, rather than re-threading its fields positionally
 * (issue #341 finding 5): `streamCompletion` hands it on whole, and each
 * generator destructures only the fields its own body reads, so no layer in
 * between can grow one field of it without the others. */
export interface StreamCompletionOptions {
  readonly outcome?: StreamOutcome;
  readonly providerStarted?: () => void | Promise<void>;
  readonly promptCache?: PromptCacheRequest;
  readonly storySampling?: StorySamplingBias;
  readonly tokenProbabilities?: TokenProbabilityCollector;
}

export function streamCompletion(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  options: StreamCompletionOptions = {}
): AsyncGenerator<string> {
  switch (settings.provider) {
    case "dry-run":
      return streamDryRun(settings, prompt, signal, options);
    case "anthropic":
      return streamAnthropic(settings, prompt, signal, options);
    case "openai-compatible":
      return streamOpenAiCompatible(settings, prompt, signal, options);
    case "text-completion":
      return streamTextCompletion(settings, prompt, signal, options);
  }
}

async function* streamOpenAiCompatible(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  options: StreamCompletionOptions
): AsyncGenerator<string> {
  const { outcome, providerStarted, promptCache, storySampling, tokenProbabilities } = options;
  const { headers, secrets } = resolveProviderHeaders(settings, {
    "content-type": "application/json"
  });
  const prepared = preparePromptCache(promptCache, prompt);
  const body = await buildOpenAiChatRequestBody(settings, prompt, prepared.wire, { signal, storySampling });
  const runtime = providerRuntimeFor(settings);
  const explicitEffort = runtime.effort !== "default";
  const tokenProbabilityKey = tokenProbabilityRefusalKey(settings);
  if (tokenProbabilitiesRefused(tokenProbabilityKey)) {
    // Paid once per model: a prior request already learned this endpoint
    // rejects the fields, so this one never asks again (issue #291 phase 2,
    // point 6) — mirrors SAMPLING_REFUSED's temperature strip below.
    delete body.logprobs;
    delete body.top_logprobs;
  }
  const requestedAlternatives = typeof body.top_logprobs === "number" ? body.top_logprobs : null;
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
      // Fresh per attempt: only the attempt that actually finishes ever
      // calls capture.finish() below, so a retried attempt's partial capture
      // (if any) is never mixed with the one that succeeds.
      const capture = createTokenProbabilityCapture(tokenProbabilities, requestedAlternatives, secrets);
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
            capture.finish();
            return;
          }
          const parsed = parseEvent(data, secrets);
          const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
          if (isObject(choice) && typeof choice.finish_reason === "string" && outcome !== undefined) {
            outcome.finishReason = choice.finish_reason === "length" ? "length" : "stop";
          }
          capture.observe(choice);
          const delta = isObject(choice) && isObject(choice.delta) ? choice.delta.content : undefined;
          if (typeof delta === "string" && delta.length > 0) {
            decodedBytes = requireOutputWithinLimit(settings, decodedBytes, delta);
            const safe = outputRedactor.push(delta);
            if (safe.length > 0) yield safe;
          }
        }
        const tail = outputRedactor.finish();
        if (tail.length > 0) yield tail;
        capture.finish();
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
          || !adjustRejectedParameter(body, error, prompt.operation, explicitEffort, settings)
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
  explicitEffort: boolean,
  settings: GenerationSettings
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
  if (
    detail.code === "unsupported_parameter"
    && (detail.param === "top_logprobs" || detail.param === "logprobs")
    && ("logprobs" in body || "top_logprobs" in body)
  ) {
    delete body.logprobs;
    delete body.top_logprobs;
    refuseTokenProbabilities(tokenProbabilityRefusalKey(settings));
    return true;
  }
  return false;
}

async function* streamAnthropic(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  options: StreamCompletionOptions
): AsyncGenerator<string> {
  const { outcome, providerStarted, promptCache, storySampling } = options;
  const { headers, secrets } = resolveProviderHeaders(settings, {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01"
  });
  const prepared = preparePromptCache(promptCache, prompt);
  const body = await buildAnthropicMessagesRequestBody(settings, prompt, prepared.wire, { signal, storySampling });
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

/** Dry-run never sends a provider request at all, so it never reaches
 * `applySamplingFields` — the OpenAI and Anthropic branches above build a
 * real request body and get this check for free. Without a check of its own,
 * a story's phrase bias or banned strings used to generate successfully
 * through dry-run while the capability matrix marks the whole sampling
 * family unavailable there and the editor's own preview reports failure
 * (issue #341 finding 2b): a writer would see a working generation that
 * disagreed with the preview that told them it would not work. Checked
 * first, before any placeholder text is produced, so dry-run refuses the
 * same story-only configuration a real request or the preview would —
 * `requireLogitBiasFamilyAvailable` (server/provider-sampling.ts) does
 * nothing when neither the profile nor the story has anything in the
 * logit-bias family configured, so dry-run keeps working exactly as before
 * whenever there is nothing to disagree about. */
async function* streamDryRun(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  options: StreamCompletionOptions
): AsyncGenerator<string> {
  const { outcome, storySampling, tokenProbabilities } = options;
  requireLogitBiasFamilyAvailable(settings, "dry-run", storySampling);
  const messages = renderPromptPlan(prompt);
  const instruction = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const text = prompt.operation === "rewrite"
    ? dryRunRewrite(prompt)
    : prompt.operation === "title"
      ? instruction.includes("fork of the different story") ? "Embers on Another Road" : "The Quiet After Rain"
      : prompt.operation === "summary"
        ? dryRunSummary(prompt)
        : dryRunContinuation(instruction);
  // Dry run reaches no endpoint and is given no credential, so it has no
  // secret that a captured token could carry back.
  const requestedAlternatives = providerRuntimeFor(settings).tokenProbabilities;
  const capture = createTokenProbabilityCapture(tokenProbabilities, requestedAlternatives, []);
  // A capture with nothing to record still needs a definite `requested` to
  // build a step from; the value is discarded either way once `capture.push`
  // sees this capture is inactive, so any in-bounds fallback does.
  const requested = requestedAlternatives ?? 1;
  let stepIndex = 0;
  // Keep the first chunk's leading boundary character: append continuations are
  // joined byte-for-byte, so a leading space is meaningful.
  for (const word of text.match(/\s*\S+/g) ?? []) {
    if (signal.aborted) return;
    yield word;
    // Dry-run really does fabricate one step per yielded chunk — it is not
    // pretending, the way an unavailable sampling knob would be (issue #291
    // phase 2). Deterministic: no clock, no randomness, so the same prompt
    // always fabricates the same record.
    capture.push(dryRunProbabilityStep(word, requested, stepIndex));
    stepIndex += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  if (outcome !== undefined) outcome.finishReason = "stop";
  capture.finish();
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

export { providerRoot, providerUrl } from "./provider-url.js";

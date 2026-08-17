import { createHash } from "node:crypto";
import { canonicalJson } from "../../server/canonical-json.js";
import {
  aggregateRequestFingerprint,
  armOrder,
  parseCandidateOptimization,
  GEMMA_REPLAY_ARMS,
  GEMMA_REPLAY_FIXTURE,
  GEMMA_REPLAY_HARNESS,
  GEMMA_REPLAY_OPERATIONS,
  GEMMA_REPLAY_SCHEMA_VERSION,
  GEMMA_REPLAY_SEEDS,
  GEMMA_V08_BASELINE_REQUEST_FINGERPRINT,
  type GemmaReplayArm,
  type GemmaReplayOperation
} from "./contract.js";
import { parseGemmaRuntimeConfiguration, type GemmaRuntimeRecord } from "./runtime.js";
import { validateReplayProfileBoundary } from "./profile.js";
import { assertApprovedReplay } from "./approved-replay.js";
import type { ReplayProfileBoundary } from "./profile.js";
import type { SamplingSettingsV2 } from "../../shared/settings-v2-types.js";
import type {
  ReplayEndpoint,
  ReplayOutput,
  ReplayProfileRecord,
  ReplayRequestMetadata,
  ReplayResult,
  ReplaySample
} from "./runner.js";

/** Parse a raw replay before a blind pack or score can use it. */
export function parseReplayResult(value: unknown): ReplayResult {
  const replay = record(value, "replay");
  requireKeys(replay, [
    "schemaVersion",
    "harness",
    "fixture",
    "optimization",
    "operatorAcknowledgedExclusiveServer",
    "baselineRequestFingerprint",
    "candidateRequestFingerprint",
    "runtime",
    "profile",
    "endpoint",
    "seeds",
    "operations",
    "samples"
  ], "replay");
  exact(replay.schemaVersion, GEMMA_REPLAY_SCHEMA_VERSION, "replay.schemaVersion");
  exact(replay.harness, GEMMA_REPLAY_HARNESS, "replay.harness");
  exact(replay.fixture, GEMMA_REPLAY_FIXTURE, "replay.fixture");
  const optimization = parseCandidateOptimization(replay.optimization, "replay.optimization");
  exact(
    replay.operatorAcknowledgedExclusiveServer,
    true,
    "replay.operatorAcknowledgedExclusiveServer"
  );
  const baselineRequestFingerprint = fingerprint(replay.baselineRequestFingerprint, "replay.baselineRequestFingerprint");
  const candidateRequestFingerprint = fingerprint(replay.candidateRequestFingerprint, "replay.candidateRequestFingerprint");
  const runtime = parseRuntime(replay.runtime);
  if (baselineRequestFingerprint !== GEMMA_V08_BASELINE_REQUEST_FINGERPRINT) {
    throw new Error("replay baseline request fingerprint does not match v0.8.0");
  }
  const profile = parseProfile(replay.profile, runtime);
  assertApprovedReplay(runtime, profile);
  const endpoint = parseEndpoint(replay.endpoint);
  if (endpoint.model !== runtime.configuration.model.id) {
    throw new Error("replay endpoint model does not match the checked runtime configuration");
  }
  const seeds = exactSeeds(replay.seeds);
  const operations = exactOperations(replay.operations);
  if (!Array.isArray(replay.samples) || replay.samples.length !== 10) {
    throw new Error("replay.samples must contain 10 paired samples");
  }
  const samples = replay.samples.map((sample, index) => parseSample(sample, index, endpoint, profile));
  const expected = new Set(GEMMA_REPLAY_OPERATIONS.flatMap((operation) => GEMMA_REPLAY_SEEDS.map((seed) => `${operation}-${seed}`)));
  const seen = new Set(samples.map((sample) => sample.pairId));
  if (seen.size !== expected.size || [...expected].some((id) => !seen.has(id))) {
    throw new Error("replay.samples must contain every operation and seed exactly once");
  }
  const baselineAggregate = aggregateRequestFingerprint(samples.map((sample) => ({
    operation: sample.operation,
    seed: sample.seed,
    requestFingerprint: sample.baseline.request.bodyFingerprint
  })));
  if (baselineAggregate !== baselineRequestFingerprint) throw new Error("replay baseline request fingerprint is invalid");
  if (aggregateRequestFingerprint(samples.map((sample) => ({
    operation: sample.operation,
    seed: sample.seed,
    requestFingerprint: sample.candidate.request.bodyFingerprint
  }))) !== candidateRequestFingerprint) {
    throw new Error("replay candidate request fingerprint is invalid");
  }
  return {
    schemaVersion: 1,
    harness: GEMMA_REPLAY_HARNESS,
    fixture: GEMMA_REPLAY_FIXTURE,
    optimization,
    operatorAcknowledgedExclusiveServer: true,
    baselineRequestFingerprint,
    candidateRequestFingerprint,
    runtime,
    profile,
    endpoint,
    seeds,
    operations,
    samples
  };
}

function parseProfile(value: unknown, runtime: GemmaRuntimeRecord): ReplayProfileRecord {
  const profile = record(value, "replay.profile");
  requireKeys(profile, ["name", "sourceFingerprint", "temperature", "maxOutputTokens", "effort", "cachePolicy", "tokenProbabilities", "sampling", "timeouts", "logitBiasState"], "replay.profile");
  if (typeof profile.name !== "string" || profile.name.length === 0) throw new Error("replay.profile.name is invalid");
  const sourceFingerprint = fingerprint(profile.sourceFingerprint, "replay.profile.sourceFingerprint");
  if (typeof profile.temperature !== "number" || !Number.isFinite(profile.temperature)) throw new Error("replay.profile.temperature is invalid");
  if (typeof profile.maxOutputTokens !== "number" || !Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 1) throw new Error("replay.profile.maxOutputTokens is invalid");
  if (profile.effort !== "default") {
    throw new Error("Gemma replay requires generation.effort to be default because the checked runtime does not declare reasoning-effort support");
  }
  if (typeof profile.cachePolicy !== "string") throw new Error("replay.profile generation settings are invalid");
  if (profile.cachePolicy !== "off") throw new Error("replay profile must disable prompt caching");
  if (profile.tokenProbabilities !== null && (typeof profile.tokenProbabilities !== "number" || !Number.isSafeInteger(profile.tokenProbabilities))) throw new Error("replay.profile.tokenProbabilities is invalid");
  const sampling = record(profile.sampling, "replay.profile.sampling");
  if (profile.logitBiasState !== "empty" && profile.logitBiasState !== "present") {
    throw new Error("replay.profile.logitBiasState is invalid");
  }
  const logitBias = record(sampling.logitBias, "replay.profile.sampling.logitBias");
  if ((Object.keys(logitBias).length === 0) !== (profile.logitBiasState === "empty")) {
    throw new Error("replay.profile.logitBiasState does not match sampling.logitBias");
  }
  const parsed: ReplayProfileBoundary = {
    name: profile.name,
    sourceFingerprint,
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    effort: "default",
    cachePolicy: "off",
    tokenProbabilities: profile.tokenProbabilities,
    sampling,
    timeouts: profile.timeouts as import("../../shared/settings-v2-types.js").ConnectionTimeoutsV2,
    logitBiasState: profile.logitBiasState
  };
  return validateReplayProfileBoundary(parsed, runtime);
}

function parseRuntime(value: unknown): GemmaRuntimeRecord {
  const runtime = record(value, "replay.runtime");
  requireKeys(runtime, ["configuration", "fingerprint"], "replay.runtime");
  const parsed = parseGemmaRuntimeConfiguration(runtime.configuration);
  const fingerprintValue = fingerprint(runtime.fingerprint, "replay.runtime.fingerprint");
  if (fingerprintValue !== parsed.fingerprint) {
    throw new Error("replay.runtime.fingerprint does not match configuration");
  }
  return parsed;
}

function parseEndpoint(value: unknown): ReplayEndpoint {
  const endpoint = record(value, "replay.endpoint");
  requireKeys(endpoint, ["baseUrl", "requestUrl", "model", "apiKeyConfigured"], "replay.endpoint");
  if (typeof endpoint.baseUrl !== "string" || typeof endpoint.requestUrl !== "string" || typeof endpoint.model !== "string") throw new Error("replay.endpoint is invalid");
  if (typeof endpoint.apiKeyConfigured !== "boolean") throw new Error("replay.endpoint.apiKeyConfigured is invalid");
  const baseUrl = normalizedUrl(endpoint.baseUrl, "replay.endpoint.baseUrl");
  const requestUrl = normalizedUrl(endpoint.requestUrl, "replay.endpoint.requestUrl");
  const url = new URL(requestUrl);
  if (url.pathname !== "/v1/chat/completions") throw new Error("replay endpoint must use /v1/chat/completions");
  const expectedRequestUrl = normalizedUrl(
    `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    "replay.endpoint.baseUrl"
  );
  if (requestUrl !== expectedRequestUrl) {
    throw new Error("replay endpoint request URL does not match its base URL");
  }
  return {
    baseUrl,
    requestUrl,
    model: endpoint.model as string,
    apiKeyConfigured: endpoint.apiKeyConfigured as boolean
  };
}

function parseSample(
  value: unknown,
  index: number,
  endpoint: ReplayEndpoint,
  profile: ReplayProfileRecord
): ReplaySample {
  const sample = record(value, `replay.samples[${index}]`);
  requireKeys(sample, ["sampleId", "pairId", "operation", "seed", "dispatchOrder", "baseline", "candidate"], `replay.samples[${index}]`);
  const operation = oneOf(sample.operation, GEMMA_REPLAY_OPERATIONS, `sample ${index}.operation`);
  const seed = numberSeed(sample.seed, `sample ${index}.seed`);
  const pairId = `${operation}-${seed}`;
  exact(sample.sampleId, pairId, `sample ${index}.sampleId`);
  exact(sample.pairId, pairId, `sample ${index}.pairId`);
  const dispatchOrder = parseDispatchOrder(
    sample.dispatchOrder,
    operation,
    seed,
    `sample ${index}.dispatchOrder`
  );
  const baseline = parseOutput(sample.baseline, `sample ${index}.baseline`, endpoint, seed);
  const candidate = parseOutput(sample.candidate, `sample ${index}.candidate`, endpoint, seed);
  verifyPairSettings(baseline.request, candidate.request, profile, endpoint.model, seed, `sample ${index}`);
  return {
    sampleId: pairId,
    pairId,
    operation,
    seed,
    dispatchOrder,
    baseline,
    candidate
  };
}

function parseOutput(value: unknown, label: string, endpoint: ReplayEndpoint, seed: number): ReplayOutput {
  const output = record(value, label);
  requireKeys(output, ["output", "outputFingerprint", "request"], label);
  if (typeof output.output !== "string") throw new Error(`${label}.output is invalid`);
  const outputFingerprint = fingerprint(output.outputFingerprint, `${label}.outputFingerprint`);
  if (outputFingerprint !== textHash(output.output)) throw new Error(`${label}.outputFingerprint does not match output`);
  const request = parseRequest(output.request, `${label}.request`, endpoint, seed);
  return { output: output.output, outputFingerprint, request };
}

function parseRequest(value: unknown, label: string, endpoint: ReplayEndpoint, seed: number): ReplayRequestMetadata {
  const request = record(value, label);
  requireKeys(request, ["url", "protocol", "preset", "model", "temperature", "maxTokens", "sampling", "headers", "promptShape", "promptFingerprint", "bodyFingerprint", "body"], label);
  const requestUrl = normalizedUrl(request.url, `${label}.url`);
  if (requestUrl !== endpoint.requestUrl) throw new Error(`${label}.url does not match replay.endpoint.requestUrl`);
  exact(request.protocol, "openai-chat-completions", `${label}.protocol`);
  exact(request.preset, "koboldcpp", `${label}.preset`);
  exact(request.model, endpoint.model, `${label}.model`);
  if (request.temperature !== null && typeof request.temperature !== "number") throw new Error(`${label}.temperature is invalid`);
  if (typeof request.maxTokens !== "number" || !Number.isSafeInteger(request.maxTokens)) throw new Error(`${label}.maxTokens is invalid`);
  if (!Array.isArray(request.headers) || request.headers.some((header) => typeof header !== "string")) throw new Error(`${label}.headers is invalid`);
  record(request.promptShape, `${label}.promptShape`);
  fingerprint(request.promptFingerprint, `${label}.promptFingerprint`);
  const body = record(request.body, `${label}.body`);
  const bodyFingerprint = fingerprint(request.bodyFingerprint, `${label}.bodyFingerprint`);
  if (bodyFingerprint !== hash(body)) throw new Error(`${label}.bodyFingerprint does not match body`);
  exact(body.model, endpoint.model, `${label}.body.model`);
  exact(body.max_tokens, request.maxTokens, `${label}.body.max_tokens`);
  exact(body.stream, true, `${label}.body.stream`);
  exact(body.cache_prompt, false, `${label}.body.cache_prompt`);
  if (request.temperature === null) {
    if (Object.hasOwn(body, "temperature")) throw new Error(`${label}.body.temperature must be absent`);
  } else exact(body.temperature, request.temperature, `${label}.body.temperature`);
  const expectedSampling = Object.fromEntries(Object.entries(body).filter(([key]) => !["model", "messages", "max_tokens", "stream", "temperature"].includes(key)));
  if (canonicalJson(request.sampling) !== canonicalJson(expectedSampling)) throw new Error(`${label}.sampling does not match body`);
  if (body.seed !== seed) throw new Error(`${label}.body.seed does not match sample seed`);
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error(`${label}.body.messages is invalid`);
  return {
    url: requestUrl,
    protocol: "openai-chat-completions",
    preset: "koboldcpp",
    model: request.model as string,
    temperature: request.temperature as number | null,
    maxTokens: request.maxTokens as number,
    sampling: request.sampling as Record<string, unknown>,
    headers: request.headers as string[],
    promptShape: request.promptShape as Record<string, unknown>,
    promptFingerprint: request.promptFingerprint as string,
    bodyFingerprint,
    body
  };
}

/** Verify the pair used one generation configuration. Prompt messages are the
 * one intentional difference. KoboldCpp's cache flag is also common to both
 * arms, but it is checked separately so a future arm comparison cannot hide
 * an accidental cache re-enable. */
function verifyPairSettings(
  baseline: ReplayRequestMetadata,
  candidate: ReplayRequestMetadata,
  profile: ReplayProfileRecord,
  model: string,
  seed: number,
  label: string
): void {
  if (canonicalJson(generationSettings(baseline.body)) !== canonicalJson(generationSettings(candidate.body))) {
    throw new Error(`${label} baseline and candidate generation settings differ`);
  }
  const expected = expectedGenerationSettings(profile, model, seed);
  if (canonicalJson(generationSettings(baseline.body)) !== canonicalJson(expected)) {
    throw new Error(`${label} generation settings do not match the replay profile and fixed seed`);
  }
}

function generationSettings(body: Record<string, unknown>): Record<string, unknown> {
  const { messages: _messages, cache_prompt: _cachePrompt, ...settings } = body;
  return settings;
}

/** Lower the route-neutral profile fields to the exact KoboldCpp Chat
 * Completions fields used by `buildOpenAiChatRequestBody`. This is deliberately
 * strict: a profile feature that needs server-side tokenization cannot be
 * verified from compact replay metadata and is refused at profile import. */
function expectedGenerationSettings(
  profile: ReplayProfileRecord,
  model: string,
  seed: number
): Record<string, unknown> {
  const expected: Record<string, unknown> = {
    model,
    max_tokens: profile.maxOutputTokens,
    stream: true,
    seed
  };
  if (profile.temperature !== null) expected.temperature = profile.temperature;
  const sampling = profile.sampling;
  const wireFields: readonly (readonly [keyof SamplingSettingsV2, string])[] = [
    ["topP", "top_p"], ["topK", "top_k"], ["minP", "min_p"],
    ["frequencyPenalty", "frequency_penalty"], ["presencePenalty", "presence_penalty"],
    ["repeatPenalty", "repeat_penalty"], ["dryMultiplier", "dry_multiplier"],
    ["dryBase", "dry_base"], ["dryRange", "dry_penalty_last_n"],
    ["xtcThreshold", "xtc_threshold"], ["xtcProbability", "xtc_probability"],
    ["dynatempRange", "dynatemp_range"], ["mirostat", "mirostat_mode"],
    ["mirostatTau", "mirostat_tau"], ["mirostatEta", "mirostat_eta"],
    ["dryBreakers", "dry_sequence_breakers"], ["stop", "stop"], ["logitBias", "logit_bias"]
  ];
  for (const [profileField, wireField] of wireFields) {
    const value = sampling[profileField];
    if (value === undefined || value === null) continue;
    if ((profileField === "mirostatTau" || profileField === "mirostatEta") && sampling.mirostat === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (profileField === "logitBias" && typeof value === "object" && Object.keys(value).length === 0) continue;
    expected[wireField] = value;
  }
  if (profile.tokenProbabilities !== null) {
    expected.logprobs = true;
    expected.top_logprobs = profile.tokenProbabilities;
  }
  if (profile.effort !== "default") {
    expected.reasoning_effort = profile.effort === "off" ? "none" : profile.effort;
  }
  return expected;
}

function parseDispatchOrder(
  value: unknown,
  operation: GemmaReplayOperation,
  seed: (typeof GEMMA_REPLAY_SEEDS)[number],
  label: string
): readonly GemmaReplayArm[] {
  if (!Array.isArray(value) || value.length !== GEMMA_REPLAY_ARMS.length || value.some((arm) => !GEMMA_REPLAY_ARMS.includes(arm as GemmaReplayArm)) || new Set(value).size !== GEMMA_REPLAY_ARMS.length) throw new Error(`${label} must contain baseline and candidate exactly once`);
  const order = value as GemmaReplayArm[];
  if (canonicalJson(order) !== canonicalJson(armOrder(operation, seed))) {
    throw new Error(`${label} does not match the fixed balanced dispatch schedule`);
  }
  return order;
}

function exactSeeds(value: unknown): readonly (typeof GEMMA_REPLAY_SEEDS[number])[] {
  if (!Array.isArray(value) || canonicalJson(value) !== canonicalJson(GEMMA_REPLAY_SEEDS)) throw new Error("replay.seeds does not match the fixed seed set");
  return [...GEMMA_REPLAY_SEEDS];
}

function exactOperations(value: unknown): readonly GemmaReplayOperation[] {
  if (!Array.isArray(value) || canonicalJson(value) !== canonicalJson(GEMMA_REPLAY_OPERATIONS)) throw new Error("replay.operations does not match the replay contract");
  return [...GEMMA_REPLAY_OPERATIONS];
}

function numberSeed(value: unknown, label: string): (typeof GEMMA_REPLAY_SEEDS[number]) {
  if (typeof value !== "number" || !GEMMA_REPLAY_SEEDS.includes(value as (typeof GEMMA_REPLAY_SEEDS[number]))) throw new Error(`${label} is invalid`);
  return value as (typeof GEMMA_REPLAY_SEEDS[number]);
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is invalid`);
  return value as T[number];
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 fingerprint`);
  return value;
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function textHash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function normalizedUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  try {
    return new URL(value).href;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`${label} is invalid`);
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const received = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (received.length !== expected.length || received.some((key, index) => key !== expected[index])) throw new Error(`${label} has unsupported or missing fields`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

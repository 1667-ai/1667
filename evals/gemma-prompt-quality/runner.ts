import { createHash } from "node:crypto";
import { buildOpenAiChatRequestBody } from "../../server/provider-request-body.js";
import { providerUrl } from "../../server/provider-url.js";
import { providerSseEvents } from "../../server/provider-sse.js";
import {
  parseProviderStreamEvent,
  requireProviderOutputWithinLimit
} from "../../server/provider-stream-output.js";
import {
  redactProviderSecrets,
  resolveProviderHeaders
} from "../../server/provider-runtime.js";
import { canonicalJson } from "../../server/canonical-json.js";
import { renderPromptPlan, type PromptPlan } from "../../shared/prompt-plan.js";
import { assembleContinuation } from "../../server/continuation-assembly.js";
import {
  GEMMA_AUTHOR_BRIEF,
  assertGemmaFixtureContextSize,
  GEMMA_FACTS_BLOCK,
  GEMMA_OPERATION_FIXTURES,
  GEMMA_REPLAY_SEEDS,
  type GemmaOperationFixture,
  type GemmaReplayOperation
} from "./fixture.js";
import {
  aggregateRequestFingerprint,
  armOrder,
  GEMMA_REPLAY_FIXTURE,
  GEMMA_REPLAY_HARNESS,
  GEMMA_REPLAY_OPERATIONS,
  GEMMA_REPLAY_SCHEMA_VERSION,
  type GemmaReplayArm
} from "./contract.js";
import {
  baselineContinuationPlan,
  baselinePlanFingerprint,
  requestShape,
  V08_BASELINE_PLAN_FINGERPRINT
} from "./baseline.js";
import { replaySettings, type ReplayProfile } from "./profile.js";
import type { GemmaRuntimeRecord } from "./runtime.js";
import { writePrivateJson } from "./private-json-file.js";
import { assertApprovedReplay } from "./approved-replay.js";
import {
  frozenV08SourceFingerprint,
  protectedEvaluationInputFingerprint,
  protectedPromptSourceFingerprint
} from "./source-fingerprint.js";

export interface ReplayRequestMetadata {
  readonly url: string;
  readonly protocol: "openai-chat-completions";
  readonly preset: "llama-cpp";
  readonly model: string;
  readonly temperature: number | null;
  readonly maxTokens: number;
  readonly sampling: Readonly<Record<string, unknown>>;
  readonly headers: readonly string[];
  readonly promptShape: Record<string, unknown>;
  readonly promptFingerprint: string;
  readonly bodyFingerprint: string;
  readonly body: Record<string, unknown>;
}

export interface ReplaySample {
  readonly sampleId: string;
  readonly pairId: string;
  readonly operation: GemmaReplayOperation;
  readonly seed: number;
  readonly dispatchOrder: readonly GemmaReplayArm[];
  readonly baseline: ReplayOutput;
  readonly candidate: ReplayOutput;
}

export interface ReplayOutput {
  readonly output: string;
  readonly outputFingerprint: string;
  readonly request: ReplayRequestMetadata;
}

export interface ReplayResult {
  readonly schemaVersion: 1;
  readonly harness: typeof GEMMA_REPLAY_HARNESS;
  readonly fixture: typeof GEMMA_REPLAY_FIXTURE;
  readonly baselineSourceFingerprint: string;
  readonly baselineRequestFingerprint: string;
  readonly candidateSourceFingerprint: string;
  /** Evaluation fixture and approved protocol identity. */
  readonly evaluationInputFingerprint: string;
  readonly candidateRequestFingerprint: string;
  readonly runtime: GemmaRuntimeRecord;
  readonly profile: ReplayProfileRecord;
  readonly endpoint: ReplayEndpoint;
  readonly seeds: readonly number[];
  readonly operations: readonly GemmaReplayOperation[];
  readonly samples: readonly ReplaySample[];
}

export type ReplayProfileRecord = ReplayProfile;

export interface ReplayEndpoint {
  readonly baseUrl: string;
  readonly requestUrl: string;
  readonly model: string;
  readonly apiKeyConfigured: boolean;
}

export interface ReplayOptions {
  readonly endpointBaseUrl: string;
  /** Compatibility check only. The manifest owns the actual request model. */
  readonly model?: string;
  readonly runtime: GemmaRuntimeRecord;
  readonly profile: ReplayProfile;
  readonly repositoryRoot?: string;
}

/** Compute the protected current prompt-source identity used by evidence. */
export { protectedPromptSourceFingerprint } from "./source-fingerprint.js";

export interface ReplayRequestPair {
  readonly operation: GemmaOperationFixture;
  readonly seed: (typeof GEMMA_REPLAY_SEEDS)[number];
  readonly settings: ReturnType<typeof replaySettings>;
  readonly baseline: { readonly prompt: PromptPlan; readonly body: Record<string, unknown> };
  readonly candidate: { readonly prompt: PromptPlan; readonly body: Record<string, unknown> };
}

/** Build every deterministic request once. The runner and compatibility gate
 * use this same projection; only transport output remains non-recomputable. */
export async function buildReplayRequestPairs(
  endpointBaseUrl: string,
  runtime: GemmaRuntimeRecord,
  profile: ReplayProfile
): Promise<readonly ReplayRequestPair[]> {
  const pairs: ReplayRequestPair[] = [];
  for (const operation of GEMMA_OPERATION_FIXTURES) {
    for (const seed of GEMMA_REPLAY_SEEDS) {
      const settings = replaySettings(endpointBaseUrl, runtime.configuration, profile, seed);
      const baselinePrompt = baselineContinuationPlan(operation, GEMMA_AUTHOR_BRIEF, GEMMA_FACTS_BLOCK);
      const candidatePrompt = assembleContinuation({
        story: {
          authorBrief: GEMMA_AUTHOR_BRIEF,
          authorsNote: operation.authorsNote.text,
          authorsNoteDepth: operation.authorsNote.depth,
          chapterBreaks: operation.chapterBreaks,
          nodes: operation.nodes
        },
        settings,
        contextParts: operation.context,
        instruction: operation.instruction,
        appendLast: operation.appendLast,
        images: []
      }).plan(GEMMA_FACTS_BLOCK).prompt;
      assertGemmaFixtureContextSize(baselinePrompt);
      assertGemmaFixtureContextSize(candidatePrompt);
      const baselineBody = await buildOpenAiChatRequestBody(
        settings,
        baselinePrompt,
        { kind: "omit", reason: "policy-off" }
      );
      const candidateBody = await buildOpenAiChatRequestBody(
        settings,
        candidatePrompt,
        { kind: "omit", reason: "policy-off" }
      );
      baselineBody.cache_prompt = false;
      candidateBody.cache_prompt = false;
      pairs.push({
        operation,
        seed,
        settings,
        baseline: { prompt: baselinePrompt, body: baselineBody },
        candidate: { prompt: candidatePrompt, body: candidateBody }
      });
    }
  }
  return pairs;
}

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  frozenBaselineFingerprint();
  assertApprovedReplay(options.runtime, options.profile);
  if (options.model !== undefined && options.model !== options.runtime.configuration.model.id) {
    throw new Error("Gemma replay --model must match the checked runtime configuration model.id");
  }
  if (options.profile.cachePolicy !== "off") {
    throw new Error("Gemma replay requires Profile Export generation.cachePolicy to be off");
  }
  const requestPairs = await buildReplayRequestPairs(options.endpointBaseUrl, options.runtime, options.profile);
  const samples: ReplaySample[] = [];
  for (const pair of requestPairs) samples.push(await runPair(pair));
  const profile = options.profile;
  const candidateSourceFingerprint = protectedPromptSourceFingerprint(options.repositoryRoot);
  const evaluationInputFingerprint = protectedEvaluationInputFingerprint(options.repositoryRoot);
  return {
    schemaVersion: GEMMA_REPLAY_SCHEMA_VERSION,
    harness: GEMMA_REPLAY_HARNESS,
    fixture: GEMMA_REPLAY_FIXTURE,
    baselineSourceFingerprint: frozenV08SourceFingerprint(options.repositoryRoot),
    baselineRequestFingerprint: aggregateRequestFingerprint(samples.map((sample) => ({
      operation: sample.operation,
      seed: sample.seed,
      requestFingerprint: sample.baseline.request.bodyFingerprint
    }))),
    candidateSourceFingerprint,
    evaluationInputFingerprint,
    candidateRequestFingerprint: aggregateRequestFingerprint(samples.map((sample) => ({
      operation: sample.operation,
      seed: sample.seed,
      requestFingerprint: sample.candidate.request.bodyFingerprint
    }))),
    runtime: options.runtime,
    profile: {
      name: profile.name,
      sourceFingerprint: profile.sourceFingerprint,
      temperature: profile.temperature,
      maxOutputTokens: profile.maxOutputTokens,
      effort: profile.effort,
      cachePolicy: profile.cachePolicy,
      tokenProbabilities: profile.tokenProbabilities,
      sampling: { ...profile.sampling },
      logitBiasState: profile.logitBiasState
    },
    endpoint: {
      baseUrl: options.endpointBaseUrl,
      requestUrl: providerUrl(requestPairs[0]!.settings, "/chat/completions"),
      model: options.runtime.configuration.model.id,
      apiKeyConfigured: process.env.GEMMA_API_KEY !== undefined
    },
    seeds: [...GEMMA_REPLAY_SEEDS],
    operations: [...GEMMA_REPLAY_OPERATIONS],
    samples
  };
}

export async function writeReplay(pathname: string, result: ReplayResult): Promise<void> {
  await writePrivateJson(pathname, result);
}

async function runPair(pair: ReplayRequestPair): Promise<ReplaySample> {
  const { operation, seed, settings, baseline, candidate } = pair;
  const dispatchOrder = armOrder(operation.operation, seed);
  const outputs = {} as Record<GemmaReplayArm, string>;
  for (const arm of dispatchOrder) {
    const body = arm === "baseline" ? baseline.body : candidate.body;
    outputs[arm] = await streamOutput(settings, body);
  }
  const pairId = `${operation.operation}-${seed}`;
  return {
    sampleId: pairId,
    pairId,
    operation: operation.operation,
    seed,
    dispatchOrder,
    baseline: replayOutput(outputs.baseline, settings, baseline.prompt, baseline.body),
    candidate: replayOutput(outputs.candidate, settings, candidate.prompt, candidate.body)
  };
}

function replayOutput(
  output: string,
  settings: ReturnType<typeof replaySettings>,
  prompt: PromptPlan,
  body: Record<string, unknown>
): ReplayOutput {
  return {
    output,
    outputFingerprint: `sha256:${sha256(output)}`,
    request: requestMetadata(settings, prompt, body)
  };
}

async function streamOutput(
  settings: ReturnType<typeof replaySettings>,
  body: Record<string, unknown>
): Promise<string> {
  const signal = new AbortController().signal;
  const { headers, secrets } = resolveProviderHeaders(settings, {
    "content-type": "application/json"
  });
  let output = "";
  let outputBytes = 0;
  // Use the production transport and stream parser, but pass this exact body
  // once. The normal generation path may retry by mutating its body after a
  // provider 400; a scientific replay must record the body that actually
  // produced the output, so the harness fails instead of hiding that change.
  for await (const data of providerSseEvents(
    settings,
    providerUrl(settings, "/chat/completions"),
    body,
    headers,
    secrets,
    signal,
    redactProviderSecrets,
    undefined,
    undefined,
    (event) => event !== "[DONE]",
    (event) => event === "[DONE]",
    signal
  )) {
    if (data === "[DONE]") continue;
    const parsed = parseProviderStreamEvent(data, secrets);
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    if (choice === null || typeof choice !== "object" || Array.isArray(choice)) continue;
    const delta = (choice as Record<string, unknown>).delta;
    if (delta === null || typeof delta !== "object" || Array.isArray(delta)) continue;
    const text = (delta as Record<string, unknown>).content;
    if (typeof text !== "string" || text.length === 0) continue;
    outputBytes = requireProviderOutputWithinLimit(settings, outputBytes, text);
    output += text;
  }
  if (output.length === 0) throw new Error("Gemma replay received an empty model output");
  return output;
}

function requestMetadata(
  settings: ReturnType<typeof replaySettings>,
  prompt: PromptPlan,
  body: Record<string, unknown>
): ReplayRequestMetadata {
  const rendered = renderPromptPlan(prompt);
  const promptFingerprint = `sha256:${sha256(canonicalJson(rendered))}`;
  const bodyFingerprint = replayRequestBodyFingerprint(body);
  const sampling = Object.fromEntries(
    Object.entries(body).filter(([key]) => !["model", "messages", "max_tokens", "stream", "temperature"].includes(key))
  );
  return {
    url: providerUrl(settings, "/chat/completions"),
    protocol: "openai-chat-completions",
    preset: "llama-cpp",
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    sampling,
    headers: ["content-type", ...(process.env.GEMMA_API_KEY === undefined ? [] : ["authorization"])],
    promptShape: requestShape(prompt),
    promptFingerprint,
    bodyFingerprint,
    body
  };
}

/** Fingerprint the exact request body that is sent for one replay arm. */
export function replayRequestBodyFingerprint(body: Record<string, unknown>): string {
  return `sha256:${sha256(canonicalJson(body))}`;
}

function frozenBaselineFingerprint(): string {
  const computed = baselinePlanFingerprint();
  if (V08_BASELINE_PLAN_FINGERPRINT !== computed) {
    throw new Error("The committed v0.8.0 baseline plan fingerprint does not match baseline.ts");
  }
  return computed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

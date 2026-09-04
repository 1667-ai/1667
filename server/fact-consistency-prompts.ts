import { createHash } from "node:crypto";
import type { GenerationSettings } from "../shared/types.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import {
  DEFAULT_FACT_CONSISTENCY_MARKER,
  factConsistencyFactStateText,
  factConsistencyPrompt,
  factConsistencyPromptTokenEstimate
} from "../shared/fact-consistency-prompt.js";
import {
  MAX_FACT_CONSISTENCY_PART_CHARS,
  type FactConsistencyPartSelection
} from "../shared/fact-consistency-types.js";
import { ProviderError, ServiceError } from "./errors.js";
import { attachProviderRuntime, providerRuntimeFor } from "./provider-runtime.js";
import type { FactConsistencyBatch } from "./fact-consistency-bounds.js";
import { canonicalJson } from "./canonical-json.js";

const FACT_CONSISTENCY_TEMPERATURE_CAP = 0.2;

export function factConsistencySettings(settings: GenerationSettings): GenerationSettings {
  const runtime = providerRuntimeFor(settings);
  const capped: GenerationSettings = {
    ...settings,
    temperature: settings.temperature === null
      ? null
      : Math.min(settings.temperature, FACT_CONSISTENCY_TEMPERATURE_CAP)
  };
  return attachProviderRuntime(capped, {
    ...runtime,
    tokenProbabilities: null,
    sampling: {
      ...runtime.sampling,
      phraseBias: [],
      bannedStrings: []
    }
  }, true);
}

export function factConsistencyBatches(
  part: FactConsistencyPartSelection,
  settings: GenerationSettings
): readonly FactConsistencyBatch[] | null {
  if (part.text.length > MAX_FACT_CONSISTENCY_PART_CHARS) return null;
  const contextRoom = settings.contextWindow === null
    ? null
    : settings.contextWindow - settings.maxTokens;
  const marker = factConsistencyMarker("fit", part.partId, 0);
  const fits = (factTextChars: number): boolean => contextRoom === null
    || factConsistencyPromptTokenEstimate(part, factTextChars, marker) <= contextRoom;
  if (contextRoom !== null && !fits(0)) return null;
  if (contextRoom === null) return [part.facts];
  const batches: FactConsistencyBatch[] = [];
  let current: FactConsistencyPartSelection["facts"][number][] = [];
  let currentFactTextChars = 0;
  for (const fact of part.facts) {
    const factText = factConsistencyFactStateText(fact, current.length);
    const candidateFactTextChars = currentFactTextChars
      + (current.length === 0 ? 0 : 2)
      + factText.length;
    if (fits(candidateFactTextChars)) {
      current.push(fact);
      currentFactTextChars = candidateFactTextChars;
      continue;
    }
    if (current.length === 0) return null;
    batches.push(current);
    current = [fact];
    currentFactTextChars = factConsistencyFactStateText(fact, 0).length;
    if (!fits(currentFactTextChars)) return null;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Bind a compact digest of the prompts used by every Fact batch. */
export function factConsistencyBatchHash(
  part: FactConsistencyPartSelection,
  batches: readonly FactConsistencyBatch[],
  runId: string
): string {
  const hash = createHash("sha256");
  for (const [index, facts] of batches.entries()) {
    hash.update(JSON.stringify(renderPromptPlan(factConsistencyPrompt(
      part,
      facts,
      factConsistencyMarker(runId, part.partId, index)
    ))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Return the server-owned token that binds a paid check to its plan. The
 * descriptor includes the aggregate version, transformed utility settings,
 * selected prose and Fact States, and the exact batch membership. */
export function factConsistencyPlanToken(
  aggregateVersion: StoryAggregateVersion | null,
  request: { readonly storyId: string; readonly focusedPartId: string; readonly scope: string },
  parts: readonly FactConsistencyPartSelection[],
  batches: readonly (readonly FactConsistencyBatch[] | null)[],
  settings: GenerationSettings
): string {
  const runtime = providerRuntimeFor(settings);
  const descriptor = {
    aggregateVersion,
    request: {
      storyId: request.storyId,
      focusedPartId: request.focusedPartId,
      scope: request.scope
    },
    settings,
    runtime: {
      protocol: runtime.protocol ?? null,
      preset: runtime.preset,
      textPromptFormat: runtime.textPromptFormat ?? null,
      splitThinkTags: runtime.splitThinkTags ?? false,
      auth: runtime.auth,
      headers: runtime.headers,
      timeouts: runtime.timeouts,
      allowInsecureHttp: runtime.allowInsecureHttp,
      tokenProbabilities: runtime.tokenProbabilities,
      reasoning: runtime.reasoning ?? null,
      keepReasoning: runtime.keepReasoning ?? null,
      continuationPromptLayout: runtime.continuationPromptLayout ?? null,
      capabilities: runtime.capabilities,
      sampling: runtime.sampling
    },
    parts: parts.map((part, index) => ({
      partId: part.partId,
      takeId: part.takeId,
      text: part.text,
      facts: part.facts,
      batches: batches[index] === null
        ? null
        : batches[index]!.map((batch) => batch.map((fact) => fact.stateId))
    }))
  };
  return createHash("sha256")
    .update(canonicalJson(descriptor))
    .digest("hex");
}

export function factConsistencyMarker(runId: string, partId: string, index: number): string {
  if (runId === "fit") return DEFAULT_FACT_CONSISTENCY_MARKER;
  const digest = createHash("sha256")
    .update(`${runId}\0${partId}\0${index}`)
    .digest("hex")
    .slice(0, 16);
  return `[[fact-consistency-complete-${digest}]]`;
}

export function completionFailureReason(outcome: { readonly finishReason: string | null }): string {
  return outcome.finishReason === "length"
    ? "The model reached its output limit before it confirmed the response."
    : "The model stopped before it confirmed the response.";
}

export function providerFailureReason(): string {
  return "The model request could not be completed.";
}

export function publicProviderFailure(error: unknown): ProviderError | ServiceError {
  if (error instanceof ProviderError) return error;
  if (error instanceof ServiceError && error.code !== "internal") return error;
  return new ProviderError("The model request could not be completed.");
}

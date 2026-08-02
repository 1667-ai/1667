import {
  samplingBiasVariantText,
  SAMPLING_BIAS_VARIANT_VALUES,
  type SamplingBiasEntryResolution,
  type SamplingBiasResolutionResult,
  type SamplingBiasVariantResolution
} from "../../shared/sampling-capabilities.js";
import { SAMPLING_LOGIT_BIAS_POLICY } from "../../shared/sampling-validation-policy.js";
import type { SamplingPhraseBiasEntryV2 } from "../../shared/settings-v2-types.js";

/**
 * Demo mode never loads the real WASM tokenizer, and never reaches a live
 * llama.cpp server — neither leaves the render process even in the real
 * backend (see shared/worker-protocol.ts for why `resolveSamplingBias`
 * still crosses the worker boundary there). This fabricates a plausible
 * -looking token ID per surface variant so the sampling editor's preview has
 * something to show while demoing offline; the numbers are not real
 * tokenizer output and must never reach a provider request. Demo mode
 * always resolves — it has no tokenizer to fail, and simulating a rejected
 * entry would need a real encoder to decide which phrases actually need it.
 */
export function demoTokenId(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0;
  }
  return hash % 200_000;
}

function demoEntryResolution(phrase: string): Extract<SamplingBiasEntryResolution, { kind: "resolved" }> {
  const seen = new Map<string, number>();
  const variants: SamplingBiasVariantResolution[] = SAMPLING_BIAS_VARIANT_VALUES.map((variant) => {
    const text = samplingBiasVariantText(phrase, variant);
    let tokenId = seen.get(text);
    if (tokenId === undefined) {
      tokenId = demoTokenId(text);
      seen.set(text, tokenId);
    }
    return { variant, text, outcome: { kind: "single-token" as const, tokenId } };
  });
  return { kind: "resolved", phrase, variants, tokenIds: [...new Set(seen.values())] };
}

/** Demo-mode stand-in for the real resolveSamplingBias worker method
 * (server/sampling-phrase-bias.ts): same merge precedence and shape, fake
 * per-variant token IDs. Always "resolved" — demo mode has no tokenizer to
 * fail to load. */
export function demoResolveSamplingBias(request: {
  readonly logitBias: Readonly<Record<string, number>>;
  readonly phraseBias: readonly SamplingPhraseBiasEntryV2[];
  readonly bannedStrings: readonly string[];
}): SamplingBiasResolutionResult {
  const merged: Record<string, number> = {};
  const phraseBias = request.phraseBias.map((entry) => {
    const resolution = demoEntryResolution(entry.phrase);
    for (const id of resolution.tokenIds) merged[String(id)] = entry.weight;
    return resolution;
  });
  const bannedStrings = request.bannedStrings.map((phrase) => {
    const resolution = demoEntryResolution(phrase);
    for (const id of resolution.tokenIds) merged[String(id)] = SAMPLING_LOGIT_BIAS_POLICY.minimum;
    return resolution;
  });
  for (const [token, weight] of Object.entries(request.logitBias)) merged[token] = weight;
  return {
    kind: "resolved",
    logitBias: merged,
    phraseBias,
    bannedStrings,
    resolvedEntryCount: Object.keys(merged).length
  };
}

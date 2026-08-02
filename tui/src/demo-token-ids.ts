import type {
  ResolvedPhraseTokens,
  SamplingBiasResolutionResult
} from "../../shared/sampling-capabilities.js";
import { SAMPLING_LOGIT_BIAS_POLICY } from "../../shared/sampling-validation-policy.js";
import type { SamplingPhraseBiasEntryV2 } from "../../shared/settings-v2-types.js";

/**
 * Demo mode never loads the real WASM tokenizer — it stays out of the TUI's
 * render process even in the real backend (see shared/worker-protocol.ts for
 * why `resolveSamplingBias` still crosses the worker boundary there). This
 * fabricates plausible-looking token IDs from a phrase so the sampling
 * editor's preview has something to show while demoing offline; the numbers
 * are not real tokenizer output and must never reach a provider request.
 */
export function demoTokenIds(phrase: string): readonly number[] {
  return phrase
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => {
      let hash = 0;
      for (let index = 0; index < word.length; index += 1) {
        hash = (Math.imul(hash, 31) + word.charCodeAt(index)) >>> 0;
      }
      return hash % 200_000;
    });
}

/** Demo-mode stand-in for the real resolveSamplingBias worker method
 * (server/sampling-phrase-bias.ts): same merge precedence and shape, fake
 * per-phrase token IDs. Always "resolved" — demo mode has no tokenizer to
 * fail to load. */
export function demoResolveSamplingBias(request: {
  readonly logitBias: Readonly<Record<string, number>>;
  readonly phraseBias: readonly SamplingPhraseBiasEntryV2[];
  readonly bannedStrings: readonly string[];
}): SamplingBiasResolutionResult {
  const merged: Record<string, number> = {};
  const phraseBias: ResolvedPhraseTokens[] = request.phraseBias.map((entry) => {
    const tokenIds = demoTokenIds(entry.phrase);
    for (const id of tokenIds) merged[String(id)] = entry.weight;
    return { phrase: entry.phrase, tokenIds };
  });
  const bannedStrings: ResolvedPhraseTokens[] = request.bannedStrings.map((phrase) => {
    const tokenIds = demoTokenIds(phrase);
    for (const id of tokenIds) merged[String(id)] = SAMPLING_LOGIT_BIAS_POLICY.minimum;
    return { phrase, tokenIds };
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

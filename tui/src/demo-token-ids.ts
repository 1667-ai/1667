import type { SamplingBiasResolutionResult } from "../../shared/sampling-capabilities.js";
import {
  resolveSamplingLogitBias,
  type ResolveSamplingBiasInput
} from "../../server/sampling-phrase-bias.js";

/**
 * Demo-mode stand-in for the real resolveSamplingBias worker method
 * (server/sampling-phrase-bias.ts). Demo mode never loads the real WASM
 * tokenizer, and never reaches a live llama.cpp server — neither leaves the
 * render process even in the real backend (see shared/worker-protocol.ts for
 * why `resolveSamplingBias` still crosses the worker boundary there) — so
 * this supplies a fake per-variant tokenizer instead of a real one. It calls
 * the real merge, `resolveSamplingLogitBias`, rather than
 * re-implementing it (issue #282 review round 4, finding 2): an earlier
 * version hand-copied the phrase/banned-string precedence and the
 * resolved-entry-count computation, and never called `settleTokenOwnership`,
 * so demo mode structurally could not report a shadowed entry — a
 * divergence from the invariant every other caller of this function relies
 * on, that the editor and the request can never compute different token IDs
 * for the same draft. Shadowing is a pure function of resolved token IDs and
 * weights, and demo mode has both; only the tokenizer itself is fake.
 * `demoTokenId`'s numbers are not real tokenizer output and must never
 * reach a provider request.
 */
export function demoResolveSamplingBias(
  request: ResolveSamplingBiasInput
): SamplingBiasResolutionResult {
  return resolveSamplingLogitBias(request, (text) => ({
    kind: "single-token",
    tokenId: demoTokenId(text)
  }));
}

/** Deterministic, non-cryptographic hash-based fake token ID — the same
 * text always fakes the same ID, so a phrase whose surface variants share a
 * text (e.g. one that is already capitalized) still resolves consistently
 * within one demo session. */
function demoTokenId(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0;
  }
  return hash % 200_000;
}

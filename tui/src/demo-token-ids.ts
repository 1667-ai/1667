import {
  samplingBiasPresetRules,
  type SamplingBiasResolutionResult
} from "../../shared/sampling-capabilities.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import type { ProviderProbeTarget } from "../../shared/settings-v2-types.js";
import {
  combineSamplingBiasSources,
  normalizeStorySamplingBias,
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
 *
 * `request.storyPhraseBias`/`storyBannedStrings` (issue #341), when present,
 * are combined with the profile's own fields the same way the real request
 * combines them — via `combineSamplingBiasSources`, not a demo-only copy of
 * that logic, for the exact reason given above about `resolveSamplingLogitBias`
 * itself. Normalized through `normalizeStorySamplingBias` rather than this
 * file's own `?? []` pair (issue #341 finding 6), the same shared defaulting
 * `server/story-service.ts`'s real `resolveSamplingBias` worker method uses.
 *
 * `request.settings` (issue #311 review, second pass, finding C) decides
 * every preset-dependent rule `resolveSamplingLogitBias` takes via one
 * `SamplingBiasPresetRules` value (`samplingBiasPresetRules`,
 * shared/sampling-phrase-resolution.ts — issue #311 review, round six
 * collapsed what were then two separately-threaded rules,
 * `bannedStringsTransportForPreset` for the bannedStrings transport and
 * `phraseBiasSpecialTokenGuardForPreset` for the KoboldCpp special-token
 * guard, into this one function precisely because each rule kept being
 * added the same way and this file kept being the one that forgot it) — the
 * same pure-function-of-preset way the real resolver does, shared with it
 * rather than this file re-deciding "koboldcpp" by hand, or, as two earlier
 * versions of this fix each did in turn, not deciding at all. The transport
 * gap (round two): calling the shared merge directly with no preset in hand
 * rendered a KoboldCpp banned string "resolved" with fake token IDs while
 * the real backend rendered it literal text. The special-token gap (round
 * three): the guard, added to reject a phrase like `<|eot_id|>` before it
 * could ever resolve to a boosted end-of-turn token, lived inside the
 * live-probe layer only a real network request reaches — demo's own
 * synchronous fake tokenizer never went through it, so the same phrase
 * rendered "resolved" here while the real resolver correctly refused it.
 * Both are exactly the divergence this file exists to rule out (issue #282
 * round 4's whole reason for calling the real merge instead of
 * re-implementing it) — the fix each time is the same shape: derive the
 * preset once, feed every rule `resolveSamplingLogitBias` takes from it,
 * the same way the real resolver's own preset dispatch
 * (`resolveWithLiveProbe`, server/sampling-phrase-bias.ts) does. Now that
 * every rule rides one record instead of one parameter each, a future rule
 * needs no change at this call site at all — only a new field on
 * `SamplingBiasPresetRules`, read wherever it is needed.
 * `request.settings` is always the routed connection's document-target form
 * in demo mode (`settingsProviderProbeTarget`, tui/src/settings-provider-probe.ts,
 * only ever returns the resolved `GenerationSettings` form for a
 * non-editable view, which demo mode never is) — a caller with no settings
 * at all (a bare preview with no route selected yet) gets `samplingBiasPresetRules`'s
 * own "no preset" default, the same one `resolveSamplingLogitBias` itself
 * falls back to.
 */
export function demoResolveSamplingBias(
  request: ResolveSamplingBiasInput & { readonly settings?: ProviderProbeTarget }
): SamplingBiasResolutionResult {
  const combined = combineSamplingBiasSources(
    request,
    normalizeStorySamplingBias(request.storyPhraseBias, request.storyBannedStrings)
  );
  const rules = samplingBiasPresetRules(demoPresetFor(request.settings));
  return resolveSamplingLogitBias(
    combined,
    (text) => ({ kind: "single-token", tokenId: demoTokenId(text) }),
    rules
  );
}

/** The routed preset behind `settings`, or "legacy-v1" (which
 * `samplingBiasPresetRules` treats the same as any preset with no native
 * transport of its own) when there is nothing to derive one from. A
 * demo-mode `ProviderProbeTarget` is always the document-target form (see
 * this file's own doc comment above) — a bare `GenerationSettings` is not a
 * shape demo mode ever produces, so it is treated the same as "nothing to
 * derive a preset from" rather than guessed at. */
function demoPresetFor(settings: ProviderProbeTarget | undefined) {
  if (settings === undefined || !("kind" in settings) || settings.kind !== "settings-document") {
    return "legacy-v1" as const;
  }
  return resolveSettingsProfile(settings.document, settings.document.routing.default).connection.preset;
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

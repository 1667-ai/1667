import type { SamplingContext } from "./sampling-capabilities.js";
import type { SettingsPresetV2 } from "./settings-v2-types.js";

export type { SamplingContext } from "./sampling-capabilities.js";

/**
 * Token-probability capability matrix for the exact endpoints used by 1667.
 *
 * OpenAI logprobs: https://platform.openai.com/docs/api-reference/chat/create
 * llama.cpp: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 * KoboldCpp: https://github.com/LostRuins/koboldcpp/blob/concedo/embd_res/kcpp_docs.embd
 * LM Studio: https://github.com/lmstudio-ai/docs/blob/main/1_developer/3_openai-compat/chat-completions.md
 * Anthropic Messages: https://platform.claude.com/docs/en/api/messages
 * Verified August 2026.
 */

export type TokenProbabilityUnavailableReason =
  | "legacy-v1"
  | "protocol"
  | "preset-unknown"
  | "model-refused";

export type TokenProbabilityWire = "openai-logprobs" | "dry-run";

export type TokenProbabilityResolution =
  | Readonly<{ kind: "available"; wire: TokenProbabilityWire }>
  | Readonly<{ kind: "unavailable"; reason: TokenProbabilityUnavailableReason }>;

interface TokenProbabilityPresentation {
  readonly reason: string;
  readonly compact: string;
}

// Every preset here reaches the OpenAI chat-completions protocol; "anthropic"
// and "dry-run" never consult this set, because the protocol/dry-run checks
// in resolveTokenProbabilities already resolve them first — Anthropic
// Messages documents no logprobs field at all, and Anthropic never assigns
// a preset with a different protocol (shared/settings-v2-validation.ts).
const TOKEN_PROBABILITY_PRESETS: ReadonlySet<SettingsPresetV2> = new Set<SettingsPresetV2>([
  // `logprobs` / `top_logprobs` on chat completions. Reasoning families
  // refuse the fields at request time; the runtime refusal path (this
  // function's `refused` parameter, set once per model by the provider —
  // phase 2) covers them rather than a static per-model exclusion here.
  "openai",
  // Passes the fields through to whichever provider it routes to. The
  // upstream provider decides, so a refusal is observed at request time
  // rather than predicted here — the same reasoning `resolveSamplingKnob`
  // uses for OpenRouter's sampling knobs.
  "openrouter",
  // The OpenAI-compatible chat endpoint takes `top_logprobs`; it lowers that
  // to the native `n_probs` field.
  "llama-cpp",
  // Added in v1.101. It sends the alternatives in one final chunk rather
  // than per delta, so the phase-2 capture must not assume per-delta
  // arrival.
  "koboldcpp",
  // Added in 0.3.39.
  "lm-studio"
  // "ollama" and "custom" are deliberately absent: neither documents the
  // fields, so both resolve "preset-unknown".
]);

/** The presets `TOKEN_PROBABILITY_PRESETS` allows, in the fixed order the
 *  set above declares them — so an empty state that names "the presets that
 *  do support it" (the token probability viewer, `preset-unknown` and
 *  `protocol`) reads the one list this module already maintains, rather than
 *  a second copy a caller could let drift. */
export const TOKEN_PROBABILITY_SUPPORTED_PRESETS: readonly SettingsPresetV2[] =
  Object.freeze([...TOKEN_PROBABILITY_PRESETS]);

export function resolveTokenProbabilities(
  context: SamplingContext,
  refused?: boolean
): TokenProbabilityResolution {
  if (context.protocol === "legacy-v1" || context.preset === "legacy-v1") {
    return { kind: "unavailable", reason: "legacy-v1" };
  }
  if (refused === true) {
    return { kind: "unavailable", reason: "model-refused" };
  }
  if (context.protocol === "dry-run" || context.preset === "dry-run") {
    // Unlike the sampling matrix — where dry-run sends nothing anywhere and
    // every knob is "unavailable" — the dry-run provider really does
    // fabricate deterministic alternatives (server/providers.ts, phase 2),
    // so reporting it available here is honest, not a stand-in. It is also
    // what lets the end-to-end viewer test run without a live provider.
    return { kind: "available", wire: "dry-run" };
  }
  if (context.protocol === "anthropic-messages") {
    return { kind: "unavailable", reason: "protocol" };
  }
  // context.protocol is "openai-chat-completions": the only case left.
  if (TOKEN_PROBABILITY_PRESETS.has(context.preset)) {
    return { kind: "available", wire: "openai-logprobs" };
  }
  return { kind: "unavailable", reason: "preset-unknown" };
}

/** Why token probabilities are unavailable, in one sentence. */
export function tokenProbabilityUnavailableReason(reason: TokenProbabilityUnavailableReason): string {
  return UNAVAILABLE_REASON_TEXT[reason].reason;
}

/** The same fact, in the words a status line has room for. */
export function tokenProbabilityUnavailableReasonCompact(reason: TokenProbabilityUnavailableReason): string {
  return UNAVAILABLE_REASON_TEXT[reason].compact;
}

const UNAVAILABLE_REASON_TEXT: Readonly<Record<TokenProbabilityUnavailableReason, TokenProbabilityPresentation>> = {
  "legacy-v1": {
    reason: "Format 1 settings are read-only.",
    compact: "read-only"
  },
  protocol: {
    reason: "This protocol does not document token probabilities.",
    compact: "not in protocol"
  },
  "preset-unknown": {
    reason: "This endpoint does not document token probabilities.",
    compact: "unknown endpoint"
  },
  "model-refused": {
    reason: "This model refused token probabilities.",
    compact: "model refused"
  }
};

import { createHash } from "node:crypto";
import type { ChatMessage } from "./prompt-plan.js";
import {
  isOfficialAnthropicBaseUrl,
  isOfficialOpenAiBaseUrl
} from "./settings-provider-defaults.js";
import type {
  SettingsPresetV2,
  SettingsProtocolV2
} from "./settings-v2-types.js";

/**
 * Where a request's token count comes from. Tokenization is model-dependent and
 * there is no single tokenizer, so each preset names its own source. A preset
 * with no source keeps the four-characters-per-token estimate.
 */
export type TokenizeSourceKind =
  | "bundled-openai"
  | "anthropic-count-tokens"
  | "llama-cpp-tokenize"
  | "koboldcpp-tokencount"
  | "none";

/**
 * How much of the rendered request a count covers. The views must never present
 * one grade as another:
 *
 * - `exact`: a bundled tokenizer, or a server count of the complete message
 *   array including its message overhead.
 * - `near-exact`: server-tokenized content whose chat-template overhead the
 *   server applied without 1667 being able to prove the serving path matches.
 * - `estimate`: four characters per token. It keeps the `~` convention.
 */
export type TokenCountGrade = "exact" | "near-exact" | "estimate";

/** A source that can count is never graded `estimate`, and no source can be
 * graded anything else. Stating that here is what lets a counted answer take
 * its grade straight from the source that produced it, instead of each probe
 * restating a grade this file already decided. */
export type TokenizeSource =
  | { readonly kind: "none"; readonly grade: "estimate"; readonly perMessage: false }
  | {
      readonly kind: Exclude<TokenizeSourceKind, "none">;
      readonly grade: "exact" | "near-exact";
      /**
       * True when the source counts each message on its own. A source that
       * counts only a complete array leaves each category and each message row
       * on the estimate, while the total becomes counted.
       */
      readonly perMessage: boolean;
    };

const NO_SOURCE: TokenizeSource = { kind: "none", grade: "estimate", perMessage: false };

/**
 * What each source is worth, declared once. Both the resolution below and the
 * wire decoder read it, so a source cannot arrive from the backend claiming a
 * grade or a per-message split that it is not able to produce.
 */
export const TOKENIZE_SOURCE_CONTRACTS = {
  "bundled-openai": { grade: "exact", perMessage: true },
  "anthropic-count-tokens": { grade: "exact", perMessage: false },
  "llama-cpp-tokenize": { grade: "near-exact", perMessage: false },
  "koboldcpp-tokencount": { grade: "near-exact", perMessage: false }
} as const satisfies Record<
  Exclude<TokenizeSourceKind, "none">,
  { readonly grade: "exact" | "near-exact"; readonly perMessage: boolean }
>;

function sourceFor(kind: Exclude<TokenizeSourceKind, "none">): TokenizeSource {
  return { kind, ...TOKENIZE_SOURCE_CONTRACTS[kind] };
}

/**
 * The one place a preset names its tokenize source. The phrase-bias feature
 * needs the same llama.cpp and KoboldCpp servers, so it reads this too.
 *
 * An OpenAI or Anthropic preset that points somewhere other than the official
 * host serves an unknowable model family, so it keeps the estimate.
 */
export function tokenizeSourceFor(
  protocol: SettingsProtocolV2 | "legacy-v1",
  preset: SettingsPresetV2 | "legacy-v1",
  baseUrl: string | null,
  model: string
): TokenizeSource {
  if (protocol === "dry-run" || protocol === "legacy-v1") return NO_SOURCE;
  if (preset === "anthropic"
    && protocol === "anthropic-messages"
    && isOfficialAnthropicBaseUrl(baseUrl ?? "")) {
    // The count endpoint names the model it counts for, so an unnamed model
    // has nothing to count against.
    return model.length === 0 ? NO_SOURCE : sourceFor("anthropic-count-tokens");
  }
  if (preset === "openai"
    && protocol === "openai-chat-completions"
    && isOfficialOpenAiBaseUrl(baseUrl ?? "")) {
    return sourceFor("bundled-openai");
  }
  if (preset === "llama-cpp") return sourceFor("llama-cpp-tokenize");
  if (preset === "koboldcpp") return sourceFor("koboldcpp-tokencount");
  return NO_SOURCE;
}

/** Why a count fell back to the estimate. No reason reaches an error surface. */
export const TOKEN_COUNT_FALLBACK_VALUES = ["no-source", "too-large", "probe-failed"] as const;
export type TokenCountFallback = (typeof TOKEN_COUNT_FALLBACK_VALUES)[number];

/** The sources a counted answer can name. Wire decoders test membership here
 * rather than re-spelling the union, so a new source cannot reach the views
 * through a decoder that still refuses it. */
export const COUNTED_TOKENIZE_SOURCE_VALUES = [
  "bundled-openai",
  "anthropic-count-tokens",
  "llama-cpp-tokenize",
  "koboldcpp-tokencount"
] as const satisfies readonly Exclude<TokenizeSourceKind, "none">[];

/**
 * The counted request, or the statement that it stays estimated. A failed probe
 * is a fallback, never an error: the meter keeps its estimate and says so.
 */
export type PromptTokenCount =
  | {
      readonly kind: "counted";
      /** A counted answer always names the source that counted it, so `none`
       *  is not one of the things it can say. */
      readonly source: Exclude<TokenizeSourceKind, "none">;
      readonly grade: "exact" | "near-exact";
      readonly total: number;
      /** Aligned one-to-one with the counted messages, or null when the source
       *  counts only a complete array. */
      readonly perMessage: readonly number[] | null;
    }
  | { readonly kind: "estimate"; readonly reason: TokenCountFallback };

export const ESTIMATED_TOKEN_COUNT: PromptTokenCount = { kind: "estimate", reason: "no-source" };

/**
 * The largest message array 1667 sends to be counted. A request past this
 * ceiling keeps the estimate rather than pushing a megabyte-scale body at the
 * backend on every idle pass. It sits under `MAX_JSON_BODY_BYTES` with room for
 * the JSON envelope around the text.
 */
export const MAX_COUNTED_PROMPT_CHARS = 400_000;

/** The counted content, in the order the provider receives it. */
export function countedPromptChars(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * The identity of one counted request. The views hold a count against the exact
 * content it counted, so a late answer can never describe newer text, and the
 * backend caches a count under the same identity.
 *
 * Every field is written with its length in front of it. A separator character
 * cannot do this job, because no character is barred from story prose: a single
 * message holding the separator would otherwise hash the same as two messages
 * either side of one, and the cache would answer the second prompt with the
 * first prompt's count.
 */
export function promptCountFingerprint(
  messages: readonly ChatMessage[],
  ...scope: readonly string[]
): string {
  const hash = createHash("sha256");
  const field = (value: string) => hash.update(`${value.length}:${value}`);
  field(String(scope.length));
  for (const part of scope) field(part);
  for (const message of messages) {
    field(message.role);
    field(message.content);
  }
  return hash.digest("hex");
}

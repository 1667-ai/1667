import type { ChatMessage } from "./prompt-plan.js";
/** Browser-safe token-count source contracts shared by wire decoders. */
export type TokenizeSourceKind =
  | "bundled-openai"
  | "anthropic-count-tokens"
  | "llama-cpp-tokenize"
  | "koboldcpp-tokencount"
  | "none";

export const TOKENIZE_SOURCE_CONTRACTS = {
  "bundled-openai": { grade: "exact", perMessage: true },
  "anthropic-count-tokens": { grade: "exact", perMessage: false },
  "llama-cpp-tokenize": { grade: "near-exact", perMessage: false },
  "koboldcpp-tokencount": { grade: "near-exact", perMessage: false }
} as const satisfies Record<
  Exclude<TokenizeSourceKind, "none">,
  { readonly grade: "exact" | "near-exact"; readonly perMessage: boolean }
>;

export const TOKEN_COUNT_FALLBACK_VALUES = ["no-source", "too-large", "probe-failed"] as const;
export type TokenCountFallback = (typeof TOKEN_COUNT_FALLBACK_VALUES)[number];

export const COUNTED_TOKENIZE_SOURCE_VALUES = [
  "bundled-openai",
  "anthropic-count-tokens",
  "llama-cpp-tokenize",
  "koboldcpp-tokencount"
] as const satisfies readonly Exclude<TokenizeSourceKind, "none">[];

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

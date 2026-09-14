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

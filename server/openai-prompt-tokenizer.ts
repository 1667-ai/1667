import { get_encoding, type Tiktoken } from "tiktoken";

export type PromptTokenCounter = (messageContents: readonly string[]) => number | null;

let tokenizer: Tiktoken | null | undefined;

/**
 * Exact o200k text-token count. Message framing is deliberately excluded: its
 * provider-owned tokens can only raise the rendered prefix above this lower
 * bound, so a cache marker admitted here cannot fall below the documented
 * content threshold.
 */
export function countO200kPromptTextTokens(messageContents: readonly string[]): number | null {
  const encoder = o200kTokenizer();
  if (encoder === null) return null;
  let tokens = 0;
  try {
    for (const content of messageContents) tokens += encoder.encode(content).length;
    return tokens;
  } catch {
    return null;
  }
}

function o200kTokenizer(): Tiktoken | null {
  if (tokenizer !== undefined) return tokenizer;
  try {
    tokenizer = get_encoding("o200k_base");
  } catch {
    tokenizer = null;
  }
  return tokenizer;
}

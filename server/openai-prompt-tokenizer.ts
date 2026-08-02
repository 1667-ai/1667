import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { get_encoding, init, type Tiktoken } from "tiktoken/init";
import type { PromptBiasEncoding } from "../shared/sampling-capabilities.js";

declare const __AI_1667_TIKTOKEN_WASM_BASE64__: string | undefined;

export type PromptTokenCounter = (messageContents: readonly string[]) => number | null;

const encoderCache = new Map<PromptBiasEncoding, Tiktoken | null>();

await init(async (imports) => (
  await WebAssembly.instantiate(tiktokenWasmBytes(), imports)
));

/**
 * Exact o200k text-token count. Message framing is deliberately excluded: its
 * provider-owned tokens can only raise the rendered prefix above this lower
 * bound, so a cache marker admitted here cannot fall below the documented
 * content threshold.
 */
export function countO200kPromptTextTokens(messageContents: readonly string[]): number | null {
  const encoder = loadEncoding("o200k_base");
  if (encoder === null) return null;
  let tokens = 0;
  try {
    for (const content of messageContents) tokens += encoder.encode(content).length;
    return tokens;
  } catch {
    return null;
  }
}

/**
 * Exact token IDs for a text phrase, for the sampling editor's phrase-bias
 * and banned-string entries (shared/settings-v2-types.ts). Returns null only
 * when the WASM tokenizer failed to load; an encoding the caller supplies is
 * assumed to already be a supported one — see
 * `promptBiasTokenizerEncoding` in shared/sampling-capabilities.ts for the
 * closed allow-list that produces it.
 */
export function tokenizePhraseTokenIds(
  phrase: string,
  encoding: PromptBiasEncoding
): readonly number[] | null {
  const encoder = loadEncoding(encoding);
  if (encoder === null) return null;
  try {
    return [...encoder.encode(phrase)];
  } catch {
    return null;
  }
}

function loadEncoding(encoding: PromptBiasEncoding): Tiktoken | null {
  const cached = encoderCache.get(encoding);
  if (cached !== undefined) return cached;
  let encoder: Tiktoken | null;
  try {
    encoder = get_encoding(encoding);
  } catch {
    encoder = null;
  }
  encoderCache.set(encoding, encoder);
  return encoder;
}

function tiktokenWasmBytes(): Uint8Array<ArrayBuffer> {
  const embedded = typeof __AI_1667_TIKTOKEN_WASM_BASE64__ === "string"
    ? __AI_1667_TIKTOKEN_WASM_BASE64__
    : undefined;
  if (embedded !== undefined) {
    return Uint8Array.from(Buffer.from(embedded, "base64"));
  }
  const require = createRequire(import.meta.url);
  return Uint8Array.from(readFileSync(
    require.resolve("tiktoken/tiktoken_bg.wasm")
  ));
}

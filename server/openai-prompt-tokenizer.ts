import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { get_encoding, init, type Tiktoken } from "tiktoken/init";

declare const __AI_1667_TIKTOKEN_WASM_BASE64__: string | undefined;

export type PromptTokenCounter = (messageContents: readonly string[]) => number | null;

let tokenizer: Tiktoken | null | undefined;

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

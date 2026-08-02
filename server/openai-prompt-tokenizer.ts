import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { encoding_for_model, get_encoding, init, type Tiktoken, type TiktokenModel } from "tiktoken/init";

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

/**
 * One count for each message, under the encoding the named model actually
 * uses. Not every official model is o200k: `gpt-4`, `gpt-4-turbo` and
 * `gpt-3.5-turbo` are cl100k, so counting them with o200k would report a wrong
 * number with none of the marks that say a number is approximate.
 *
 * A null result means this build cannot tokenize that model — an unreleased
 * model, or a fine-tune whose name tiktoken does not map. The caller keeps the
 * estimate rather than counting under a guessed encoding. Framing is excluded,
 * exactly as above: the caller adds what the protocol spends on each message.
 */
export function countModelPromptTextTokens(
  model: string,
  messageContents: readonly string[]
): number[] | null {
  const encoder = modelTokenizer(model);
  if (encoder === null) return null;
  try {
    return messageContents.map((content) => encoder.encode(content).length);
  } catch {
    return null;
  }
}

/** Tokenizers hold wasm memory, so they are made once and kept. A session
 * routes through one or two models, and the cap keeps a long-lived server from
 * holding an encoder for every model a writer ever tried. */
const MAX_CACHED_MODEL_TOKENIZERS = 4;
const modelTokenizers = new Map<string, Tiktoken | null>();

function modelTokenizer(model: string): Tiktoken | null {
  const cached = modelTokenizers.get(model);
  if (cached !== undefined) return cached;
  let encoder: Tiktoken | null;
  try {
    encoder = encoding_for_model(model as TiktokenModel);
  } catch {
    // tiktoken raises for a model it does not know. That is an answer, not a
    // fault: 1667 cannot count this model and says so by keeping the estimate.
    encoder = null;
  }
  if (modelTokenizers.size >= MAX_CACHED_MODEL_TOKENIZERS) {
    const oldest = modelTokenizers.keys().next().value;
    if (oldest !== undefined) {
      modelTokenizers.get(oldest)?.free();
      modelTokenizers.delete(oldest);
    }
  }
  modelTokenizers.set(model, encoder);
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

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { encoding_for_model, get_encoding, init, type Tiktoken, type TiktokenModel } from "tiktoken/init";
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
 * and banned-string entries (shared/settings-v2-types.ts). An encoding the
 * caller supplies is assumed to already be a supported one — see
 * `promptBiasTokenizerEncoding` in shared/sampling-capabilities.ts for the
 * closed allow-list that produces it.
 *
 * Null covers two distinct failures — the encoder itself failed to load, or
 * this one phrase spells something `encode_ordinary` cannot encode — but
 * this function's sole caller (server/sampling-phrase-bias.ts,
 * openAiVariantTokenizer) already checks the encoder loaded before ever
 * calling this (`promptBiasEncoderAvailable` below, against the same
 * memoized cache), so by the time this runs, "the encoder itself failed"
 * cannot be the reason for a null: the two failures collapse to one
 * outcome here because no caller ever needed to tell them apart (issue #282
 * review round 4, finding 3 — an earlier three-way result type kept them
 * separate with no caller reading the distinction).
 */
export function tokenizePhraseTokenIds(
  phrase: string,
  encoding: PromptBiasEncoding
): readonly number[] | null {
  const encoder = loadEncoding(encoding);
  if (encoder === null) return null;
  try {
    // encode_ordinary never interprets tiktoken's special-token syntax
    // (e.g. "<|endoftext|>") — encode()'s default disallowed_special="all"
    // would throw on a schema-valid phrase that happens to spell one, and
    // that throw used to get reported as the tokenizer itself failing,
    // which was never true (issue #282 review).
    return [...encoder.encode_ordinary(phrase)];
  } catch {
    return null;
  }
}

/** Whether the bundled WASM encoder for `encoding` actually loaded — checked
 * once per encoding, up front, so a load failure is reported as the systemic
 * "tokenizer-unavailable" outcome it is (shared/sampling-phrase-resolution.ts,
 * TokenizerUnavailableCause "encoder-unavailable"), not folded into a
 * per-phrase "unencodable" the way `tokenizePhraseTokenIds` reports it below
 * (issue #282 review round 2, finding 6b). Memoized via the same cache. */
export function promptBiasEncoderAvailable(encoding: PromptBiasEncoding): boolean {
  return loadEncoding(encoding) !== null;
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
    // `encode` refuses text that spells a special token, and story prose is
    // free to contain one: a passage about a model, or a pasted transcript,
    // can hold `<|endoftext|>` verbatim. Refusing it would report `no-source`
    // for that route and leave the whole session estimated. Here the spelling
    // is prose, so it is tokenized as prose.
    return messageContents.map((content) => encoder.encode_ordinary(content).length);
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
  let encoder: Tiktoken;
  try {
    encoder = encoding_for_model(model as TiktokenModel);
  } catch {
    // tiktoken raises for a model it does not know. That is an answer, not a
    // fault: 1667 cannot count this model and says so by keeping the estimate.
    //
    // The refusal is deliberately not cached. It is indistinguishable here
    // from a failure to build an encoder for a model that is supported, and
    // caching that would mark a countable model unsupported for the life of
    // the process. Asking again costs one throw, and only once for each route,
    // because the client settles a source-less answer against its route.
    return null;
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

import type { ChatMessage } from "../shared/prompt-plan.js";
import type { SettingsProtocolV2 } from "../shared/settings-v2-types.js";
import {
  countedPromptChars,
  ESTIMATED_TOKEN_COUNT,
  MAX_COUNTED_PROMPT_CHARS,
  promptCountFingerprint,
  tokenizeSourceFor,
  type PromptTokenCount,
  type TokenizeSourceKind
} from "../shared/tokenize-source.js";
import type { GenerationSettings } from "../shared/types.js";
import { countO200kPromptTextTokens } from "./openai-prompt-tokenizer.js";
import { postProviderJson } from "./provider-json.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import { providerUrl } from "./providers.js";

/** OpenAI's documented chat framing, for exactly the messages 1667 sends:
 * three fixed tokens for each message, plus the message's own role, which
 * `system`, `user` and `assistant` each spend one o200k token on. 1667 sends
 * no `name` field, so the name allowance never applies.
 * `countO200kPromptTextTokens` counts text alone, so the framing is added back
 * here. The request projection assumes the same four tokens. */
const MESSAGE_FRAMING_TOKENS = 4;

/** Every chat completion is primed with `<|start|>assistant<|message|>`, which
 * no message in the array pays for. It is counted once, for the request. */
const REPLY_PRIMING_TOKENS = 3;

/** Counting is on demand, never per keystroke (see shared/tokenize-source.ts),
 * so a session produces only a handful of distinct prompts worth caching at
 * once: the active one, plus a few an edit or an undo just superseded. Eight
 * covers that comfortably while keeping the process from holding an unbounded
 * prompt-count history. */
const MAX_CACHED_PROMPT_COUNTS = 8;

/** Least-recently-used by Map insertion order: a hit is re-inserted so it
 * moves to the newest end, and eviction removes from the oldest end. Never
 * holds a "probe-failed" result — a server that came back must be reachable
 * on the next pass. */
const promptCountCache = new Map<string, PromptTokenCount>();

interface CountedProbe {
  readonly kind: "counted";
  readonly source: TokenizeSourceKind;
  readonly grade: "exact" | "near-exact";
  readonly total: number;
  readonly perMessage: readonly number[] | null;
}

export async function countPromptTokens(
  settings: GenerationSettings,
  messages: readonly ChatMessage[],
  signal?: AbortSignal
): Promise<PromptTokenCount> {
  const runtime = providerRuntimeFor(settings);
  signal?.throwIfAborted();
  const source = tokenizeSourceFor(
    protocolFor(settings),
    runtime.preset,
    settings.baseUrl,
    settings.model
  );
  if (source.kind === "none") return ESTIMATED_TOKEN_COUNT;
  const kind = source.kind;

  if (countedPromptChars(messages) > MAX_COUNTED_PROMPT_CHARS) {
    return { kind: "estimate", reason: "too-large" };
  }

  const fingerprint = promptCountFingerprint(
    messages,
    runtime.preset,
    settings.model,
    settings.baseUrl
  );
  const cached = cacheGet(fingerprint);
  if (cached !== undefined) return cached;

  signal?.throwIfAborted();
  let counted: CountedProbe;
  try {
    counted = await probeByKind(kind, settings, messages, signal);
  } catch {
    signal?.throwIfAborted();
    return { kind: "estimate", reason: "probe-failed" };
  }
  if (counted.total <= 0) return { kind: "estimate", reason: "probe-failed" };

  cacheSet(fingerprint, counted);
  return counted;
}

function protocolFor(settings: GenerationSettings): SettingsProtocolV2 {
  switch (settings.provider) {
    case "anthropic": return "anthropic-messages";
    case "dry-run": return "dry-run";
    case "openai-compatible": return "openai-chat-completions";
  }
}

async function probeByKind(
  kind: Exclude<TokenizeSourceKind, "none">,
  settings: GenerationSettings,
  messages: readonly ChatMessage[],
  signal: AbortSignal | undefined
): Promise<CountedProbe> {
  switch (kind) {
    case "bundled-o200k": return countBundledO200k(messages);
    case "anthropic-count-tokens": return await countAnthropic(settings, messages, signal);
    case "llama-cpp-tokenize": return await countLlamaCpp(settings, messages, signal);
    case "koboldcpp-tokencount": return await countKoboldCpp(settings, messages, signal);
  }
}

/** Text-only: chat framing is added back here. A null result means the wasm
 * tokenizer failed to load, which the caller treats the same as any other
 * probe failure.
 *
 * The total carries the reply priming, which belongs to no message, so it is
 * larger than the sum of the per-message counts. That difference is the exact
 * shape of the request, not a rounding error. */
function countBundledO200k(messages: readonly ChatMessage[]): CountedProbe {
  const perMessage: number[] = [];
  for (const message of messages) {
    const textTokens = countO200kPromptTextTokens([message.content]);
    if (textTokens === null) throw new Error("o200k tokenizer is unavailable");
    perMessage.push(textTokens + MESSAGE_FRAMING_TOKENS);
  }
  return {
    kind: "counted",
    source: "bundled-o200k",
    grade: "exact",
    total: perMessage.reduce((sum, count) => sum + count, 0) + REPLY_PRIMING_TOKENS,
    perMessage
  };
}

/** 1667's ChatMessage[] carries a "system" role the Anthropic body does not:
 * every system message is lifted into the top-level `system` string, joined
 * with blank lines when there is more than one, exactly as the generation
 * path's Anthropic request body already does for its own message array. That
 * conversion (server/provider-request-body.ts) is written against a
 * PromptPlan, not a ChatMessage[], so it is not reusable here without
 * reshaping it into the wrong input type — this is the same conversion,
 * expressed against the type this probe actually receives. */
async function countAnthropic(
  settings: GenerationSettings,
  messages: readonly ChatMessage[],
  signal: AbortSignal | undefined
): Promise<CountedProbe> {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const rest = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
  const body: Record<string, unknown> = { model: settings.model, messages: rest };
  if (system.length > 0) body.system = system.join("\n\n");

  const data = await postProviderJson(
    settings,
    providerUrl(settings, "/v1/messages/count_tokens"),
    body,
    { "anthropic-version": "2023-06-01" },
    { signal, timeoutMs: probeTimeoutMs(settings) }
  );
  if (!isObject(data) || !isPositiveInteger(data.input_tokens)) {
    throw new Error("Anthropic count_tokens returned an unusable response shape");
  }
  return {
    kind: "counted",
    source: "anthropic-count-tokens",
    grade: "exact",
    total: data.input_tokens,
    perMessage: null
  };
}

async function countLlamaCpp(
  settings: GenerationSettings,
  messages: readonly ChatMessage[],
  signal: AbortSignal | undefined
): Promise<CountedProbe> {
  const root = providerRoot(settings);
  const timeoutMs = probeTimeoutMs(settings);
  const templated = await postProviderJson(
    settings,
    `${root}/apply-template`,
    { messages },
    {},
    { signal, timeoutMs }
  );
  if (!isObject(templated) || typeof templated.prompt !== "string") {
    throw new Error("llama.cpp apply-template returned an unusable response shape");
  }
  const tokenized = await postProviderJson(
    settings,
    `${root}/tokenize`,
    { content: templated.prompt, add_special: true },
    {},
    { signal, timeoutMs }
  );
  if (!isObject(tokenized) || !Array.isArray(tokenized.tokens)) {
    throw new Error("llama.cpp tokenize returned an unusable response shape");
  }
  return {
    kind: "counted",
    source: "llama-cpp-tokenize",
    grade: "near-exact",
    total: tokenized.tokens.length,
    perMessage: null
  };
}

async function countKoboldCpp(
  settings: GenerationSettings,
  messages: readonly ChatMessage[],
  signal: AbortSignal | undefined
): Promise<CountedProbe> {
  const data = await postProviderJson(
    settings,
    `${providerRoot(settings)}/api/extra/tokencount`,
    { messages },
    {},
    { signal, timeoutMs: probeTimeoutMs(settings) }
  );
  if (!isObject(data) || !isPositiveInteger(data.value)) {
    throw new Error("KoboldCpp tokencount returned an unusable response shape");
  }
  return {
    kind: "counted",
    source: "koboldcpp-tokencount",
    grade: "near-exact",
    total: data.value,
    perMessage: null
  };
}

/** Matches probeContextWindow's `root`: the server's origin, without a
 * trailing /v1 or trailing slashes, since these routes live outside /v1. */
function providerRoot(settings: GenerationSettings): string {
  return settings.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function probeTimeoutMs(settings: GenerationSettings): number {
  return Math.min(providerRuntimeFor(settings).timeouts.totalMs, 30_000);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cacheGet(fingerprint: string): PromptTokenCount | undefined {
  const hit = promptCountCache.get(fingerprint);
  if (hit === undefined) return undefined;
  promptCountCache.delete(fingerprint);
  promptCountCache.set(fingerprint, hit);
  return hit;
}

function cacheSet(fingerprint: string, value: PromptTokenCount): void {
  promptCountCache.delete(fingerprint);
  promptCountCache.set(fingerprint, value);
  while (promptCountCache.size > MAX_CACHED_PROMPT_COUNTS) {
    const oldest = promptCountCache.keys().next().value;
    if (oldest === undefined) break;
    promptCountCache.delete(oldest);
  }
}

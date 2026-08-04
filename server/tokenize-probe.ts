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
import { postKoboldCppTokenCount, postLlamaCppTokenize, probeTimeoutMs } from "./context-probe.js";
import { countModelPromptTextTokens } from "./openai-prompt-tokenizer.js";
import { postProviderJson } from "./provider-json.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import { providerRoot, providerUrl } from "./providers.js";

/** OpenAI's documented chat framing, for exactly the messages 1667 sends:
 * three fixed tokens for each message, plus the message's own role, which
 * `system`, `user` and `assistant` each spend one o200k token on. 1667 sends
 * no `name` field, so the name allowance never applies.
 * `countO200kPromptTextTokens` counts text alone, so the framing is added back
 * here. The request projection assumes the same four tokens. */
const MESSAGE_FRAMING_TOKENS = 4;

/** OpenAI documents one snapshot that spends a token more on each message than
 * every other model does. It is long superseded, and the bundled tokenizer
 * still answers for it, so the count follows its own accounting rather than
 * quietly running one token short for each message. */
const LEGACY_FRAMING_MODELS = new Set(["gpt-3.5-turbo-0301"]);
const LEGACY_MESSAGE_FRAMING_TOKENS = 5;

/** Every chat completion is primed with `<|start|>assistant<|message|>`, which
 * no message in the array pays for. It is counted once, for the request. */
const REPLY_PRIMING_TOKENS = 3;

/** Counting is on demand, never per keystroke (see shared/tokenize-source.ts),
 * so a session produces only a handful of distinct prompts worth caching at
 * once: the active one, plus a few an edit or an undo just superseded. Eight
 * covers that comfortably while keeping the process from holding an unbounded
 * prompt-count history. */
const MAX_CACHED_PROMPT_COUNTS = 8;

/** How long a cached count stays usable.
 *
 * A count is only as current as the server that gave it. A local llama.cpp or
 * KoboldCpp process can load a different model, or a different chat template,
 * at the same address — and a writer who leaves 1667's model field blank, as
 * both presets allow, changes nothing this cache can key on. The count would
 * then be a different tokenizer's, still wearing its mark. An age bound is
 * what keeps that wrong for seconds instead of for the session. The bundled
 * tokenizer needs no bound: it is a pure function of the model and the text,
 * so its entries never expire. */
const REMOTE_COUNT_MAX_AGE_MS = 30_000;

interface CachedPromptCount {
  readonly count: PromptTokenCount;
  /** Null for a count no server can invalidate. */
  readonly expiresAt: number | null;
}

/** Least-recently-used by Map insertion order: a hit is re-inserted so it
 * moves to the newest end, and eviction removes from the oldest end. Never
 * holds a "probe-failed" result — a server that came back must be reachable
 * on the next pass. */
const promptCountCache = new Map<string, CachedPromptCount>();

/** What a probe knows: how many tokens, and the split when it can attribute
 * one. What grade that earns, and whether the split is admissible at all, are
 * the tokenize source's to state — see shared/tokenize-source.ts. A probe that
 * named its own grade would let the shared declaration drift out of use. */
interface CountedProbe {
  readonly total: number;
  readonly perMessage: readonly number[] | null;
}

export async function countPromptTokens(
  settings: GenerationSettings,
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
  /** Injectable only so a test can age the cache without waiting. */
  now: () => number = Date.now
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
  const cached = cacheGet(fingerprint, now());
  if (cached !== undefined) return cached;

  signal?.throwIfAborted();
  let counted: CountedProbe | null;
  try {
    counted = await probeByKind(kind, settings, messages, signal);
  } catch {
    signal?.throwIfAborted();
    return { kind: "estimate", reason: "probe-failed" };
  }
  // A null count is the source saying it cannot serve this model at all — an
  // unreleased name, or a fine-tune. That is settled, not a transient failure,
  // so it answers `no-source` and is not retried against the same route.
  if (counted === null) return ESTIMATED_TOKEN_COUNT;
  if (counted.total <= 0) return { kind: "estimate", reason: "probe-failed" };

  // The source stamps the answer. Every grade decision stays in the one file
  // that declares it, so changing a grade there changes what ships.
  const answer: PromptTokenCount = {
    kind: "counted",
    source: kind,
    grade: source.grade,
    total: counted.total,
    perMessage: source.perMessage ? counted.perMessage : null
  };
  cacheSet(
    fingerprint,
    answer,
    kind === "bundled-openai" ? null : now() + REMOTE_COUNT_MAX_AGE_MS
  );
  return answer;
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
): Promise<CountedProbe | null> {
  switch (kind) {
    case "bundled-openai": return countBundled(settings.model, messages);
    case "anthropic-count-tokens": return await countAnthropic(settings, messages, signal);
    case "llama-cpp-tokenize": return await countLlamaCpp(settings, messages, signal);
    case "koboldcpp-tokencount": return await countKoboldCpp(settings, messages, signal);
  }
}

/** Text-only: chat framing is added back here, under the encoding the named
 * model uses. A null result means this build cannot tokenize that model, which
 * the caller answers with the estimate rather than a wrong exact number.
 *
 * The total carries the reply priming, which belongs to no message, so it is
 * larger than the sum of the per-message counts. That difference is the exact
 * shape of the request, not a rounding error. */
function countBundled(model: string, messages: readonly ChatMessage[]): CountedProbe | null {
  const textTokens = countModelPromptTextTokens(model, messages.map((message) => message.content));
  if (textTokens === null) return null;
  const framing = LEGACY_FRAMING_MODELS.has(model)
    ? LEGACY_MESSAGE_FRAMING_TOKENS
    : MESSAGE_FRAMING_TOKENS;
  const perMessage = textTokens.map((tokens) => tokens + framing);
  return {
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
  // A llama.cpp server can hold several models and picks one from the body.
  // Without the name, the count could describe a model other than the one
  // that will serve the request — and it would still be marked. `/tokenize`
  // itself draws this same distinction once, for every caller, in
  // postLlamaCppTokenize (server/context-probe.ts); /apply-template needs it
  // drawn again here because it is a different endpoint. probeContextWindow
  // makes the same distinction for /props.
  const route: Record<string, unknown> = settings.model.length === 0
    ? {}
    : { model: settings.model };
  const templated = await postProviderJson(
    settings,
    `${root}/apply-template`,
    { ...route, messages },
    {},
    { signal, timeoutMs }
  );
  if (!isObject(templated) || typeof templated.prompt !== "string") {
    throw new Error("llama.cpp apply-template returned an unusable response shape");
  }
  const tokenized = await postLlamaCppTokenize(settings, templated.prompt, { add_special: true }, signal);
  // The endpoint answers with token identifiers. Counting the length of an
  // array of anything would turn an error payload into a near-exact count of
  // however many entries it happened to hold.
  if (!isObject(tokenized)
    || !Array.isArray(tokenized.tokens)
    || !tokenized.tokens.every(isTokenId)) {
    throw new Error("llama.cpp tokenize returned an unusable response shape");
  }
  return {
    total: tokenized.tokens.length,
    perMessage: null
  };
}

async function countKoboldCpp(
  settings: GenerationSettings,
  messages: readonly ChatMessage[],
  signal: AbortSignal | undefined
): Promise<CountedProbe> {
  // Shares its endpoint call with probeKoboldCppTokenize
  // (server/context-probe.ts, issue #311) through postKoboldCppTokenCount —
  // one function owns the URL, so a phrase-bias probe and a prompt count can
  // never quietly diverge on it. The two send different bodies: this one
  // sends `{ messages }` (see the comment below on why), the phrase-bias
  // probe sends `{ prompt }`, the one field the API document's own request
  // schema names for this endpoint.
  const data = await postKoboldCppTokenCount(settings, { messages }, signal);
  // A release old enough to read only `prompt` ignores the messages, tokenizes
  // an empty string, and still answers with a small positive count and an empty
  // compiled prompt. Taking that at face value would paint a whole story as
  // `≈1`. The echoed prompt is the evidence that the messages were compiled.
  if (!isObject(data)
    || !isPositiveInteger(data.value)
    || typeof data.prompt !== "string"
    || data.prompt.length === 0) {
    throw new Error("KoboldCpp tokencount did not compile the messages it was given");
  }
  return {
    total: data.value,
    perMessage: null
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTokenId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cacheGet(fingerprint: string, now: number): PromptTokenCount | undefined {
  const hit = promptCountCache.get(fingerprint);
  if (hit === undefined) return undefined;
  promptCountCache.delete(fingerprint);
  if (hit.expiresAt !== null && hit.expiresAt <= now) return undefined;
  promptCountCache.set(fingerprint, hit);
  return hit.count;
}

function cacheSet(fingerprint: string, count: PromptTokenCount, expiresAt: number | null): void {
  promptCountCache.delete(fingerprint);
  promptCountCache.set(fingerprint, { count, expiresAt });
  while (promptCountCache.size > MAX_CACHED_PROMPT_COUNTS) {
    const oldest = promptCountCache.keys().next().value;
    if (oldest === undefined) break;
    promptCountCache.delete(oldest);
  }
}

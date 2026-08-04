import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../shared/sampling-capabilities.js";
import type {
  SamplingSettingsV2,
  SettingsDocumentV2,
  SettingsPresetV2
} from "../shared/settings-v2-types.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";

/**
 * Shared fixture infrastructure for test/sampling-e2e.test.ts — split out to
 * keep that file under the repository's file-size guideline (issue #282
 * review round 2). A local HTTP server standing in for an OpenAI-compatible
 * or llama.cpp provider, and the settings-document builder every case there
 * shapes into a saved profile.
 */

export const PROMPT = {
  operation: "continue" as const,
  turns: [{
    role: "user" as const,
    blocks: [{
      stability: "volatile" as const,
      kind: "request" as const,
      text: "Continue.",
      boundaryAfter: "none" as const
    }]
  }]
};

export function documentFor(
  origin: string,
  preset: SettingsPresetV2,
  model: string,
  sampling: SamplingSettingsV2,
  provider: "openai-compatible" | "anthropic" = "openai-compatible"
): SettingsDocumentV2 {
  const base = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
    provider,
    baseUrl: `${origin}/v1`,
    model,
    apiKeyEnv: null,
    temperature: 0.7,
    maxTokens: 128,
    systemPrompt: "Continue the story.",
    contextWindow: 8_192
  });
  const connectionId = base.models[base.profiles.default!.modelId]!.connectionId;
  return applySamplingSettings({
    ...base,
    connections: {
      ...base.connections,
      [connectionId]: { ...base.connections[connectionId]!, preset }
    }
  }, sampling);
}

/** llama.cpp's own fictional tokenizer for the fixture server below: an
 * exact map from surface text to a fake token ID, standing in for a real
 * model's vocabulary — the fixture is the tokenizer authority here, the
 * same way a real llama.cpp server is authoritative for whatever model it
 * has loaded. */
export const LLAMA_CPP_FIXTURE_TOKENS: Readonly<Record<string, number>> = {
  griffin: 501,
  " griffin": 502,
  Griffin: 503,
  " Griffin": 504
};

/** KoboldCpp's own fictional tokenizer for the fixture server below — the
 * same role LLAMA_CPP_FIXTURE_TOKENS plays for llama.cpp's `/tokenize`, kept
 * as a distinct word and a distinct ID range so a test mixing both fixtures
 * in one request can tell which probe answered which entry. */
export const KOBOLDCPP_FIXTURE_TOKENS: Readonly<Record<string, number>> = {
  ember: 601,
  " ember": 602,
  Ember: 603,
  " Ember": 604
};

/** Model-keyed: the tokenize handler below requires an exact `model` match
 * (issue #282 review round 2, finding 3) — a fixture keyed on content alone
 * could not have caught the tokenize probe forgetting to send it. This
 * asserts 1667's own assumption about how a router-mode llama.cpp server
 * behaves, not llama.cpp's actual behavior: `model` is not a documented
 * `/tokenize` field (issue #282 review round 3, finding 4c), so this fixture
 * cannot stand in for a verified round trip against a real server. */
export type LlamaCppFixtureTokenizeMap = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** Flat, content-keyed: unlike llama.cpp's `/tokenize`, KoboldCpp's own API
 * document names no `model` field on `/api/extra/tokencount` at all (its
 * request schema is `{ prompt: string }` only — see the quote in
 * server/context-probe.ts), and KoboldCpp is a single loaded model per
 * server instance, so there is no router-mode case to model here. This
 * asserts 1667's own assumption about the response shape (`{ value, ids }`,
 * quoted from the same API document) — not a verified round trip against a
 * real KoboldCpp server (issue #311, following the same caveat
 * `LlamaCppFixtureTokenizeMap` above already carries for its own fixture).
 * A value is either one token ID (the common single-token case) or several
 * — issue #311 review, first pass: a fixture that could only ever answer
 * one token per text could not exercise the multi-token "rejected" path for
 * KoboldCpp the way `LLAMA_CPP_FIXTURE_TOKENS` never needed to, because that
 * preset's own fixture is model-keyed instead of flat. */
export type KoboldCppFixtureTokenizeMap = Readonly<Record<string, number | readonly number[]>>;

export interface ProviderFixtureOptions {
  /** Issue #282 review round 5, finding 1: a genuine single-model llama.cpp
   * server does not route on `model` at all, so it answers a `/tokenize`
   * call that omits the field entirely — unlike the router-mode behavior the
   * default (unset) fixture models, which requires an exact match and
   * therefore rejects a call naming no model. Only takes effect when
   * `tokenizeMap` has exactly one entry: a fixture standing in for a
   * multi-model router has no single answer to fall back to. Never widens
   * what a call that *does* send `model` is checked against, so this cannot
   * mask the regression it exists to catch — `model: ""` still has no match
   * in a map keyed by real names. */
  readonly allowBlankModel?: boolean;
  /** Issue #311: a fake KoboldCpp `/api/extra/tokencount` vocabulary, keyed
   * by literal prompt text. Undefined (the default) means the fixture does
   * not answer that route at all, the same "unset means absent" shape
   * `tokenizeMap` already uses for llama.cpp's `/tokenize`. */
  readonly koboldTokenizeMap?: KoboldCppFixtureTokenizeMap;
  /** Issue #311 review, first pass: the BOS (or other) prefix a KoboldCpp
   * build unconditionally prepends to every `/api/extra/tokencount`
   * response's `ids` — the exact shape the endpoint's own documented example
   * shows (`"ids": [1, 22557, …]`, the leading `1` being BOS). Prepended to
   * every response this fixture answers, calibration probe (`prompt: ""`)
   * included, so a test can exercise `koboldCppLiveTokenizeProbe`'s
   * calibrate-and-strip fix (server/sampling-phrase-bias.ts) against a
   * fixture that actually behaves the way the bug report describes, not the
   * no-BOS default every fixture used before this option existed. Undefined
   * (the default) means no prefix — the exact fixture behavior before this
   * option existed, so every caller that predates it keeps its exact
   * previous coverage. */
  readonly koboldBosPrefix?: readonly number[];
  /** Issue #311 review, first pass, edge case: a literal prompt text named
   * here gets no `koboldBosPrefix` prepended, even while every other prompt
   * still gets it — modeling a KoboldCpp build whose calibrated prefix
   * (learned from the empty-string probe) turns out not to actually be a
   * prefix of one specific phrase's `ids`. This is 1667's own synthetic
   * assumption-check, not a documented KoboldCpp behavior: no known build
   * answers inconsistently this way. It exists to prove
   * `koboldCppLiveTokenizeProbe`'s (server/sampling-phrase-bias.ts) "the
   * prefix cannot be established" edge case reports tokenizer-unavailable
   * rather than guessing which part of a mismatched response is real. */
  readonly koboldBosPrefixExemptPrompts?: ReadonlySet<string>;
}

export async function startProviderFixture(
  t: { after(callback: () => void | Promise<void>): void },
  tokenizeMap?: LlamaCppFixtureTokenizeMap,
  options: ProviderFixtureOptions = {}
): Promise<{
  readonly origin: string;
  readonly bodies: Record<string, unknown>[];
  readonly tokenizeBodies: Record<string, unknown>[];
  readonly koboldTokenizeBodies: Record<string, unknown>[];
}> {
  const bodies: Record<string, unknown>[] = [];
  const tokenizeBodies: Record<string, unknown>[] = [];
  const koboldTokenizeBodies: Record<string, unknown>[] = [];
  const allowBlankModel = options.allowBlankModel === true;
  const koboldTokenizeMap = options.koboldTokenizeMap;
  const koboldBosPrefix = options.koboldBosPrefix ?? [];
  const koboldBosPrefixExemptPrompts = options.koboldBosPrefixExemptPrompts ?? new Set<string>();
  const server = createServer((request, response) => {
    handleRequest(
      request,
      response,
      bodies,
      tokenizeBodies,
      koboldTokenizeBodies,
      tokenizeMap,
      koboldTokenizeMap,
      koboldBosPrefix,
      koboldBosPrefixExemptPrompts,
      allowBlankModel
    ).catch((error: unknown) => {
      // A fixture assertion failing (assertLogitBiasBodyShape below) throws
      // rather than silently accepting a malformed body — respond with the
      // failure instead of leaving the client to hang until its own
      // timeout, so the test reports what actually went wrong.
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await listen(server);
  t.after(() => { server.close(); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture has no address");
  return { origin: `http://127.0.0.1:${address.port}`, bodies, tokenizeBodies, koboldTokenizeBodies };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bodies: Record<string, unknown>[],
  tokenizeBodies: Record<string, unknown>[],
  koboldTokenizeBodies: Record<string, unknown>[],
  tokenizeMap: LlamaCppFixtureTokenizeMap | undefined,
  koboldTokenizeMap: KoboldCppFixtureTokenizeMap | undefined,
  koboldBosPrefix: readonly number[],
  koboldBosPrefixExemptPrompts: ReadonlySet<string>,
  allowBlankModel: boolean
): Promise<void> {
  if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "e2e-model" }] }));
    return;
  }
  if (request.method === "POST" && request.url === "/tokenize" && tokenizeMap !== undefined) {
    const body = JSON.parse(await requestText(request)) as Record<string, unknown>;
    tokenizeBodies.push(body);
    const content = body.content;
    const hasModelField = Object.hasOwn(body, "model");
    // Router mode: a request naming no model is rejected outright rather
    // than answered from a default — the same is true of a request naming a
    // model this server does not host, including the literal empty string,
    // which is never a real model name (issue #282 review round 5, finding
    // 1). `allowBlankModel` stands in for a single-model server instead,
    // which does not route on `model` at all and so answers a call that
    // omits the field, from the one model it has.
    const modelMap = hasModelField
      ? (typeof body.model === "string" ? tokenizeMap[body.model] : undefined)
      : (allowBlankModel ? soleTokenizeMapEntry(tokenizeMap) : undefined);
    if (modelMap === undefined || typeof content !== "string") {
      response.writeHead(400).end();
      return;
    }
    const tokenId = modelMap[content];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ tokens: tokenId === undefined ? [] : [tokenId] }));
    return;
  }
  if (
    request.method === "POST"
    && request.url === "/api/extra/tokencount"
    && koboldTokenizeMap !== undefined
  ) {
    const body = JSON.parse(await requestText(request)) as Record<string, unknown>;
    koboldTokenizeBodies.push(body);
    const prompt = body.prompt;
    if (typeof prompt !== "string") {
      response.writeHead(400).end();
      return;
    }
    const mapped = koboldTokenizeMap[prompt];
    // Every response carries `koboldBosPrefix` first, `prompt` included
    // (issue #311 review, first pass) — a real BOS-adding build prepends it
    // unconditionally, the empty-string calibration probe included, which is
    // exactly the behavior `koboldCppLiveTokenizeProbe`
    // (server/sampling-phrase-bias.ts) calibrates against. A prompt named in
    // `koboldBosPrefixExemptPrompts` gets no prefix at all, breaking that
    // assumption on purpose — see that option's own comment.
    const realTokens = mapped === undefined ? [] : (Array.isArray(mapped) ? mapped : [mapped]);
    const prefix = koboldBosPrefixExemptPrompts.has(prompt) ? [] : koboldBosPrefix;
    const ids = [...prefix, ...realTokens];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ value: ids.length, ids }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await requestText(request)) as Record<string, unknown>;
  assertLogitBiasBodyShape(body);
  assertBannedTokensBodyShape(body);
  bodies.push(body);
  if (request.url === "/v1/messages") {
    response.setHeader("content-type", "text/event-stream");
    response.end([
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      ""
    ].join("\n"));
    return;
  }
  response.setHeader("content-type", "text/event-stream");
  response.end([
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    "",
    "data: [DONE]",
    "",
    ""
  ].join("\n"));
}

/** The one model a single-model fixture (`allowBlankModel`) has to answer
 * from. Undefined when the map does not represent exactly one model — a
 * fixture standing in for a multi-model router has no default to fall back
 * to, so it stays strict instead of guessing. */
function soleTokenizeMapEntry(
  tokenizeMap: LlamaCppFixtureTokenizeMap
): Readonly<Record<string, number>> | undefined {
  const entries = Object.values(tokenizeMap);
  return entries.length === 1 ? entries[0] : undefined;
}

/** Issue #282 review round 2, finding 2: the fixture used to accept
 * whatever shape a request body sent, so it proved 1667 against its own
 * assumption about the wire, not against a documented shape. llama.cpp's
 * server README documents the OpenAI object form of `logit_bias` — a JSON
 * object mapping numeric token-ID strings to a bias, and states it accepts
 * that form "for compatibility with the OpenAI API" — so asserting it here
 * means a future change to the encoding fails a test instead of a live
 * generation. */
function assertLogitBiasBodyShape(body: Record<string, unknown>): void {
  const logitBias = body.logit_bias;
  if (logitBias === undefined) return;
  if (logitBias === null || typeof logitBias !== "object" || Array.isArray(logitBias)) {
    throw new Error(`fixture expected logit_bias to be a JSON object, got ${JSON.stringify(logitBias)}`);
  }
  for (const [token, weight] of Object.entries(logitBias as Record<string, unknown>)) {
    if (!/^\d+$/.test(token)) throw new Error(`fixture expected a numeric token-ID key, got ${JSON.stringify(token)}`);
    if (typeof weight !== "number") throw new Error(`fixture expected a numeric bias for token ${token}`);
  }
}

/** Issue #311: this asserts 1667's own assumption about the shape it sends,
 * not a documented request schema — KoboldCpp's API document shows
 * `banned_tokens` only on the native `GenerationInput` schema
 * (`/api/v1/generate`, `/api/extra/generate/stream`), never on the
 * OpenAI-compatible `/v1/chat/completions` body this fixture stands in for
 * (see the PRESET_SUBTRACTIONS comment in shared/sampling-capabilities.ts
 * for the full transport reasoning). What is checked here is only that 1667
 * sends the shape that schema documents — a plain array of strings — to
 * whichever field name it chooses, in case KoboldCpp's pass-through does
 * accept it. */
function assertBannedTokensBodyShape(body: Record<string, unknown>): void {
  const bannedTokens = body.banned_tokens;
  if (bannedTokens === undefined) return;
  if (!Array.isArray(bannedTokens) || bannedTokens.some((entry) => typeof entry !== "string")) {
    throw new Error(`fixture expected banned_tokens to be an array of strings, got ${JSON.stringify(bannedTokens)}`);
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function collect(stream: AsyncIterable<string>): Promise<string> {
  let result = "";
  for await (const chunk of stream) result += chunk;
  return result;
}

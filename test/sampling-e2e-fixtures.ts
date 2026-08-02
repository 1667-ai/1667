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

/** Model-keyed: the tokenize handler below requires an exact `model` match
 * (issue #282 review round 2, finding 3), the same way a real llama.cpp
 * server in router mode requires one — a fixture keyed on content alone
 * could not have caught the tokenize probe forgetting to send it. */
export type LlamaCppFixtureTokenizeMap = Readonly<Record<string, Readonly<Record<string, number>>>>;

export async function startProviderFixture(
  t: { after(callback: () => void | Promise<void>): void },
  tokenizeMap?: LlamaCppFixtureTokenizeMap
): Promise<{ readonly origin: string; readonly bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    handleRequest(request, response, bodies, tokenizeMap).catch((error: unknown) => {
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
  return { origin: `http://127.0.0.1:${address.port}`, bodies };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bodies: Record<string, unknown>[],
  tokenizeMap: LlamaCppFixtureTokenizeMap | undefined
): Promise<void> {
  if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "e2e-model" }] }));
    return;
  }
  if (request.method === "POST" && request.url === "/tokenize" && tokenizeMap !== undefined) {
    const { content, model } = JSON.parse(await requestText(request)) as {
      content: string;
      model?: string;
    };
    const modelMap = typeof model === "string" ? tokenizeMap[model] : undefined;
    if (modelMap === undefined) {
      // Router mode: a request naming no model, or a model this server does
      // not host, is rejected outright rather than answered from a default.
      response.writeHead(400).end();
      return;
    }
    const tokenId = modelMap[content];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ tokens: tokenId === undefined ? [] : [tokenId] }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await requestText(request)) as Record<string, unknown>;
  assertLogitBiasBodyShape(body);
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

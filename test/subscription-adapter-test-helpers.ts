import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type CredentialStore,
  type Model,
  type Models,
  type OAuthCredential
} from "@earendil-works/pi-ai";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import type { SubscriptionProviderId } from "../server/subscription-credential-store.js";
import { EMPTY_SAMPLING_V2, type SubscriptionProtocolV2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

export const ACCESS = "access-token-for-fixture";
export const REFRESH = "refresh-token-for-fixture";
export const PROMPT = {
  operation: "continue",
  turns: [
    {
      role: "system",
      blocks: [{ stability: "stable", kind: "author-brief", text: "System.", boundaryAfter: "none" }]
    },
    {
      role: "user",
      blocks: [{ stability: "volatile", kind: "request", text: "Continue.", boundaryAfter: "none" }]
    }
  ]
} as const;

export function oauth(access: string, refresh = REFRESH): OAuthCredential {
  return { type: "oauth", access, refresh, expires: Date.now() + 60_000 };
}

export function modelFor(
  provider: SubscriptionProviderId,
  api: "openai-codex-responses" | "anthropic-messages"
): Model<"openai-codex-responses" | "anthropic-messages"> {
  return {
    id: "fixture-model",
    name: "Fixture model",
    api,
    provider,
    baseUrl: "https://unused.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 4_096
  } as Model<"openai-codex-responses" | "anthropic-messages">;
}

export function subscriptionSettings(
  protocol: SubscriptionProtocolV2,
  provider: "openai-compatible" | "anthropic",
  api: "openai-codex-responses" | "anthropic-messages",
  credentials: CredentialStore,
  models: Models,
  timeoutOverrides: {
    responseHeaderMs?: number;
    firstTokenMs?: number;
    idleMs?: number;
    totalMs?: number;
  } = {},
  effort: "default" | "off" | "low" | "medium" | "high" = "default",
  maxTokens = 128
): GenerationSettings {
  return attachProviderRuntime({
    provider,
    baseUrl: "",
    model: "fixture-model",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens,
    systemPrompt: "unused",
    contextWindow: null
  }, {
    preset: provider === "anthropic" ? "claude-plan" : "chatgpt-plan",
    protocol,
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: timeoutOverrides.responseHeaderMs ?? 1_000,
      firstTokenMs: timeoutOverrides.firstTokenMs ?? 1_000,
      idleMs: timeoutOverrides.idleMs ?? 1_000,
      totalMs: timeoutOverrides.totalMs ?? 2_000
    },
    allowInsecureHttp: false,
    effort,
    tokenProbabilities: null,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    },
    sampling: EMPTY_SAMPLING_V2,
    subscription: { credentials, models }
  }, true);
}

export function fakeModels(
  model: Model<"openai-codex-responses" | "anthropic-messages">,
  streamFactory: (context: Context, options: Record<string, unknown>) => AsyncIterable<AssistantMessageEvent> & {
    result(): Promise<AssistantMessage>;
  },
  authFactory: () => Promise<unknown> = async () => ({ auth: { apiKey: ACCESS } }),
  payloadObserver?: (payload: Record<string, unknown>) => void
): Models {
  return {
    getModel: () => model,
    getAuth: async () => authFactory(),
    stream: (_model: unknown, context: Context, options: Record<string, unknown>) => {
      let delegate: ReturnType<typeof streamFactory> | undefined;
      const onPayload = options.onPayload as
        ((payload: unknown, model: Model<"openai-codex-responses" | "anthropic-messages">) => Promise<unknown> | unknown)
        | undefined;
      const ensure = async (): Promise<ReturnType<typeof streamFactory>> => {
        if (delegate !== undefined) return delegate;
        const payload = fixturePayload(model, options);
        payloadObserver?.(payload);
        await onPayload?.(payload, model);
        delegate = streamFactory(context, options);
        return delegate;
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield* await ensure();
        },
        async result() {
          return await (await ensure()).result();
        }
      };
    },
  } as unknown as Models;
}

function fixturePayload(
  model: Model<"openai-codex-responses" | "anthropic-messages">,
  options: Record<string, unknown>
): Record<string, unknown> {
  if (model.api === "anthropic-messages") {
    return {
      model: model.id,
      max_tokens: options.maxTokens,
      stream: true,
      tool_choice: { type: options.toolChoice },
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.thinkingEnabled === false ? { thinking: { type: "disabled" } } : {})
    };
  }
  return {
    model: model.id,
    stream: true,
    tool_choice: options.toolChoice,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning: { effort: options.reasoningEffort } })
  };
}

export function successfulStream(
  model: Model<"openai-codex-responses" | "anthropic-messages">,
  withThinking: boolean,
  textDeltas: readonly string[] = ["answer"]
): ReturnType<typeof createAssistantMessageEventStream> {
  const text = textDeltas.join("");
  const events: AssistantMessageEvent[] = [
    event("start", model),
    ...(withThinking ? [event("thinking_start", model), event("thinking_delta", model, "thinking")] : []),
    event("text_start", model),
    ...textDeltas.map((delta) => event("text_delta", model, delta)),
    event("text_end", model, text),
    event("done", model)
  ];
  return eventStream(model, events);
}

export function eventStream(
  _model: Model<"openai-codex-responses" | "anthropic-messages">,
  events: readonly AssistantMessageEvent[],
  close = false
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  for (const item of events) stream.push(item);
  if (close) stream.end();
  return stream;
}

export function deferredResultFailureStream(
  model: Model<"openai-codex-responses" | "anthropic-messages">
): AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
  const events = [event("start", model), event("done", model)];
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    async result() {
      throw new Error(`deferred-result-failure ${ACCESS}`);
    }
  };
}

export function event(
  type: "start" | "text_start" | "thinking_start" | "text_delta" | "text_end" | "thinking_delta" | "done" | "toolcall_start",
  model: Model<"openai-codex-responses" | "anthropic-messages">,
  value?: string
): AssistantMessageEvent {
  const partial = assistant(model);
  switch (type) {
    case "start": return { type, partial };
    case "text_start": return { type, contentIndex: 0, partial };
    case "thinking_start": return { type, contentIndex: 0, partial };
    case "text_delta": return { type, contentIndex: 0, delta: value ?? "", partial };
    case "thinking_delta": return { type, contentIndex: 0, delta: value ?? "", partial };
    case "text_end": return { type, contentIndex: 0, content: value ?? "", partial };
    case "toolcall_start": return { type, contentIndex: 0, partial };
    case "done": return { type, reason: "stop", message: partial };
  }
}

export function assistant(
  model: Model<"openai-codex-responses" | "anthropic-messages">
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

export async function collect(stream: AsyncIterable<string>): Promise<string> {
  let output = "";
  for await (const chunk of stream) output += chunk;
  return output;
}

export async function temporaryDirectory(
  t: { after(callback: () => void | Promise<void>): void },
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

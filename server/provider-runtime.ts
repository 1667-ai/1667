import type {
  ConnectionTimeoutsV2,
  CredentialReferenceV2,
  CustomHeaderV2,
  GenerationEffortV2,
  ModelCapabilitiesV2,
  ModelConnectionV2,
  ReasoningDisplayV2,
  SamplingSettingsV2,
  SettingsProtocolV2,
  SettingsPresetV2
} from "../shared/settings-v2-types.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";
import { defaultConnectionTimeouts } from "../shared/settings-provider-defaults.js";
import {
  validateProviderSecretValue
} from "../shared/provider-secret-value.js";
import { ProviderError } from "./errors.js";
import { classifyHttpHost } from "./settings-v2-scalars.js";

const PROVIDER_RUNTIME = Symbol.for("1667.provider-runtime");
const PROVIDER_CREDENTIALS = new WeakMap<
  ProviderRuntime,
  ReadonlyMap<string, string>
>();
const PROVIDER_SECRET_REDACTORS = new WeakMap<
  readonly string[],
  (value: string) => string
>();

export interface ProviderRuntime {
  readonly preset: SettingsPresetV2;
  /** Absent only on legacy test/runtime attachments. */
  readonly protocol?: SettingsProtocolV2;
  /** Text routes use raw prompts when this value is absent. */
  readonly textPromptFormat?: "raw" | "server-template" | "chatml";
  /** From `ModelConnectionV2.splitThinkTags`. A text route otherwise passes
   *  its tokens through untouched, so this stays off unless the writer turns
   *  it on for a connection whose model emits `<think>`. */
  readonly splitThinkTags?: boolean;
  readonly auth: CredentialReferenceV2;
  readonly headers: readonly CustomHeaderV2[];
  readonly timeouts: ConnectionTimeoutsV2;
  readonly allowInsecureHttp: boolean;
  readonly effort: GenerationEffortV2;
  /** Alternative tokens to ask the provider for with each generated token,
   *  from `GenerationProfileV2.tokenProbabilities`. Null means the request
   *  asks for none — the default for every existing and legacy runtime. */
  readonly tokenProbabilities: number | null;
  /** From `GenerationProfileV2.reasoning`, resolved through
   *  `providerRuntimeFromV2`/`legacyProviderRuntime`. Absent only on a
   *  legacy test/runtime attachment built without it; every real runtime
   *  resolves an absent profile field to `"marker"`, the default fold
   *  state, rather than leaving this field itself absent. */
  readonly reasoning?: ReasoningDisplayV2;
  /** From `GenerationProfileV2.discardReasoning`, resolved the same way.
   *  Absent only on a legacy test/runtime attachment; every real runtime
   *  resolves an absent profile field to `true` — reasoning is kept —
   *  rather than leaving this field itself absent. */
  readonly keepReasoning?: boolean;
  readonly capabilities: ModelCapabilitiesV2;
  readonly sampling: SamplingSettingsV2;
}

type RuntimeSettings = GenerationSettings & {
  readonly [PROVIDER_RUNTIME]?: ProviderRuntime;
};

export interface ResolvedProviderHeaders {
  readonly headers: Record<string, string>;
  readonly secrets: readonly string[];
}

/** Attach server-only runtime policy without changing the frozen JSON settings
 * contract. Enumerable symbols survive the small `{ ...settings }` budget
 * overrides used by generation, while JSON and Object.keys ignore them. */
export function attachProviderRuntime(
  settings: GenerationSettings,
  runtime: ProviderRuntime,
  surviveSettingsSpreads = false
): GenerationSettings {
  const descriptor = Object.getOwnPropertyDescriptor(settings, PROVIDER_RUNTIME);
  if (
    (settings as RuntimeSettings)[PROVIDER_RUNTIME] === runtime
    && descriptor?.enumerable === surviveSettingsSpreads
  ) return settings;
  Object.defineProperty(settings, PROVIDER_RUNTIME, {
    configurable: true,
    enumerable: surviveSettingsSpreads,
    writable: false,
    value: runtime
  });
  return settings;
}

export function providerRuntimeFor(settings: GenerationSettings): ProviderRuntime {
  return (settings as RuntimeSettings)[PROVIDER_RUNTIME] ?? legacyProviderRuntime(settings);
}

export function hasProviderRuntime(settings: GenerationSettings): boolean {
  return (settings as RuntimeSettings)[PROVIDER_RUNTIME] !== undefined;
}

export function providerRuntimeFromV2(
  connection: ModelConnectionV2,
  effort: GenerationEffortV2,
  capabilities: ModelCapabilitiesV2,
  environment?: NodeJS.ProcessEnv,
  storedSecrets?: ReadonlyMap<string, string>,
  sampling: SamplingSettingsV2 = EMPTY_SAMPLING_V2,
  tokenProbabilities: number | null = null,
  reasoning: ReasoningDisplayV2 = "marker",
  keepReasoning = true
): ProviderRuntime {
  const runtime: ProviderRuntime = {
    preset: connection.preset,
    protocol: connection.protocol,
    textPromptFormat: connection.textPromptFormat ?? "raw",
    splitThinkTags: connection.splitThinkTags === true,
    auth: connection.auth,
    headers: connection.headers,
    timeouts: connection.timeouts,
    allowInsecureHttp: connection.allowInsecureHttp === true,
    effort,
    tokenProbabilities,
    reasoning,
    keepReasoning,
    capabilities,
    sampling
  };
  if (environment !== undefined || storedSecrets !== undefined) {
    const slots = new Map<string, string>();
    for (const reference of credentialReferences(connection)) {
      if (reference.kind === "env") {
        if (environment !== undefined) {
          const value = environmentCredential(environment, reference.name);
          if (value !== undefined) {
            slots.set(environmentSlotKey(reference.name), value);
          }
        }
      } else {
        const stored = storedSecrets?.get(reference.secretId);
        if (stored !== undefined) {
          slots.set(storedSlotKey(reference.secretId), stored);
        }
      }
    }
    PROVIDER_CREDENTIALS.set(runtime, slots);
  }
  return runtime;
}

export function resolveProviderHeaders(
  settings: GenerationSettings,
  base: Readonly<Record<string, string>>
): ResolvedProviderHeaders {
  const runtime = providerRuntimeFor(settings);
  const headers: Record<string, string> = { ...base };
  const secrets: string[] = [];
  switch (runtime.auth.type) {
    case "none":
      break;
    case "bearer-env": {
      const secret = requireCredential(runtime, runtime.auth.env);
      defineResolvedHeader(headers, "authorization", `Bearer ${secret}`);
      secrets.push(secret);
      break;
    }
    case "header-env": {
      const secret = requireCredential(runtime, runtime.auth.env);
      defineResolvedHeader(headers, runtime.auth.name, secret);
      secrets.push(secret);
      break;
    }
    case "bearer-stored": {
      const secret = requireStoredCredential(runtime, runtime.auth.secretId);
      defineResolvedHeader(headers, "authorization", `Bearer ${secret}`);
      secrets.push(secret);
      break;
    }
    case "header-stored": {
      const secret = requireStoredCredential(runtime, runtime.auth.secretId);
      defineResolvedHeader(headers, runtime.auth.name, secret);
      secrets.push(secret);
      break;
    }
  }
  for (const header of runtime.headers) {
    const secret = requireCredential(runtime, header.value.env);
    defineResolvedHeader(headers, header.name, secret);
    secrets.push(secret);
  }
  return { headers, secrets };
}

function defineResolvedHeader(
  headers: Record<string, string>,
  name: string,
  value: string
): void {
  const existing = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  );
  if (existing !== undefined) {
    throw new ProviderError(
      `Provider header ${name} conflicts with adapter-owned or duplicate header ${existing}.`
    );
  }
  Object.defineProperty(headers, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

export function redactProviderSecrets(
  value: string,
  secrets: readonly string[]
): string {
  let redact = PROVIDER_SECRET_REDACTORS.get(secrets);
  if (redact === undefined) {
    redact = buildProviderSecretRedactor(secrets);
    PROVIDER_SECRET_REDACTORS.set(secrets, redact);
  }
  return redact(value);
}

function buildProviderSecretRedactor(
  secrets: readonly string[]
): (value: string) => string {
  const patterns = providerSecretPatterns(secrets);
  if (patterns.length === 0) return (value) => value;
  const nodes: RedactionNode[] = [redactionNode()];
  for (const pattern of patterns) {
    let state = 0;
    for (let index = 0; index < pattern.length; index += 1) {
      const unit = pattern[index]!;
      let next = nodes[state]!.transitions.get(unit);
      if (next === undefined) {
        next = nodes.length;
        nodes[state]!.transitions.set(unit, next);
        nodes.push(redactionNode());
      }
      state = next;
    }
    nodes[state]!.matchLength = Math.max(
      nodes[state]!.matchLength,
      pattern.length
    );
  }
  const queue = [...nodes[0]!.transitions.values()];
  for (let head = 0; head < queue.length; head += 1) {
    const state = queue[head]!;
    const node = nodes[state]!;
    for (const [unit, next] of node.transitions) {
      queue.push(next);
      let fallback = node.failure;
      while (
        fallback !== 0
        && !nodes[fallback]!.transitions.has(unit)
      ) {
        fallback = nodes[fallback]!.failure;
      }
      const candidate = nodes[fallback]!.transitions.get(unit);
      nodes[next]!.failure = candidate === undefined || candidate === next
        ? 0
        : candidate;
      nodes[next]!.matchLength = Math.max(
        nodes[next]!.matchLength,
        nodes[nodes[next]!.failure]!.matchLength
      );
    }
  }
  return (value) => redactProviderSecretMatches(value, nodes);
}

export interface ProviderStreamRedactor {
  push(value: string): string;
  finish(): string;
}

/** Hold the longest possible secret prefix between provider deltas so a
 * credential split across SSE events is never emitted before it can match. */
export function createProviderStreamRedactor(
  secrets: readonly string[]
): ProviderStreamRedactor {
  const patterns = providerSecretPatterns(secrets);
  const maximumLength = patterns.reduce(
    (maximum, pattern) => Math.max(maximum, pattern.length),
    0
  );
  let pending = "";
  let finished = false;
  return {
    push(value) {
      if (finished) throw new Error("Provider stream redactor is already finished");
      if (maximumLength === 0) return value;
      pending += value;
      let emitEnd = Math.max(0, pending.length - maximumLength + 1);
      for (;;) {
        const crossingStart = crossingSecretStart(
          pending,
          patterns,
          emitEnd
        );
        if (crossingStart === null) break;
        emitEnd = crossingStart;
      }
      const output = redactProviderSecrets(
        pending.slice(0, emitEnd),
        secrets
      );
      pending = pending.slice(emitEnd);
      return output;
    },
    finish() {
      if (finished) return "";
      finished = true;
      const output = redactProviderSecrets(pending, secrets);
      pending = "";
      return output;
    }
  };
}

function providerSecretPatterns(secrets: readonly string[]): readonly string[] {
  return [...new Set(secrets
    .filter((secret) => secret.length > 0)
    .flatMap((secret) => [
      secret,
      JSON.stringify(secret).slice(1, -1)
    ]))];
}

function crossingSecretStart(
  value: string,
  patterns: readonly string[],
  boundary: number
): number | null {
  let earliest: number | null = null;
  for (const pattern of patterns) {
    let start = value.indexOf(pattern);
    while (start !== -1) {
      const end = start + pattern.length;
      if (start < boundary && end > boundary) {
        earliest = earliest === null ? start : Math.min(earliest, start);
      }
      start = value.indexOf(pattern, start + 1);
    }
  }
  return earliest;
}

interface RedactionNode {
  readonly transitions: Map<string, number>;
  failure: number;
  matchLength: number;
}

function redactionNode(): RedactionNode {
  return {
    transitions: new Map(),
    failure: 0,
    matchLength: 0
  };
}

function redactProviderSecretMatches(
  value: string,
  nodes: readonly RedactionNode[]
): string {
  const matches: Array<[start: number, end: number]> = [];
  let state = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value[index]!;
    while (
      state !== 0
      && !nodes[state]!.transitions.has(unit)
    ) {
      state = nodes[state]!.failure;
    }
    state = nodes[state]!.transitions.get(unit)
      ?? nodes[0]!.transitions.get(unit)
      ?? 0;
    const length = nodes[state]!.matchLength;
    if (length === 0) continue;
    const start = index + 1 - length;
    const end = index + 1;
    let mergedStart = start;
    while (
      matches.length > 0
      && mergedStart <= matches[matches.length - 1]![1]
    ) {
      mergedStart = Math.min(mergedStart, matches.pop()![0]);
    }
    matches.push([mergedStart, end]);
  }
  if (matches.length === 0) return value;
  const parts: string[] = [];
  let offset = 0;
  for (const [start, end] of matches) {
    parts.push(value.slice(offset, start), "[REDACTED]");
    offset = end;
  }
  parts.push(value.slice(offset));
  return parts.join("");
}

/** Provider error bodies can JSON-escape reflected credentials. Parse first so
 * every string/key is compared in decoded form; malformed/plain text keeps the
 * literal redaction path. */
export function redactProviderBody(
  value: string,
  secrets: readonly string[]
): string {
  if (secrets.length === 0) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return redactProviderSecrets(value, secrets);
  }
  try {
    return JSON.stringify(redactProviderJson(parsed, secrets));
  } catch {
    return "[provider JSON diagnostic omitted]";
  }
}

/** Redact every provider-controlled JSON representation before it can cross a
 * server/browser boundary. The walk is iterative for deeply nested bounded
 * responses. */
export function redactProviderJson(
  value: unknown,
  secrets: readonly string[]
): unknown {
  if (typeof value === "string") return redactProviderSecrets(value, secrets);
  if (
    value === null
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return redactProviderJsonPrimitive(value, secrets);
  }
  if (typeof value !== "object") return value;
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const [key, child] of Object.entries(current)) {
      const safeKey = Array.isArray(current)
        ? key
        : redactProviderSecrets(key, secrets);
      if (safeKey !== key) {
        Reflect.deleteProperty(current, key);
        Reflect.set(current, safeKey, child);
      }
      if (typeof child === "string") {
        Reflect.set(current, safeKey, redactProviderSecrets(child, secrets));
      } else if (
        child === null
        || typeof child === "number"
        || typeof child === "boolean"
      ) {
        Reflect.set(current, safeKey, redactProviderJsonPrimitive(child, secrets));
      } else if (typeof child === "object") {
        pending.push(child);
      }
    }
  }
  return value;
}

function redactProviderJsonPrimitive(
  value: number | boolean | null,
  secrets: readonly string[]
): number | boolean | null | "[REDACTED]" {
  const serialized = JSON.stringify(value);
  return redactProviderSecrets(serialized, secrets) === serialized
    ? value
    : "[REDACTED]";
}

function legacyProviderRuntime(settings: GenerationSettings): ProviderRuntime {
  const auth: CredentialReferenceV2 = settings.apiKeyEnv === null
    ? { type: "none" }
    : settings.provider === "anthropic"
      ? { type: "header-env", name: "x-api-key", env: settings.apiKeyEnv }
      : { type: "bearer-env", env: settings.apiKeyEnv };
  return {
    preset: legacyPreset(settings),
    protocol: settings.provider === "dry-run"
      ? "dry-run"
      : settings.provider === "anthropic"
        ? "anthropic-messages"
        : settings.provider === "text-completion"
          ? "text-completions"
          : "openai-chat-completions",
    textPromptFormat: "raw",
    auth,
    headers: [],
    timeouts: defaultConnectionTimeouts(settings.provider),
    allowInsecureHttp: false,
    effort: "default",
    tokenProbabilities: null,
    reasoning: "marker",
    keepReasoning: true,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "unknown",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  };
}

function legacyPreset(settings: GenerationSettings): SettingsPresetV2 {
  if (settings.provider === "dry-run") return "dry-run";
  let url: URL;
  try {
    url = new URL(settings.baseUrl);
  } catch {
    return "custom";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (settings.provider === "anthropic") {
    return host === "api.anthropic.com" ? "anthropic" : "custom";
  }
  if (settings.provider === "text-completion") {
    return host === "api.openai.com" ? "openai" : "custom";
  }
  if (host === "api.openai.com") return "openai";
  if (host === "openrouter.ai") return "openrouter";
  const loopback = classifyHttpHost(settings.baseUrl) === "loopback";
  if (loopback && url.port === "1234") return "lm-studio";
  if (loopback && url.port === "11434") return "ollama";
  if (loopback && url.port === "8080") return "llama-cpp";
  if (loopback && url.port === "5001") return "koboldcpp";
  return "custom";
}

function requireCredential(runtime: ProviderRuntime, name: string): string {
  const slots = PROVIDER_CREDENTIALS.get(runtime);
  const value = slots === undefined
    ? environmentCredential(process.env, name)
    : slots.get(environmentSlotKey(name));
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderError(
      `Credential environment variable ${name} is not set. Export it and restart 1667.`
    );
  }
  try {
    return validateProviderSecretValue(value);
  } catch (error) {
    throw new ProviderError([
      credentialValidationMessage(error, `Credential environment variable ${name}`),
      "Remove it and restart 1667."
    ].join(" "));
  }
}

function requireStoredCredential(runtime: ProviderRuntime, secretId: string): string {
  const value = PROVIDER_CREDENTIALS.get(runtime)?.get(storedSlotKey(secretId));
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderError(
      "Stored API key for this connection is missing. Re-enter it in Settings."
    );
  }
  try {
    return validateProviderSecretValue(value);
  } catch (error) {
    throw new ProviderError(
      `${credentialValidationMessage(error, "Stored API key")} Re-enter it in Settings.`
    );
  }
}

type CredentialReferenceSlot =
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "stored"; readonly secretId: string };

function credentialReferences(
  connection: ModelConnectionV2
): readonly CredentialReferenceSlot[] {
  const authReferences: readonly CredentialReferenceSlot[] = connection.auth.type === "none"
    ? []
    : connection.auth.type === "bearer-stored"
        || connection.auth.type === "header-stored"
      ? [{ kind: "stored", secretId: connection.auth.secretId }]
      : [{ kind: "env", name: connection.auth.env }];
  return [
    ...authReferences,
    ...connection.headers.map((header): CredentialReferenceSlot => ({
      kind: "env",
      name: header.value.env
    }))
  ];
}

function credentialValidationMessage(error: unknown, subject: string): string {
  const message = error instanceof Error
    ? error.message
    : "Stored API key is invalid";
  return `${subject}${message.replace(/^Stored API key/u, "")}`;
}

function environmentCredential(
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const key = environmentKey(name);
  const match = process.platform === "win32"
    ? Object.keys(environment).find((candidate) => environmentKey(candidate) === key)
    : name;
  return match === undefined || !Object.hasOwn(environment, match)
    ? undefined
    : environment[match];
}

function environmentKey(name: string): string {
  return process.platform === "win32" ? name.toUpperCase() : name;
}

function environmentSlotKey(name: string): string {
  return `env:${environmentKey(name)}`;
}

function storedSlotKey(secretId: string): string {
  return `stored:${secretId}`;
}

/** One readable sentence. Long enough for a provider's own wording, short
 * enough that a status line or a toast can show it whole. */
const MAX_PROVIDER_ERROR_SUMMARY = 160;

/** The sentence a provider wrote for a person, not the envelope it arrived in.
 * Every provider this program speaks to states its reason under `error.message`
 * or `message`; the raw body stays on the error for diagnostics. A body that
 * states nothing readable falls back to its own first line, collapsed, so the
 * surface that shows it still gets one line rather than a wall of JSON. */
export function providerErrorSummary(body: string): string {
  const readable = (value: unknown): string | null => {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (value === null || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    return readable(record.message) ?? readable(record.detail);
  };
  let summary: string | null = null;
  try {
    const parsed = JSON.parse(body) as unknown;
    summary = parsed !== null && typeof parsed === "object"
      ? readable((parsed as Record<string, unknown>).error)
        ?? readable(parsed)
      : null;
  } catch {
    summary = null;
  }
  const collapsed = (summary ?? body).replace(/\s+/gu, " ").trim();
  return collapsed.length <= MAX_PROVIDER_ERROR_SUMMARY
    ? collapsed
    : `${collapsed.slice(0, MAX_PROVIDER_ERROR_SUMMARY - 1).trimEnd()}…`;
}

import { createHash } from "node:crypto";
import type { PromptOperation, PromptPlan } from "../shared/prompt-plan.js";
import {
  promptCacheAdapter,
  resolvePromptCacheCapability,
  type PromptCacheAdapter,
  type PromptCacheContext,
  type PromptCacheTokenizer
} from "../shared/prompt-cache-capabilities.js";
import {
  lastStablePromptBoundary,
  planRollingOpenAiBreakpoints,
  PromptCacheBreakpointRegistry,
  type PromptBlockLocation
} from "./prompt-cache-breakpoints.js";
import {
  countO200kPromptTextTokens,
  type PromptTokenCounter
} from "./openai-prompt-tokenizer.js";

export {
  promptCacheAdapter,
  type PromptCacheAdapter,
  type PromptCacheContext
} from "../shared/prompt-cache-capabilities.js";

export const PROMPT_CACHE_SCOPE_DOMAIN = "1667-prompt-cache-scope-v1\0";

export type PromptCacheOmissionReason =
  | "policy-off"
  | "legacy-v1"
  | "dry-run"
  | "no-stable-boundary";

export type PromptCacheBlockReason =
  | "unsupported"
  | "unknown-model"
  | "compatible-endpoint"
  | "long-unsupported";

export type PromptCachePolicyPlan =
  | Readonly<{ kind: "omit"; reason: PromptCacheOmissionReason }>
  | Readonly<{ kind: "blocked"; reason: PromptCacheBlockReason }>
  | Readonly<{ kind: "anthropic-explicit"; ttl: "5m" | "1h" }>
  | Readonly<{ kind: "openai-automatic"; retention: "24h" | null }>
  | Readonly<{ kind: "openai-explicit-off" }>
  | Readonly<{
      kind: "openai-explicit";
      minimumTokens: 1024;
      tokenizer: PromptCacheTokenizer;
      maximumBreakpoints: 4;
    }>;

export type PromptCacheWirePlan =
  | Readonly<{ kind: "omit"; reason: PromptCacheOmissionReason }>
  | Readonly<{
      kind: "anthropic-explicit";
      ttl: "5m" | "1h";
      breakpoint: PromptBlockLocation;
    }>
  | Readonly<{
      kind: "openai-automatic";
      key: string;
      retention: "24h" | null;
    }>
  | Readonly<{ kind: "openai-explicit-off" }>
  | Readonly<{
      kind: "openai-explicit";
      key: string;
      breakpoints: readonly PromptBlockLocation[];
    }>;

export interface PreparedPromptCachePlan {
  readonly wire: PromptCacheWirePlan;
  /** Record the newest eligible boundary only once provider dispatch is durable. */
  commit(): void;
}

export interface PromptCacheRequest {
  readonly context: PromptCacheContext;
  readonly scope: string;
  readonly runtime: PromptCacheRuntime;
}

export const PROMPT_CACHE_POLICY_OFF: Readonly<{
  kind: "omit";
  reason: "policy-off";
}> = {
  kind: "omit",
  reason: "policy-off"
};

export const LEGACY_PROMPT_CACHE_CONTEXT: PromptCacheContext = {
  source: "legacy-v1",
  policy: "off",
  support: "unknown",
  protocol: "legacy-v1",
  preset: "legacy-v1",
  remoteModelId: "",
  adapter: "legacy-v1"
};

export class PromptCachePolicyError extends Error {
  constructor(readonly reason: PromptCacheBlockReason) {
    super(promptCacheBlockMessage(reason));
    this.name = "PromptCachePolicyError";
  }
}

export class PromptCacheRuntime {
  readonly #registry: PromptCacheBreakpointRegistry;

  constructor(options: {
    readonly registryCapacity?: number;
    readonly countOpenAiTokens?: PromptTokenCounter;
  } = {}) {
    this.#registry = new PromptCacheBreakpointRegistry(options.registryCapacity);
    this.countOpenAiTokens = options.countOpenAiTokens ?? countO200kPromptTextTokens;
  }

  private readonly countOpenAiTokens: PromptTokenCounter;

  prepare(
    context: PromptCacheContext,
    scope: string,
    prompt: PromptPlan
  ): PreparedPromptCachePlan {
    const policy = lowerPromptCache(context);
    switch (policy.kind) {
      case "blocked":
        throw new PromptCachePolicyError(policy.reason);
      case "omit":
        return prepared(policy);
      case "anthropic-explicit": {
        const breakpoint = lastStablePromptBoundary(prompt);
        return breakpoint === null
          ? prepared({ kind: "omit", reason: "no-stable-boundary" })
          : prepared({ ...policy, breakpoint });
      }
      case "openai-automatic":
        return prepared({ ...policy, key: scope });
      case "openai-explicit-off":
        return prepared(policy);
      case "openai-explicit": {
        const registryScope = `pc:v1:${context.remoteModelId}:${scope}`;
        const rolling = planRollingOpenAiBreakpoints(
          prompt,
          this.#registry.previous(registryScope),
          policy.minimumTokens,
          policy.maximumBreakpoints,
          this.tokenCounter(policy.tokenizer)
        );
        let committed = false;
        return {
          wire: {
            kind: "openai-explicit",
            key: scope,
            breakpoints: rolling.locations
          },
          commit: () => {
            if (committed || rolling.newestBoundaryHash === null) return;
            committed = true;
            this.#registry.commit(registryScope, rolling.newestBoundaryHash);
          }
        };
      }
    }
  }

  clear(): void {
    this.#registry.clear();
  }

  get registrySize(): number {
    return this.#registry.size;
  }

  private tokenCounter(tokenizer: PromptCacheTokenizer): PromptTokenCounter {
    switch (tokenizer) {
      case "o200k_base":
        return this.countOpenAiTokens;
    }
  }
}

export function lowerPromptCache(context: PromptCacheContext): PromptCachePolicyPlan {
  if (context.policy === "off") {
    if (context.source === "legacy-v1") return { kind: "omit", reason: "legacy-v1" };
    if (context.adapter === "dry-run") return { kind: "omit", reason: "dry-run" };
    const resolution = resolvePromptCacheCapability(context);
    return resolution.kind === "available"
      && resolution.capability.kind === "openai-explicit"
      ? { kind: "openai-explicit-off" }
      : PROMPT_CACHE_POLICY_OFF;
  }

  const resolution = resolvePromptCacheCapability(context);
  if (resolution.kind === "unavailable") {
    switch (resolution.reason) {
      case "legacy-v1":
      case "dry-run":
      case "unsupported":
        return { kind: "blocked", reason: "unsupported" };
      case "compatible-endpoint":
        return { kind: "blocked", reason: "compatible-endpoint" };
      case "unknown-model":
        return { kind: "blocked", reason: "unknown-model" };
    }
  }

  const capability = resolution.capability;
  if (context.policy === "long") {
    if (capability.kind === "anthropic-explicit") {
      return { kind: "anthropic-explicit", ttl: capability.longTtl };
    }
    if (capability.kind === "openai-automatic" && capability.longRetention !== null) {
      return { kind: "openai-automatic", retention: capability.longRetention };
    }
    return { kind: "blocked", reason: "long-unsupported" };
  }

  switch (capability.kind) {
    case "anthropic-explicit":
      return { kind: "anthropic-explicit", ttl: capability.autoTtl };
    case "openai-automatic":
      return { kind: "openai-automatic", retention: null };
    case "openai-explicit":
      return {
        kind: "openai-explicit",
        minimumTokens: capability.minimumTokens,
        tokenizer: capability.tokenizer,
        maximumBreakpoints: capability.maximumBreakpoints
      };
  }
}

export function promptCacheBlockMessage(reason: PromptCacheBlockReason): string {
  switch (reason) {
    case "unsupported":
      return "Prompt caching is unsupported for the selected provider or model.";
    case "unknown-model":
      return "No exact prompt-cache request contract is declared for the selected model ID.";
    case "compatible-endpoint":
      return "Prompt-cache controls are disabled for compatible and custom endpoints.";
    case "long-unsupported":
      return "Long prompt-cache retention is unavailable for the selected exact model.";
  }
}

/** Stable, privacy-preserving routing identity. The hash owns only the story
 * identifier; the operation family remains an inspectable suffix. Prompt text,
 * story titles, and user identity never enter the key. */
export function promptCacheScope(storyId: string, operation: PromptOperation): string {
  if (storyId.length === 0) throw new Error("Prompt-cache scope requires a story ID");
  const digest = createHash("sha256")
    .update(PROMPT_CACHE_SCOPE_DOMAIN, "utf8")
    .update(storyId, "utf8")
    .digest("hex");
  return `st:v1:${digest}:${operation}`;
}

export function createPromptCacheRequest(
  runtime: PromptCacheRuntime,
  context: PromptCacheContext,
  storyId: string,
  operation: PromptOperation
): PromptCacheRequest {
  return {
    runtime,
    context,
    scope: promptCacheScope(storyId, operation)
  };
}

function prepared(wire: PromptCacheWirePlan): PreparedPromptCachePlan {
  return { wire, commit: () => {} };
}

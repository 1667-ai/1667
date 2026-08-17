import {
  promptCacheContextForDocument,
  promptCacheContextForProfile,
  promptCachePolicyPresentation,
  resolvePromptCacheCapability
} from "../../shared/prompt-cache-capabilities.js";
import type {
  PromptCachePolicyV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { SettingsTextDraft } from "./settings-text.js";

/** The policy is the part the row cycles. `detail` keeps the compact summary
 * used outside the form. `description` explains the effect in the form. */
interface PromptCacheSummaryAvailable {
  readonly kind: "available";
  readonly policy: PromptCachePolicyV2;
  readonly detail: string;
  readonly description: string;
}

interface PromptCacheSummaryUnavailable {
  readonly kind: "unavailable";
  readonly policy: PromptCachePolicyV2;
  readonly detail: "unavailable";
  readonly reason: string;
  readonly compactReason: string;
}

export type PromptCacheSummaryParts =
  | PromptCacheSummaryAvailable
  | PromptCacheSummaryUnavailable;

export function promptCacheSummaryParts(
  view: SettingsView,
  draft?: SettingsTextDraft
): PromptCacheSummaryParts {
  if (!view.editable) {
    return {
      kind: "available",
      policy: "off",
      detail: "no opt-in controls · format 1",
      description: "Prompt caching is unavailable in legacy settings."
    };
  }
  let document = view.document;
  let profileId: string | undefined;
  if (draft !== undefined) {
    if (draft.document === null || draft.selectedProfileId === null) {
      return {
        kind: "unavailable",
        policy: draft.cachePolicy,
        detail: "unavailable",
        reason: "Editable settings document is unavailable.",
        compactReason: "Fix invalid cache settings."
      };
    }
    document = draft.document;
    profileId = draft.selectedProfileId;
  }
  const context = profileId === undefined
    ? promptCacheContextForDocument(document)
    : promptCacheContextForProfile(document, profileId);
  const resolution = resolvePromptCacheCapability(context);
  const presentation = promptCachePolicyPresentation(context, context.policy);
  if (!presentation.available) {
    return {
      kind: "unavailable",
      policy: context.policy,
      detail: "unavailable",
      reason: presentation.unavailableReason,
      compactReason: presentation.unavailableReasonCompact
    };
  }
  if (context.policy === "off") {
    const providerManaged = context.adapter === "openai-official"
      || context.adapter === "compatible";
    return {
      kind: "available",
      policy: "off",
      detail: resolution.kind === "available"
        && resolution.capability.kind === "openai-explicit"
        ? "no breakpoints · TTL none · no writes"
        : providerManaged
          ? "no opt-in · TTL provider-managed"
          : "no controls · TTL none",
      description: providerManaged
        ? "The provider manages prompt caching."
        : "Prompt caching is off for this profile."
    };
  }
  if (resolution.kind !== "available") {
    throw new Error("Available cache policy has no capability");
  }
  const behavior = resolution.capability.kind === "anthropic-explicit"
    ? "stable block"
    : resolution.capability.kind === "openai-automatic"
      ? "stable key"
      : "breakpoints";
  const writeMultiplier = presentation.writeMultiplier;
  if (writeMultiplier === null) {
    throw new Error("Available opt-in cache policy has no write multiplier");
  }
  const writeCost = writeMultiplier === 1
    ? "no premium"
    : `${writeMultiplier}× writes`;
  return {
    kind: "available",
    policy: context.policy,
    detail: `${behavior} · ${presentation.compactTtl} · ${writeCost}`,
    description: cacheDescription(
      resolution.capability.kind,
      presentation.compactTtl,
      writeMultiplier
    )
  };
}

function cacheDescription(
  kind: "anthropic-explicit" | "openai-automatic" | "openai-explicit",
  ttl: string,
  writeMultiplier: number
): string {
  const reuse = kind === "openai-automatic"
    ? "Lets the provider reuse matching prompt text"
    : kind === "anthropic-explicit"
      ? "Reuses the unchanged start of the prompt"
      : "Reuses prompt text at marked breakpoints";
  const duration = ttl.startsWith("≤")
    ? `for up to ${ttl.slice(1)}`
    : ttl.startsWith("≥")
      ? `for at least ${ttl.slice(1)}`
      : `for ${ttl}`;
  const cost = writeMultiplier === 1
    ? "Caching new prompt text has no extra cost."
    : `Caching new prompt text costs ${writeMultiplier}× the normal input price.`;
  return `${reuse} ${duration}. ${cost}`;
}

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

/** The policy is the part the row cycles; the detail is what that choice
 * costs. The row keeps them apart so the arrows can sit on the policy alone
 * and the detail can follow the closing bracket. */
interface PromptCacheSummaryAvailable {
  readonly kind: "available";
  readonly policy: PromptCachePolicyV2;
  readonly detail: string;
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
      detail: "no opt-in controls · format 1"
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
    return {
      kind: "available",
      policy: "off",
      detail: resolution.kind === "available"
        && resolution.capability.kind === "openai-explicit"
        ? "no breakpoints · TTL none · no writes"
        : context.adapter === "openai-official" || context.adapter === "compatible"
          ? "no opt-in · TTL provider-managed"
          : "no controls · TTL none"
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
    detail: `${behavior} · ${presentation.compactTtl} · ${writeCost}`
  };
}

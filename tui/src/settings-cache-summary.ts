import {
  applyPromptCachePolicy,
  promptCacheContextForDocument,
  promptCachePolicyPresentation,
  resolvePromptCacheCapability
} from "../../shared/prompt-cache-capabilities.js";
import type {
  PromptCachePolicyV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import type { SettingsTextDraft } from "./settings-text.js";

/** The policy is the part the row cycles; the detail is what that choice
 * costs. The row keeps them apart so the arrows can sit on the policy alone
 * and the detail can follow the closing bracket. */
export interface PromptCacheSummaryParts {
  readonly policy: PromptCachePolicyV2;
  readonly detail: string;
}

export function promptCacheSummaryParts(
  view: SettingsView,
  draft?: SettingsTextDraft
): PromptCacheSummaryParts {
  if (!view.editable) {
    return { policy: "off", detail: "no opt-in controls · format 1" };
  }
  let document = view.document;
  if (draft !== undefined) {
    try {
      document = applyPromptCachePolicy(
        applyBasicSettingsDraft(document, draft.generation),
        draft.cachePolicy
      );
    } catch (error) {
      return {
        policy: draft.cachePolicy,
        detail: `unavailable · ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  const context = promptCacheContextForDocument(document);
  const presentation = promptCachePolicyPresentation(context, context.policy);
  const resolution = resolvePromptCacheCapability(context);
  if (!presentation.available) {
    return {
      policy: context.policy,
      detail: `unavailable · ${presentation.unavailableReason ?? presentation.behavior}`
    };
  }
  if (context.policy === "off") {
    return {
      policy: "off",
      detail: resolution.kind === "available"
        && resolution.capability.kind === "openai-explicit"
        ? "no breakpoints · TTL none · no writes"
        : context.adapter === "openai-official" || context.adapter === "compatible"
          ? "no opt-in · TTL provider-managed"
          : "no controls · TTL none"
    };
  }
  if (resolution.kind === "unavailable") {
    return {
      policy: context.policy,
      detail: `unavailable · ${presentation.behavior}`
    };
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
    policy: context.policy,
    detail: `${behavior} · ${presentation.compactTtl} · ${writeCost}`
  };
}

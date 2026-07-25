import {
  applyPromptCachePolicy,
  promptCacheContextForDocument,
  promptCachePolicyPresentation,
  resolvePromptCacheCapability
} from "../../shared/prompt-cache-capabilities.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import type { SettingsTextDraft } from "./settings-text.js";

export function promptCacheSummary(
  view: SettingsView,
  draft?: SettingsTextDraft
): string {
  if (!view.editable) return "off · no opt-in controls · format 1";
  let document = view.document;
  if (draft !== undefined) {
    try {
      document = applyPromptCachePolicy(
        applyBasicSettingsDraft(document, draft.generation),
        draft.cachePolicy
      );
    } catch (error) {
      return `unavailable · ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const context = promptCacheContextForDocument(document);
  const presentation = promptCachePolicyPresentation(context, context.policy);
  const resolution = resolvePromptCacheCapability(context);
  if (!presentation.available) {
    return `${context.policy} · unavailable · ${
      presentation.unavailableReason ?? presentation.behavior
    }`;
  }
  if (context.policy === "off") {
    return resolution.kind === "available"
      && resolution.capability.kind === "openai-explicit"
      ? "off · no breakpoints · TTL none · no writes"
      : context.adapter === "openai-official" || context.adapter === "compatible"
        ? "off · no opt-in · TTL provider-managed"
        : "off · no controls · TTL none";
  }
  if (resolution.kind === "unavailable") {
    return `${context.policy} · unavailable · ${presentation.behavior}`;
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
  return `${context.policy} · ${behavior} · ${presentation.compactTtl} · ${writeCost}`;
}

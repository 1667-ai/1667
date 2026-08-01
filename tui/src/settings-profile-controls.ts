import {
  GENERATION_EFFORT_V2_VALUES,
  PROMPT_CACHE_POLICY_V2_VALUES,
  type SettingsRoutePurpose,
  type SettingsView
} from "../../shared/settings-v2-types.js";
import type { UserConfig } from "./config.js";
import {
  localProviderPresetsSupported,
  settingsProviderChoice
} from "./settings-provider-choices.js";
import { settingsModelChoices } from "./settings-model-discovery.js";
import { promptCacheSummaryParts } from "./settings-cache-summary.js";
import {
  cycleSettingsProfile as cycleProfile,
  cycleSettingsRoute as cycleRoute,
  profileRouteState,
  settingsProfileIds
} from "./settings-profile-draft.js";
import { storedApiKeyPresentation } from "./settings-secret-sidecar.js";
import {
  settingsTextDraftForDocument,
  settingsTextDraftWithCachePolicy
} from "./settings-text.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";

export interface SettingsRowPresentation {
  readonly id: SettingsRowId;
  readonly label: string;
  readonly value: string;
}

/** All profile-aware row presentation stays together. The overlay model owns
 * text editing and reconciliation; this module owns closed profile controls. */
export function settingsRows(
  overlay: SettingsOverlayState,
  config: UserConfig
): readonly SettingsRowPresentation[] {
  const settings = overlay.draft.generation;
  const providerChoice = settingsProviderChoice(settings);
  const providerLabel = providerChoice.plaintextDefaultRequiresOwnedLoopback === true
    && !localProviderPresetsSupported()
    && isPlainHttp(settings.baseUrl)
    && settings.allowInsecureHttp !== true
    ? `${providerChoice.label} · needs insecure HTTP`
    : providerChoice.label;
  return [
    { id: "theme", label: "theme", value: `‹ ${config.theme} ›` },
    { id: "compose-focus", label: "compose focus", value: `[ ${config.composeFocus} ]` },
    { id: "provider", label: "provider", value: `‹ ${providerLabel} ›` },
    { id: "base-url", label: "base URL", value: settings.baseUrl || "—" },
    {
      id: "allow-insecure-http",
      label: "insecure HTTP",
      value: `[ ${settings.allowInsecureHttp === true ? "on" : "off"} ]`
    },
    { id: "api-key", label: "API key", value: storedApiKeyPresentation(overlay) },
    { id: "api-key-env", label: "API key env", value: settings.apiKeyEnv ?? "—" },
    { id: "profile", label: "profile", value: profileRowValue(overlay) },
    { id: "model", label: "model", value: modelRowValue(overlay) },
    {
      id: "temperature",
      label: "temperature",
      value: settings.temperature?.toString() ?? "default"
    },
    {
      id: "max-tokens",
      label: "max tokens",
      value: settings.maxTokens.toLocaleString("en-US")
    },
    {
      id: "context-window",
      label: "context window",
      value: settings.contextWindow?.toLocaleString("en-US") ?? "unknown"
    },
    { id: "effort", label: "effort", value: effortRowValue(overlay) },
    { id: "cache-policy", label: "cache", value: promptCacheRowValue(overlay.view, overlay.draft) },
    { id: "default-route", label: "default route", value: routeRowValue(overlay, "default") },
    { id: "prose-route", label: "prose route", value: routeRowValue(overlay, "prose") },
    { id: "utility-route", label: "utility route", value: routeRowValue(overlay, "utility") },
    {
      id: "system-prompt",
      label: "system prompt",
      value: settings.systemPrompt.replace(/\s+/g, " ")
    }
  ];
}

export function cycleProfileControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  const document = overlay.draft.document;
  const selected = overlay.draft.selectedProfileId;
  if (document === null || selected === null) return null;
  const profileId = cycleProfile(document, selected, step);
  overlay.draft = settingsTextDraftForDocument(document, profileId);
  markControlMutation(overlay);
  return document.profiles[profileId]!.name;
}

export function cycleRouteControl(
  overlay: SettingsOverlayState,
  purpose: SettingsRoutePurpose,
  step: -1 | 1
): string | null {
  const document = overlay.draft.document;
  const selected = overlay.draft.selectedProfileId;
  if (document === null || selected === null) return null;
  const next = cycleRoute(document, purpose, step);
  overlay.draft = settingsTextDraftForDocument(next, selected);
  markControlMutation(overlay);
  return routeRowValue(overlay, purpose);
}

export function cycleEffortControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return null;
  const profile = document.profiles[profileId];
  if (profile === undefined) return null;
  const choices = generationEffortChoices(document, profileId);
  const index = choices.indexOf(profile.effort);
  const effort = choices[index < 0
    ? 0
    : (index + step + choices.length) % choices.length]!;
  overlay.draft = settingsTextDraftForDocument({
    ...document,
    profiles: { ...document.profiles, [profileId]: { ...profile, effort } }
  }, profileId);
  markControlMutation(overlay);
  return effort;
}

export function cycleCachePolicyControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  const index = PROMPT_CACHE_POLICY_V2_VALUES.indexOf(overlay.draft.cachePolicy);
  const policy = PROMPT_CACHE_POLICY_V2_VALUES[
    (index + step + PROMPT_CACHE_POLICY_V2_VALUES.length) % PROMPT_CACHE_POLICY_V2_VALUES.length
  ]!;
  overlay.draft = settingsTextDraftWithCachePolicy(overlay.draft, policy);
  markControlMutation(overlay);
  return policy;
}

export function promptCacheRowValue(view: SettingsView, draft?: SettingsOverlayState["draft"]): string {
  const parts = promptCacheSummaryParts(view, draft);
  return `‹ ${parts.policy} › · ${
    parts.kind === "available" ? parts.detail : `unavailable · ${parts.reason}`
  }`;
}

function effortRowValue(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "‹ default ›";
  const effort = document.profiles[profileId]?.effort ?? "default";
  return generationEffortChoices(document, profileId).includes(effort)
    ? `‹ ${effort} ›`
    : `‹ ${effort} › · unavailable`;
}

/** Runtime validation permits an explicit effort only with a supported model.
 * Anthropic has no mapping for `off`, so do not offer a value that its request
 * adapter would reject. Unknown capability is conservative: default only. */
function generationEffortChoices(
  document: NonNullable<SettingsOverlayState["draft"]["document"]>,
  profileId: string
): readonly (typeof GENERATION_EFFORT_V2_VALUES)[number][] {
  const profile = document.profiles[profileId];
  const model = profile === undefined ? undefined : document.models[profile.modelId];
  if (model?.capabilities.reasoningEffort !== "supported") return ["default"];
  const connection = document.connections[model.connectionId];
  return connection?.protocol === "anthropic-messages"
    ? ["default", "low", "medium", "high"]
    : GENERATION_EFFORT_V2_VALUES;
}

function profileRowValue(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "‹ legacy profile ›";
  const profile = document.profiles[profileId];
  if (profile === undefined) return "‹ unavailable ›";
  const ids = settingsProfileIds(document);
  const dots = ids.length <= 8
    ? `  ${ids.map((id) => id === profileId ? "●" : "○").join("")}`
    : "";
  const route = profileRouteState(document, profileId);
  return `‹ ${profile.name} ›${dots}${route === "unrouted" ? " · unrouted" : ""}`;
}

function routeRowValue(overlay: SettingsOverlayState, purpose: SettingsRoutePurpose): string {
  const document = overlay.draft.document;
  if (document === null) return "‹ unavailable ›";
  const profileId = purpose === "default"
    ? document.routing.default
    : document.routing[purpose];
  return profileId === undefined
    ? "‹ same as default ›"
    : `‹ ${document.profiles[profileId]?.name ?? "unavailable"} ›`;
}

function modelRowValue(overlay: SettingsOverlayState): string {
  const model = overlay.draft.generation.model;
  const choices = settingsModelChoices(overlay);
  if (choices.length === 0) return model || "—";
  const selected = choices.find((choice) => choice.remoteId === model);
  const label = selected === undefined
    ? model.length === 0 ? "choose model" : `${settingsModelDisplayText(model)} · custom`
    : selected.name === selected.remoteId
      ? settingsModelDisplayText(selected.remoteId)
      : `${settingsModelDisplayText(selected.name)} · ${settingsModelDisplayText(selected.remoteId)}`;
  return `‹ ${label} ›`;
}

function markControlMutation(overlay: SettingsOverlayState): void {
  overlay.deleteArmedProfileId = null;
  overlay.result = null;
  if (overlay.conflict !== null) overlay.conflict.armed = false;
}

function isPlainHttp(value: string): boolean {
  try {
    return new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

export function settingsModelDisplayText(value: string): string {
  return value.replace(/\s+/gu, " ");
}

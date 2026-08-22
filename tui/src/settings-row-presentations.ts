import {
  PROMPT_CACHE_POLICY_V2_VALUES,
  type SettingsRoutePurpose
} from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import { THEME_NAMES, type UserConfig } from "./config.js";
import type { KeyAction } from "./keys.js";
import {
  scalarChipText,
  scalarInvalidReason,
  settingsScalar,
  type SettingsScalar,
  type SettingsScalarRow
} from "./settings-scalar.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";
import {
  localProviderPresetsSupported,
  settingsProviderChoice
} from "./settings-provider-choices.js";
import {
  settingsPlanRowDisabled,
  settingsSubscriptionLoginHint,
  settingsSubscriptionPreset
} from "./settings-subscription.js";
import { settingsRowIds } from "./settings-row-navigation.js";
import { promptCacheSummaryParts } from "./settings-cache-summary.js";
import { samplingRowValue } from "./sampling-model.js";
import {
  imageInputRowHint,
  imageInputRowState,
  imageInputRowValue
} from "./settings-image-input-row.js";
import {
  reasoningRowChoices,
  reasoningRowHint,
  reasoningRowState,
  reasoningRowValue
} from "./settings-reasoning-row.js";
import {
  tokenProbabilitiesRowHint,
  tokenProbabilitiesRowState,
  tokenProbabilitiesRowValue
} from "./settings-token-probabilities-row.js";
import { connectionTimeoutRows } from "./settings-connection-timeouts.js";
import { storedApiKeyPresentation } from "./settings-secret-sidecar.js";
import { settingsReadOnlyMessage } from "./settings-read-only.js";
import {
  continuationPromptRowHint,
  continuationPromptRowValue,
  effortPositionDots,
  effortRowHint,
  effortRowValue,
  keepThoughts,
  modelRowHint,
  modelRowValue,
  positionDots,
  profilePositionDots,
  profileRowHint,
  profileRowValue,
  providerPositionDots,
  routeRowValue,
  splitThinkTags,
  textPromptFormat,
  textPromptFormatChoices
} from "./settings-profile-controls.js";
import {
  WRITING_PROMPT_FIELD_DEFINITIONS,
  writingPromptRowHelp
} from "../../shared/settings-v5-writing.js";
import { draftWriting } from "./settings-writing-draft.js";

/** The form groups under `── light ──` section rules. One list, named once:
 * the rule is the section heading, and clicking it jumps there. */
export const SETTINGS_SECTIONS = [
  { id: "app", label: "app" },
  { id: "prompt", label: "prompt" },
  { id: "connection", label: "connection" },
  { id: "model", label: "model" },
  { id: "generation", label: "generation" },
  { id: "story", label: "story" },
  { id: "routing", label: "routing" }
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** C-07's field row: label, value, and a hint. An unselected hint truncates.
 * The selected hint wraps below the field. Detail used to be glued onto the
 * value string, so a narrow panel clipped the value and the detail together. */
export interface SettingsRowPresentation {
  readonly id: SettingsRowId;
  readonly section: SettingsSectionId;
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  /** F-2: why this value is refused. Ember in the value, reason in the hint. */
  readonly invalid?: string;
  /** C-09 position dots for a cycler, drawn after the chip. */
  readonly dots?: string;
  /** Present on a C-08 scalar; the panel paints its track. */
  readonly scalar?: SettingsScalar;
  /** The value is fixed by the selected subscription connection. */
  readonly disabled?: true;
  /** C-18 secondary action in the value column, reached with `tab`. */
  readonly action?: { readonly label: string; readonly key: KeyAction };
}

/** Build the settings rows. Profile-aware control logic stays in the focused
 * row modules and settings-profile-controls.ts. */
export function settingsRows(
  overlay: SettingsOverlayState,
  config: UserConfig
): readonly SettingsRowPresentation[] {
  const settings = overlay.draft.generation;
  const subscriptionPreset = settingsSubscriptionPreset(overlay);
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  const selectedPreset = subscriptionPreset ?? (document === null || profileId === null
    ? undefined
    : resolveSettingsProfile(document, profileId).connection.preset);
  const providerChoice = settingsProviderChoice(settings, selectedPreset);
  const subscriptionHint = subscriptionPreset === null
    ? null
    : settingsSubscriptionLoginHint(subscriptionPreset, overlay.view.subscriptionAuth);
  const insecureNeeded = providerChoice.plaintextDefaultRequiresOwnedLoopback === true
    && !localProviderPresetsSupported()
    && isPlainHttp(settings.baseUrl)
    && settings.allowInsecureHttp !== true;
  const successorReadOnly = overlay.view.readOnlyReason === "successor-schema";
  const readOnlyMessage = settingsReadOnlyMessage(overlay.view.readOnlyReason);
  const cache = promptCacheSummaryParts(overlay.view, overlay.draft);
  const tokenProbabilities = tokenProbabilitiesRowState(overlay);
  const reasoning = reasoningRowState(overlay);
  const imageInput = imageInputRowState(overlay);
  const reasoningValue = successorReadOnly
    ? overlay.view.effectiveProseReasoning === undefined
      ? "‹ successor-owned ›"
      : `‹ ${overlay.view.effectiveProseReasoning} ›`
    : reasoningRowValue(reasoning);
  const reasoningHint = successorReadOnly ? readOnlyMessage : reasoningRowHint(reasoning);
  const rows: SettingsRowPresentation[] = [
    {
      id: "theme", section: "app", label: "theme",
      value: `‹ ${config.theme} ›`,
      dots: positionDots(THEME_NAMES, config.theme),
      hint: "Changes colors throughout the app."
    },
    {
      id: "compose-focus", section: "app", label: "focus mode",
      value: `[ ${config.composeFocus} ]`,
      hint: "Dims the story while you write in the compose box."
    },
    {
      id: "word-wrap", section: "app", label: "word wrap",
      value: `[ ${config.wordWrap} ]`,
      hint: "Keeps whole words together when editor lines wrap."
    },
    {
      id: "update-checks", section: "app", label: "update checks",
      value: `[ ${config.updates.mode === "notify" ? "on" : "off"} ]`,
      hint: "Checks for a newer version. Sends no story or account data."
    },
    ...writingPromptRows(overlay),
    {
      id: "provider", section: "connection", label: "provider",
      value: `‹ ${providerChoice.label} ›`,
      dots: providerPositionDots(settings, selectedPreset),
      hint: insecureNeeded
        ? ""
        : subscriptionHint ?? "Selects the service that runs the model.",
      ...(insecureNeeded ? { invalid: "Turn on plain HTTP to use this address." } : {})
    },
    {
      id: "text-prompt-format", section: "connection", label: "prompt format",
      value: settings.provider === "text-completion"
        ? successorReadOnly ? "‹ successor-owned ›" : `‹ ${textPromptFormat(overlay)} ›`
        : "—",
      dots: settings.provider === "text-completion"
        ? successorReadOnly
          ? ""
          : positionDots(textPromptFormatChoices(overlay), textPromptFormat(overlay))
        : "",
      hint: settings.provider === "text-completion"
        ? successorReadOnly
          ? readOnlyMessage
          : "Sets how prompts are formatted for text-completion models."
        : "Available with text-completion providers.",
      ...(settingsPlanRowDisabled(overlay, "text-prompt-format")
        ? { disabled: true as const }
        : {})
    },
    {
      id: "split-think-tags", section: "connection", label: "split thoughts",
      value: settings.provider === "text-completion"
        ? successorReadOnly ? "‹ successor-owned ›" : `[ ${splitThinkTags(overlay) ? "on" : "off"} ]`
        : "—",
      hint: settings.provider === "text-completion"
        ? successorReadOnly
          ? readOnlyMessage
          : "Keeps <think> text separate from story prose."
        : "Available with text-completion providers.",
      ...(settingsPlanRowDisabled(overlay, "split-think-tags")
        ? { disabled: true as const }
        : {})
    },
    {
      id: "base-url", section: "connection", label: "base URL",
      value: subscriptionPreset === null ? settings.baseUrl || "—" : "—",
      hint: subscriptionHint ?? "The address used to reach the model service.",
      ...(subscriptionPreset === null
        ? { action: { label: "check connection", key: "check" as const } }
        : { disabled: true as const })
    },
    {
      id: "allow-insecure-http", section: "connection", label: "plain HTTP",
      value: subscriptionPreset === null
        ? `[ ${settings.allowInsecureHttp === true ? "on" : "off"} ]`
        : "—",
      hint: subscriptionHint ?? "Allows plain HTTP for a model service you control.",
      ...(settingsPlanRowDisabled(overlay, "allow-insecure-http")
        ? { disabled: true as const }
        : {})
    },
    // One way to supply a key. C-14 prefers the env-var form, but offering
    // both put two rows in front of every writer with no answer on screen to
    // "which one do I fill in". An `apiKeyEnv` already in a config still
    // resolves at request time; it simply has no row of its own.
    {
      id: "api-key", section: "connection", label: "API key",
      value: successorReadOnly
        ? "‹ successor-owned ›"
        : subscriptionPreset === null ? storedApiKeyPresentation(overlay) : "—",
      hint: successorReadOnly
        ? readOnlyMessage
        : subscriptionHint ?? "Saved on this device; never stored with a story.",
      ...(settingsPlanRowDisabled(overlay, "api-key")
        ? { disabled: true as const }
        : {})
    },
    ...connectionTimeoutRows(overlay),
    {
      id: "profile", section: "model", label: "profile",
      value: profileRowValue(overlay),
      dots: profilePositionDots(overlay),
      hint: profileRowHint(overlay)
    },
    {
      id: "model", section: "model", label: "model",
      value: modelRowValue(overlay),
      hint: modelRowHint(overlay)
    },
    {
      id: "image-input", section: "model", label: "image input",
      value: successorReadOnly ? "‹ successor-owned ›" : imageInputRowValue(imageInput),
      hint: successorReadOnly ? readOnlyMessage : imageInputRowHint(imageInput)
    },
    scalarRow("temperature", "temperature", overlay, "Higher values make the writing less predictable."),
    scalarRow("max-tokens", "max tokens", overlay, "Limits the length of each response."),
    {
      id: "sampling", section: "generation", label: "sampling",
      value: samplingRowValue(overlay),
      hint: successorReadOnly
        ? readOnlyMessage
        : "Adjusts word choice, repetition, and token selection."
    },
    scalarRow("context-window", "context size", overlay, "Sets how much story context the model can read."),
    {
      id: "effort", section: "generation", label: "effort",
      value: effortRowValue(overlay),
      dots: effortPositionDots(overlay),
      hint: effortRowHint(overlay)
    },
    {
      id: "cache-policy", section: "generation", label: "prompt cache",
      value: `‹ ${cache.policy} ›`,
      dots: cache.kind === "available"
        ? positionDots(PROMPT_CACHE_POLICY_V2_VALUES, overlay.draft.cachePolicy)
        : "",
      hint: cache.kind === "available" ? cache.description : cache.reason
    },
    {
      id: "continuation-prompt", section: "generation", label: "prompt layout",
      value: continuationPromptRowValue(overlay),
      hint: continuationPromptRowHint(overlay)
    },
    {
      id: "token-probabilities", section: "generation", label: "alternatives",
      value: tokenProbabilitiesRowValue(tokenProbabilities),
      hint: tokenProbabilitiesRowHint(tokenProbabilities)
    },
    {
      id: "reasoning", section: "story", label: "reasoning",
      value: reasoningValue,
      dots: successorReadOnly ? "" : positionDots(reasoningRowChoices(overlay), reasoning.display),
      hint: reasoningHint
    },
    {
      id: "keep-thoughts", section: "story", label: "save thoughts",
      value: successorReadOnly ? "‹ successor-owned ›" : `[ ${keepThoughts(overlay) ? "on" : "off"} ]`,
      hint: successorReadOnly
        ? readOnlyMessage
        : "Saves model reasoning with each take."
    },
    routeRow("default-route", "default", overlay, "default"),
    routeRow("prose-route", "prose", overlay, "prose"),
    routeRow("utility-route", "utility", overlay, "utility")
  ];
  // settingsRowIds is the one canonical visibility list — subscription and
  // view-mode filtering both live there, so the rendered rows and the
  // cursor's row list can never drift apart.
  const visibleRowIds = new Set(settingsRowIds(overlay));
  return rows.filter((row) => visibleRowIds.has(row.id));
}

function writingPromptRows(
  overlay: SettingsOverlayState
): readonly SettingsRowPresentation[] {
  const writing = draftWriting(overlay.draft);
  return WRITING_PROMPT_FIELD_DEFINITIONS.map((definition) => ({
    id: definition.row,
    section: "prompt" as const,
    label: definition.label,
    value: writingPromptRowValue(writing[definition.field]),
    hint: writingPromptRowHelp(definition)
  }));
}

function writingPromptRowValue(value: string): string {
  return value.length === 0 ? "—" : value.replace(/\s+/g, " ");
}

function scalarRow(
  id: SettingsScalarRow,
  label: string,
  overlay: SettingsOverlayState,
  hint: string
): SettingsRowPresentation {
  const scalar = settingsScalar(id, overlay.draft.generation);
  const invalid = scalarInvalidReason(scalar);
  return {
    id,
    section: "generation",
    label,
    value: `‹ ${scalarChipText(scalar)} ›`,
    scalar,
    hint,
    ...(invalid === null ? {} : { invalid })
  };
}

function routeRow(
  id: SettingsRowId,
  label: string,
  overlay: SettingsOverlayState,
  purpose: SettingsRoutePurpose
): SettingsRowPresentation {
  return {
    id,
    section: "routing",
    label,
    value: routeRowValue(overlay, purpose),
    hint: purpose === "default"
      ? "Used when a task does not have its own profile."
      : purpose === "prose"
        ? "Used to write and rewrite story prose."
        : "Used for summaries and other support tasks."
  };
}

function isPlainHttp(value: string): boolean {
  try {
    return new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

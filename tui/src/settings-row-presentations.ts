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
import {
  CONNECTION_TIMEOUT_ROWS,
  connectionTimeoutRows
} from "./settings-connection-timeouts.js";
import { storedApiKeyPresentation } from "./settings-secret-sidecar.js";
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
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  const selectedPreset = document === null || profileId === null
    ? undefined
    : resolveSettingsProfile(document, profileId).connection.preset;
  const providerChoice = settingsProviderChoice(settings, selectedPreset);
  const subscriptionPreset = settingsSubscriptionPreset(overlay);
  const subscriptionHint = subscriptionPreset === null
    ? null
    : settingsSubscriptionLoginHint(subscriptionPreset, overlay.view.subscriptionAuth);
  const insecureNeeded = providerChoice.plaintextDefaultRequiresOwnedLoopback === true
    && !localProviderPresetsSupported()
    && isPlainHttp(settings.baseUrl)
    && settings.allowInsecureHttp !== true;
  const cache = promptCacheSummaryParts(overlay.view, overlay.draft);
  const tokenProbabilities = tokenProbabilitiesRowState(overlay);
  const reasoning = reasoningRowState(overlay);
  // settingsRowIds is the one canonical visibility list — subscription and
  // view-mode filtering both live there, so the rendered rows and the
  // cursor's row list can never drift apart. Filtered first, and each row
  // below built only when its id survives the filter: the default (simple)
  // view mode hides most of these rows, so their value/hint/dots — several
  // call their own row-module helper — are no longer computed and discarded
  // every frame for a row nobody sees.
  const visibleRowIds = new Set(settingsRowIds(overlay));
  const row = (
    id: SettingsRowId,
    build: () => SettingsRowPresentation
  ): readonly SettingsRowPresentation[] => (visibleRowIds.has(id) ? [build()] : []);
  const rows: SettingsRowPresentation[] = [
    ...row("theme", () => ({
      id: "theme", section: "app", label: "theme",
      value: `‹ ${config.theme} ›`,
      dots: positionDots(THEME_NAMES, config.theme),
      hint: "Changes colors throughout the app."
    })),
    ...row("compose-focus", () => ({
      id: "compose-focus", section: "app", label: "focus mode",
      value: `[ ${config.composeFocus} ]`,
      hint: "Dims the story while you write in the compose box."
    })),
    ...row("word-wrap", () => ({
      id: "word-wrap", section: "app", label: "word wrap",
      value: `[ ${config.wordWrap} ]`,
      hint: "Keeps whole words together when editor lines wrap."
    })),
    ...row("system-prompt", () => ({
      id: "system-prompt", section: "prompt", label: "system",
      value: settings.systemPrompt.replace(/\s+/g, " "),
      hint: "Default Author Brief for prose and story names; a story brief overrides it."
    })),
    ...row("provider", () => ({
      id: "provider", section: "connection", label: "provider",
      value: `‹ ${providerChoice.label} ›`,
      dots: providerPositionDots(settings, selectedPreset),
      hint: insecureNeeded
        ? ""
        : subscriptionHint ?? "Selects the service that runs the model.",
      ...(insecureNeeded ? { invalid: "Turn on plain HTTP to use this address." } : {})
    })),
    ...row("text-prompt-format", () => ({
      id: "text-prompt-format", section: "connection", label: "prompt format",
      value: settings.provider === "text-completion"
        ? `‹ ${textPromptFormat(overlay)} ›`
        : "—",
      dots: settings.provider === "text-completion"
        ? positionDots(textPromptFormatChoices(overlay), textPromptFormat(overlay))
        : "",
      hint: settings.provider === "text-completion"
        ? "Sets how prompts are formatted for text-completion models."
        : "Available with text-completion providers.",
      ...(settingsPlanRowDisabled(overlay, "text-prompt-format")
        ? { disabled: true as const }
        : {})
    })),
    ...row("split-think-tags", () => ({
      id: "split-think-tags", section: "connection", label: "split thoughts",
      value: settings.provider === "text-completion"
        ? `[ ${splitThinkTags(overlay) ? "on" : "off"} ]`
        : "—",
      hint: settings.provider === "text-completion"
        ? "Keeps <think> text separate from story prose."
        : "Available with text-completion providers.",
      ...(settingsPlanRowDisabled(overlay, "split-think-tags")
        ? { disabled: true as const }
        : {})
    })),
    ...row("base-url", () => ({
      id: "base-url", section: "connection", label: "base URL",
      value: subscriptionPreset === null ? settings.baseUrl || "—" : "—",
      hint: subscriptionHint ?? "The address used to reach the model service.",
      ...(subscriptionPreset === null
        ? { action: { label: "check connection", key: "check" as const } }
        : { disabled: true as const })
    })),
    ...row("allow-insecure-http", () => ({
      id: "allow-insecure-http", section: "connection", label: "plain HTTP",
      value: subscriptionPreset === null
        ? `[ ${settings.allowInsecureHttp === true ? "on" : "off"} ]`
        : "—",
      hint: subscriptionHint ?? "Allows plain HTTP for a model service you control.",
      ...(settingsPlanRowDisabled(overlay, "allow-insecure-http")
        ? { disabled: true as const }
        : {})
    })),
    // One way to supply a key. C-14 prefers the env-var form, but offering
    // both put two rows in front of every writer with no answer on screen to
    // "which one do I fill in". An `apiKeyEnv` already in a config still
    // resolves at request time; it simply has no row of its own.
    ...row("api-key", () => ({
      id: "api-key", section: "connection", label: "API key",
      value: subscriptionPreset === null ? storedApiKeyPresentation(overlay) : "—",
      hint: subscriptionHint ?? "Saved on this device; never stored with a story.",
      ...(settingsPlanRowDisabled(overlay, "api-key")
        ? { disabled: true as const }
        : {})
    })),
    ...(CONNECTION_TIMEOUT_ROWS.some((id) => visibleRowIds.has(id))
      ? connectionTimeoutRows(overlay).filter((entry) => visibleRowIds.has(entry.id))
      : []),
    ...row("profile", () => ({
      id: "profile", section: "model", label: "profile",
      value: profileRowValue(overlay),
      dots: profilePositionDots(overlay),
      hint: profileRowHint(overlay)
    })),
    ...row("model", () => ({
      id: "model", section: "model", label: "model",
      value: modelRowValue(overlay),
      hint: modelRowHint(overlay)
    })),
    ...row("image-input", () => ({
      id: "image-input", section: "model", label: "image input",
      value: imageInputRowValue(imageInputRowState(overlay)),
      hint: imageInputRowHint(imageInputRowState(overlay))
    })),
    ...row("temperature", () => scalarRow(
      "temperature", "temperature", overlay, "Higher values make the writing less predictable."
    )),
    ...row("max-tokens", () => scalarRow(
      "max-tokens", "max tokens", overlay, "Limits the length of each response."
    )),
    ...row("sampling", () => ({
      id: "sampling", section: "generation", label: "sampling",
      value: samplingRowValue(overlay),
      hint: "Adjusts word choice, repetition, and token selection."
    })),
    ...row("context-window", () => scalarRow(
      "context-window", "context size", overlay, "Sets how much story context the model can read."
    )),
    ...row("effort", () => ({
      id: "effort", section: "generation", label: "effort",
      value: effortRowValue(overlay),
      dots: effortPositionDots(overlay),
      hint: effortRowHint(overlay)
    })),
    ...row("cache-policy", () => ({
      id: "cache-policy", section: "generation", label: "prompt cache",
      value: `‹ ${cache.policy} ›`,
      dots: positionDots(PROMPT_CACHE_POLICY_V2_VALUES, overlay.draft.cachePolicy),
      hint: cache.kind === "available" ? cache.description : cache.reason
    })),
    ...row("continuation-prompt", () => ({
      id: "continuation-prompt", section: "generation", label: "prompt layout",
      value: continuationPromptRowValue(overlay),
      hint: continuationPromptRowHint(overlay)
    })),
    ...row("token-probabilities", () => ({
      id: "token-probabilities", section: "generation", label: "alternatives",
      value: tokenProbabilitiesRowValue(tokenProbabilities),
      hint: tokenProbabilitiesRowHint(tokenProbabilities)
    })),
    ...row("reasoning", () => ({
      id: "reasoning", section: "story", label: "reasoning",
      value: reasoningRowValue(reasoning),
      dots: positionDots(reasoningRowChoices(overlay), reasoning.display),
      hint: reasoningRowHint(reasoning)
    })),
    ...row("keep-thoughts", () => ({
      id: "keep-thoughts", section: "story", label: "save thoughts",
      value: `[ ${keepThoughts(overlay) ? "on" : "off"} ]`,
      hint: "Saves model reasoning with each take."
    })),
    ...row("default-route", () => routeRow("default-route", "default", overlay, "default")),
    ...row("prose-route", () => routeRow("prose-route", "prose", overlay, "prose")),
    ...row("utility-route", () => routeRow("utility-route", "utility", overlay, "utility"))
  ];
  return rows;
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

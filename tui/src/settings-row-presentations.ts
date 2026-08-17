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
  { id: "connection", label: "connection" },
  { id: "model", label: "model" },
  { id: "generation", label: "generation" },
  { id: "story", label: "story" },
  { id: "routing", label: "routing" },
  { id: "prompt", label: "prompt" }
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** C-07's field row: label, value, and a hint that truncates rather than
 * wrapping. Detail used to be glued onto the value string, so a narrow panel
 * clipped the value and the detail together. */
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
  const insecureNeeded = providerChoice.plaintextDefaultRequiresOwnedLoopback === true
    && !localProviderPresetsSupported()
    && isPlainHttp(settings.baseUrl)
    && settings.allowInsecureHttp !== true;
  const cache = promptCacheSummaryParts(overlay.view, overlay.draft);
  const tokenProbabilities = tokenProbabilitiesRowState(overlay);
  const reasoning = reasoningRowState(overlay);
  return [
    {
      id: "theme", section: "app", label: "theme",
      value: `‹ ${config.theme} ›`,
      dots: positionDots(THEME_NAMES, config.theme),
      hint: "the whole palette, remapped"
    },
    {
      id: "compose-focus", section: "app", label: "focus",
      value: `[ ${config.composeFocus} ]`,
      hint: "dim the page while you type"
    },
    {
      id: "word-wrap", section: "app", label: "word wrap",
      value: `[ ${config.wordWrap} ]`,
      hint: "break editor lines at words, not at the edge"
    },
    {
      id: "provider", section: "connection", label: "provider",
      value: `‹ ${providerChoice.label} ›`,
      dots: providerPositionDots(settings, selectedPreset),
      hint: insecureNeeded ? "" : "who answers a request",
      ...(insecureNeeded ? { invalid: "plain HTTP needs insecure HTTP on" } : {})
    },
    {
      id: "text-prompt-format", section: "connection", label: "prompt format",
      value: settings.provider === "text-completion"
        ? `‹ ${textPromptFormat(overlay)} ›`
        : "—",
      dots: settings.provider === "text-completion"
        ? positionDots(textPromptFormatChoices(overlay), textPromptFormat(overlay))
        : "",
      hint: settings.provider === "text-completion"
        ? "raw text or a minimal instruct wrapper"
        : "text completions only"
    },
    {
      id: "split-think-tags", section: "connection", label: "split thoughts",
      value: settings.provider === "text-completion"
        ? `[ ${splitThinkTags(overlay) ? "on" : "off"} ]`
        : "—",
      hint: settings.provider === "text-completion"
        ? "keep a <think> block as the take's thought"
        : "text completions only"
    },
    {
      id: "base-url", section: "connection", label: "base URL",
      value: settings.baseUrl || "—",
      hint: "the endpoint requests go to",
      action: { label: "check connection", key: "check" }
    },
    {
      id: "allow-insecure-http", section: "connection", label: "insecure",
      value: `[ ${settings.allowInsecureHttp === true ? "on" : "off"} ]`,
      hint: "plain HTTP to a machine you own"
    },
    // One way to supply a key. C-14 prefers the env-var form, but offering
    // both put two rows in front of every writer with no answer on screen to
    // "which one do I fill in". An `apiKeyEnv` already in a config still
    // resolves at request time; it simply has no row of its own.
    {
      id: "api-key", section: "connection", label: "stored key",
      value: storedApiKeyPresentation(overlay),
      hint: "kept on this machine, never in a story"
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
      id: "image-input", section: "model", label: "images",
      value: imageInputRowValue(imageInputRowState(overlay)),
      hint: imageInputRowHint(imageInputRowState(overlay))
    },
    scalarRow("temperature", "temperature", overlay, "how far it strays"),
    scalarRow("max-tokens", "max tokens", overlay, "longest reply"),
    {
      id: "sampling", section: "generation", label: "sampling",
      value: samplingRowValue(overlay),
      hint: "↵ opens the sampling panel"
    },
    scalarRow("context-window", "context", overlay, "what the meter sizes"),
    {
      id: "effort", section: "generation", label: "effort",
      value: effortRowValue(overlay),
      dots: effortPositionDots(overlay),
      hint: effortRowHint(overlay)
    },
    {
      id: "cache-policy", section: "generation", label: "cache",
      value: `‹ ${cache.policy} ›`,
      dots: positionDots(PROMPT_CACHE_POLICY_V2_VALUES, overlay.draft.cachePolicy),
      hint: cache.kind === "available" ? cache.detail : `unavailable · ${cache.reason}`
    },
    {
      id: "continuation-prompt", section: "generation", label: "prompt layout",
      value: continuationPromptRowValue(overlay),
      hint: continuationPromptRowHint(overlay)
    },
    {
      id: "token-probabilities", section: "generation", label: "alt count",
      value: tokenProbabilitiesRowValue(tokenProbabilities),
      hint: tokenProbabilitiesRowHint(tokenProbabilities)
    },
    {
      id: "reasoning", section: "story", label: "Reasoning",
      value: reasoningRowValue(reasoning),
      dots: positionDots(reasoningRowChoices(overlay), reasoning.display),
      hint: reasoningRowHint(reasoning)
    },
    {
      // "Keep thought", not "Keep thoughts": the 12-column label budget
      // (settings-form.ts LABEL_WIDTH) truncates the plural to "Keep
      // though…", so the singular is what actually paints without an
      // ellipsis eating the word.
      id: "keep-thoughts", section: "story", label: "Keep thought",
      value: `[ ${keepThoughts(overlay) ? "on" : "off"} ]`,
      hint: "saved with the take · ! reads them later"
    },
    routeRow("default-route", "default", overlay, "default"),
    routeRow("prose-route", "prose", overlay, "prose"),
    routeRow("utility-route", "utility", overlay, "utility"),
    {
      id: "system-prompt", section: "prompt", label: "system",
      value: settings.systemPrompt.replace(/\s+/g, " "),
      hint: "↵ opens it in the editor"
    }
  ];
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
      ? "used when no route claims the request"
      : `profile for ${purpose} requests`
  };
}

function isPlainHttp(value: string): boolean {
  try {
    return new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

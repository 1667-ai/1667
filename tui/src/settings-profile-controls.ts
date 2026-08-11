import {
  GENERATION_EFFORT_V2_VALUES,
  PROMPT_CACHE_POLICY_V2_VALUES,
  TEXT_PROMPT_FORMAT_V2_VALUES,
  type GenerationProfileV2,
  type SettingsPresetV2,
  type SettingsRoutePurpose,
  type TextPromptFormatV2,
  type SettingsView
} from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import { generationEffortChoicesForRoute } from "../../shared/generation-effort-capabilities.js";
import type { GenerationSettings } from "../../shared/types.js";
import { THEME_NAMES, type UserConfig } from "./config.js";
import type { KeyAction } from "./keys.js";
import {
  scalarChipText,
  scalarInvalidReason,
  settingsScalar,
  steppedScalarValue,
  type ScalarMagnitude,
  type SettingsScalar,
  type SettingsScalarRow
} from "./settings-scalar.js";

export type { ScalarMagnitude };
import {
  localProviderPresetsSupported,
  selectableSettingsProviderChoices,
  settingsProviderChoice
} from "./settings-provider-choices.js";
import { settingsModelChoices } from "./settings-model-discovery.js";
import {
  applySettingsManualContextDraft,
  replaceSettingsDraft
} from "./settings-draft-transition.js";
import { promptCacheSummaryParts } from "./settings-cache-summary.js";
import { samplingRowValue } from "./sampling-model.js";
import { cycleProfileField, markControlMutation } from "./settings-profile-cycle.js";
import {
  tokenProbabilitiesRowHint,
  tokenProbabilitiesRowState,
  tokenProbabilitiesRowValue
} from "./settings-token-probabilities-row.js";
import {
  reasoningRowChoices,
  reasoningRowHint,
  reasoningRowState,
  reasoningRowValue
} from "./settings-reasoning-row.js";
import {
  imageInputRowHint,
  imageInputRowState,
  imageInputRowValue
} from "./settings-image-input-row.js";
import {
  cycleSettingsProfile as cycleProfile,
  cycleSettingsRoute as cycleRoute,
  profileRouteState,
  settingsProfileIds
} from "./settings-profile-draft.js";
import { storedApiKeyPresentation } from "./settings-secret-sidecar.js";
import { connectionTimeoutRows } from "./settings-connection-timeouts.js";
import {
  settingsTextDraftForDocument,
  settingsTextDraftWithCachePolicy,
  settingsTextDraftWithGeneration
} from "./settings-text.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";

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

/** All profile-aware row presentation stays together. The overlay model owns
 * text editing and reconciliation; this module owns closed profile controls. */
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

/** C-08 stepping, applied to the draft. Only a row with a sentinel can reach
 *  `null`, and `steppedScalarValue` guarantees that, so max tokens — which has
 *  no sentinel — never needs a fallback here. */
export function stepSettingsScalar(
  overlay: SettingsOverlayState,
  row: SettingsScalarRow,
  step: -1 | 1,
  magnitude: ScalarMagnitude
): void {
  const scalar = settingsScalar(row, overlay.draft.generation);
  const next = steppedScalarValue(scalar, step, magnitude);
  if (next === scalar.value) return;
  const generation = { ...overlay.draft.generation };
  if (row === "temperature") generation.temperature = next;
  else if (row === "context-window") generation.contextWindow = next;
  else if (next === null) throw new Error("max tokens has no sentinel to step to");
  else generation.maxTokens = next;
  if (row === "context-window" && next !== null) {
    applySettingsManualContextDraft(overlay, generation);
  } else {
    replaceSettingsDraft(
      overlay,
      settingsTextDraftWithGeneration(overlay.draft, generation)
    );
  }
  markControlMutation(overlay);
}

/** C-09 position dots. A cycler over more than eight options is a C-15 option
 *  column instead, and draws no dots. */
function positionDots<T>(choices: readonly T[], current: T | undefined): string {
  const index = current === undefined ? -1 : choices.indexOf(current);
  if (choices.length <= 1 || choices.length > 8 || index < 0) return "";
  return choices.map((_, at) => at === index ? "●" : "○").join("");
}


export function cycleProfileControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  const document = overlay.draft.document;
  const selected = overlay.draft.selectedProfileId;
  if (document === null || selected === null) return null;
  const profileId = cycleProfile(document, selected, step);
  replaceSettingsDraft(overlay, settingsTextDraftForDocument(document, profileId));
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
  replaceSettingsDraft(overlay, settingsTextDraftForDocument(next, selected));
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
  return cycleProfileField(
    overlay,
    step,
    generationEffortChoices(document, profileId),
    (profile) => profile.effort,
    (profile, effort) => ({ ...profile, effort })
  ) ?? null;
}

export function cycleCachePolicyControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  const index = PROMPT_CACHE_POLICY_V2_VALUES.indexOf(overlay.draft.cachePolicy);
  const policy = PROMPT_CACHE_POLICY_V2_VALUES[
    (index + step + PROMPT_CACHE_POLICY_V2_VALUES.length) % PROMPT_CACHE_POLICY_V2_VALUES.length
  ]!;
  replaceSettingsDraft(
    overlay,
    settingsTextDraftWithCachePolicy(overlay.draft, policy)
  );
  markControlMutation(overlay);
  return policy;
}

/** C-11 toggle: on writes a profile with `discardReasoning` dropped (kept is
 *  the default), off writes it present as `true`. Unlike the Reasoning
 *  cycler above, keeping thoughts has no capability gate — a route that
 *  never returns reasoning simply keeps nothing, the same as any other take
 *  with no thought to store. */
const KEEP_THOUGHTS_CHOICES: readonly boolean[] = [true, false];

export function cycleKeepThoughtsControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  const next = cycleProfileField(
    overlay,
    step,
    KEEP_THOUGHTS_CHOICES,
    (profile) => profile.discardReasoning !== true,
    profileWithKeepThoughts
  );
  return next === undefined ? null : next ? "on" : "off";
}

function profileWithKeepThoughts(
  profile: GenerationProfileV2,
  keep: boolean
): GenerationProfileV2 {
  if (keep) {
    const { discardReasoning: _dropped, ...rest } = profile;
    return rest;
  }
  return { ...profile, discardReasoning: true };
}

function keepThoughts(overlay: SettingsOverlayState): boolean {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return true;
  return document.profiles[profileId]?.discardReasoning !== true;
}

/** Whether this route's connection splits a `<think>` block out of the token
 *  stream. A chat route carries reasoning in its own field, so only a text
 *  connection ever stores this. */
function splitThinkTags(overlay: SettingsOverlayState): boolean {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return false;
  return resolveSettingsProfile(document, profileId).connection.splitThinkTags === true;
}

/** Toggle the split for the routed connection. Returns the new state, or null
 *  when no text connection owns the row. */
export function cycleSplitThinkTags(overlay: SettingsOverlayState): boolean | null {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (
    document === null
    || profileId === null
    || overlay.draft.generation.provider !== "text-completion"
  ) return null;
  const route = resolveSettingsProfile(document, profileId);
  const enabled = route.connection.splitThinkTags !== true;
  // Absence is the off state, the same shape `allowInsecureHttp` persists.
  const { splitThinkTags: _dropped, ...rest } = route.connection;
  replaceSettingsDraft(
    overlay,
    settingsTextDraftForDocument({
      ...document,
      connections: {
        ...document.connections,
        [route.model.connectionId]: enabled
          ? { ...rest, splitThinkTags: true as const }
          : rest
      }
    }, profileId)
  );
  markControlMutation(overlay);
  return enabled;
}

export function cycleTextPromptFormatControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): TextPromptFormatV2 | null {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (
    document === null
    || profileId === null
    || overlay.draft.generation.provider !== "text-completion"
  ) return null;
  const route = resolveSettingsProfile(document, profileId);
  const choices = textPromptFormatChoices(overlay);
  const current = route.connection.textPromptFormat ?? "raw";
  const index = Math.max(0, choices.indexOf(current));
  const format = choices[(index + step + choices.length) % choices.length]!;
  replaceSettingsDraft(
    overlay,
    settingsTextDraftForDocument({
      ...document,
      connections: {
        ...document.connections,
        [route.model.connectionId]: {
          ...route.connection,
          textPromptFormat: format
        }
      }
    }, profileId)
  );
  markControlMutation(overlay);
  return format;
}

function textPromptFormat(overlay: SettingsOverlayState): TextPromptFormatV2 {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "raw";
  return resolveSettingsProfile(document, profileId).connection.textPromptFormat ?? "raw";
}

function textPromptFormatChoices(
  overlay: SettingsOverlayState
): readonly TextPromptFormatV2[] {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return ["raw", "chatml"];
  const preset = resolveSettingsProfile(document, profileId).connection.preset;
  return preset === "llama-cpp"
    ? TEXT_PROMPT_FORMAT_V2_VALUES
    : TEXT_PROMPT_FORMAT_V2_VALUES.filter((format) => format !== "server-template");
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
  return `‹ ${document.profiles[profileId]?.effort ?? "default"} ›`;
}

function effortRowHint(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "how hard it thinks first";
  const effort = document.profiles[profileId]?.effort ?? "default";
  return generationEffortChoices(document, profileId).includes(effort)
    ? "how hard it thinks first"
    : "not on this model";
}

function effortPositionDots(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "";
  return positionDots(
    generationEffortChoices(document, profileId),
    document.profiles[profileId]?.effort ?? "default"
  );
}

function providerPositionDots(
  settings: GenerationSettings,
  textPreset: SettingsPresetV2 | undefined
): string {
  const choices = selectableSettingsProviderChoices();
  const current = settingsProviderChoice(settings, textPreset);
  return positionDots(choices.map((choice) => choice.id), current.id);
}

function profilePositionDots(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "";
  return positionDots(settingsProfileIds(document), profileId);
}

function profileRowHint(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "legacy settings are read-only";
  return profileRouteState(document, profileId) === "unrouted"
    ? "no route sends requests here"
    : "n new · ⇧n duplicate · i import · d delete";
}

/** The chosen model's own identifier, kept out of the chip so the chip holds
 *  one name. C-15 owns the list itself once there are more than eight. */
function modelRowHint(overlay: SettingsOverlayState): string {
  const model = overlay.draft.generation.model;
  const choices = settingsModelChoices(overlay);
  if (choices.length === 0) return "↵ types a model identifier";
  const selected = choices.find((choice) => choice.remoteId === model);
  if (selected === undefined) {
    // The hint carries the identifier the chip had to truncate. A discovered
    // model adds its position in the list; one the provider never listed has
    // no position, and the absence is what says so.
    return model.length === 0
      ? "↵ types a model identifier"
      : settingsModelDisplayText(model);
  }
  const count = `${choices.indexOf(selected) + 1} of ${choices.length}`;
  return selected.name === selected.remoteId
    ? count
    : `${settingsModelDisplayText(selected.remoteId)} · ${count}`;
}

/** Delegate exact route effort choices to the shared request-policy owner. */
function generationEffortChoices(
  document: NonNullable<SettingsOverlayState["draft"]["document"]>,
  profileId: string
): readonly (typeof GENERATION_EFFORT_V2_VALUES)[number][] {
  const profile = document.profiles[profileId];
  if (profile === undefined) return ["default"];
  return generationEffortChoicesForRoute(resolveSettingsProfile(document, profileId));
}

function profileRowValue(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "‹ legacy profile ›";
  const profile = document.profiles[profileId];
  if (profile === undefined) return "‹ unavailable ›";
  return `‹ ${profile.name} ›`;
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
    ? model.length === 0 ? "choose model" : settingsModelDisplayText(model)
    : settingsModelDisplayText(selected.name);
  return `‹ ${label} ›`;
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

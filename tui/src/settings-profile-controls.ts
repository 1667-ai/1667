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
import {
  CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES,
  type ContinuationPromptOptimizationV2
} from "../../shared/continuation-prompt-optimization.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import { generationEffortChoicesForRoute } from "../../shared/generation-effort-capabilities.js";
import { withSupportedReasoningDisplays } from "../../shared/reasoning-display-capabilities.js";
import type { GenerationSettings } from "../../shared/types.js";
import {
  settingsScalar,
  steppedScalarValue,
  type ScalarMagnitude,
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
import { cycleProfileField, markControlMutation } from "./settings-profile-cycle.js";
import {
  cycleSettingsProfile as cycleProfile,
  cycleSettingsRoute as cycleRoute,
  profileRouteState,
  settingsProfileIds
} from "./settings-profile-draft.js";
import {
  settingsTextDraftForDocument,
  settingsTextDraftWithCachePolicy,
  settingsTextDraftWithGeneration
} from "./settings-text.js";
import type { SettingsOverlayState } from "./state.js";

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
export function positionDots<T>(choices: readonly T[], current: T | undefined): string {
  const index = current === undefined ? -1 : choices.indexOf(current);
  if (choices.length <= 1 || choices.length > 8 || index < 0) return "";
  return choices.map((_, at) => at === index ? "●" : "○").join("");
}

const CONTINUATION_PROMPT_CHOICES: readonly (ContinuationPromptOptimizationV2 | null)[] = [
  null,
  ...CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES
];

export function continuationPromptRowValue(overlay: SettingsOverlayState): string {
  return `[ ${continuationPromptOptimization(overlay) === null ? "off" : "on"} ]`;
}

export function continuationPromptRowHint(overlay: SettingsOverlayState): string {
  return continuationPromptOptimization(overlay) === null
    ? "Uses the established Continue and Retake layout; the alternative is experimental."
    : "The experimental layout moves task instructions after story context to improve prompt caching.";
}

/** Toggle the one persisted experiment. Off removes the optional key. */
export function cycleContinuationPromptControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  const next = cycleProfileField(
    overlay,
    step,
    CONTINUATION_PROMPT_CHOICES,
    (profile) => profile.continuationPromptOptimization ?? null,
    profileWithContinuationPromptOptimization
  );
  return next === undefined ? null : next === null ? "off" : "on";
}

function continuationPromptOptimization(
  overlay: SettingsOverlayState
): ContinuationPromptOptimizationV2 | null {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  return document === null || profileId === null
    ? null
    : document.profiles[profileId]?.continuationPromptOptimization ?? null;
}

function profileWithContinuationPromptOptimization(
  profile: GenerationProfileV2,
  optimization: ContinuationPromptOptimizationV2 | null
): GenerationProfileV2 {
  if (optimization === null) {
    const { continuationPromptOptimization: _dropped, ...rest } = profile;
    return rest;
  }
  return { ...profile, continuationPromptOptimization: optimization };
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

export function keepThoughts(overlay: SettingsOverlayState): boolean {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return true;
  return document.profiles[profileId]?.discardReasoning !== true;
}

/** Whether this route's connection splits a `<think>` block out of the token
 *  stream. A chat route carries reasoning in its own field, so only a text
 *  connection ever stores this. */
export function splitThinkTags(overlay: SettingsOverlayState): boolean {
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
  // Turning the split off lowers what this route can return, so a display the
  // writer picked while it was on has to come off with it. Leaving it would
  // write a document the save then refuses, with no row on screen to fix it.
  replaceSettingsDraft(
    overlay,
    settingsTextDraftForDocument(withSupportedReasoningDisplays({
      ...document,
      connections: {
        ...document.connections,
        [route.model.connectionId]: enabled
          ? { ...rest, splitThinkTags: true as const }
          : rest
      }
    }), profileId)
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

export function textPromptFormat(overlay: SettingsOverlayState): TextPromptFormatV2 {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "raw";
  return resolveSettingsProfile(document, profileId).connection.textPromptFormat ?? "raw";
}

export function textPromptFormatChoices(
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

export function effortRowValue(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "‹ default ›";
  return `‹ ${document.profiles[profileId]?.effort ?? "default"} ›`;
}

export function effortRowHint(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) {
    return "Sets how much reasoning the model does before writing.";
  }
  const effort = document.profiles[profileId]?.effort ?? "default";
  return generationEffortChoices(document, profileId).includes(effort)
    ? "Sets how much reasoning the model does before writing."
    : "This model does not support reasoning effort.";
}

export function effortPositionDots(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "";
  return positionDots(
    generationEffortChoices(document, profileId),
    document.profiles[profileId]?.effort ?? "default"
  );
}

export function providerPositionDots(
  settings: GenerationSettings,
  textPreset: SettingsPresetV2 | undefined
): string {
  const choices = selectableSettingsProviderChoices();
  const current = settingsProviderChoice(settings, textPreset);
  return positionDots(choices.map((choice) => choice.id), current.id);
}

export function profilePositionDots(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "";
  return positionDots(settingsProfileIds(document), profileId);
}

export function profileRowHint(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "Legacy settings are read-only.";
  return profileRouteState(document, profileId) === "unrouted"
    ? "No requests currently use this profile."
    : "Groups a model with its generation settings.";
}

/** The chosen model's own identifier, kept out of the chip so the chip holds
 *  one name. C-15 owns long lists and subscription catalogs. */
export function modelRowHint(overlay: SettingsOverlayState): string {
  const model = overlay.draft.generation.model;
  const choices = settingsModelChoices(overlay);
  if (choices.length === 0) return "Enter the model name used by this profile.";
  const selected = choices.find((choice) => choice.remoteId === model);
  if (selected === undefined) {
    // The hint carries the identifier the chip had to truncate. A discovered
    // model adds its position in the list; one the provider never listed has
    // no position, and the absence is what says so.
    return model.length === 0
      ? "Enter the model name used by this profile."
      : settingsModelDisplayText(model);
  }
  const count = `${choices.indexOf(selected) + 1} of ${choices.length}`;
  return selected.name === selected.remoteId
    ? count
    : `${settingsModelDisplayText(selected.remoteId)} · ${count}`;
}

/** Delegate exact route effort choices to the shared request-policy owner. */
export function generationEffortChoices(
  document: NonNullable<SettingsOverlayState["draft"]["document"]>,
  profileId: string
): readonly (typeof GENERATION_EFFORT_V2_VALUES)[number][] {
  const profile = document.profiles[profileId];
  if (profile === undefined) return ["default"];
  return generationEffortChoicesForRoute(resolveSettingsProfile(document, profileId));
}

export function profileRowValue(overlay: SettingsOverlayState): string {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return "‹ legacy profile ›";
  const profile = document.profiles[profileId];
  if (profile === undefined) return "‹ unavailable ›";
  return `‹ ${profile.name} ›`;
}

export function routeRowValue(overlay: SettingsOverlayState, purpose: SettingsRoutePurpose): string {
  const document = overlay.draft.document;
  if (document === null) return "‹ unavailable ›";
  const profileId = purpose === "default"
    ? document.routing.default
    : document.routing[purpose];
  return profileId === undefined
    ? "‹ same as default ›"
    : `‹ ${document.profiles[profileId]?.name ?? "unavailable"} ›`;
}

export function modelRowValue(overlay: SettingsOverlayState): string {
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

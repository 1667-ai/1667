import {
  GENERATION_EFFORT_V2_VALUES,
  REASONING_DISPLAY_V2_VALUES,
  TEXT_PROMPT_FORMAT_V2_VALUES,
  type ConnectionTimeoutsV2,
  type ReasoningDisplayV2,
  type SettingsRoutePurpose,
  type SettingsView,
  type TextPromptFormatV2
} from "./settings-v2-types.js";
import type {
  GenerationProfileV5 as GenerationProfileV2,
  SettingsDocumentV5 as SettingsDocumentV2
} from "./settings-v5-types.js";
import { resolveSettingsProfile, type SelectedSettingsRouteV2 } from "./settings-route.js";
import { generationEffortChoicesForRoute } from "./generation-effort-capabilities.js";
import {
  reasoningDisplayAvailabilityForRoute,
  reasoningDisplayChoicesForRoute,
  withSupportedReasoningDisplays
} from "./reasoning-display-capabilities.js";
import { resolveImageInputCapability } from "./image-input-capabilities.js";
import { samplingContextForRoute, type SamplingContext } from "./sampling-capabilities.js";
import { MAX_ALTERNATIVE_TOKENS } from "./token-probabilities.js";
import {
  resolveTokenProbabilities,
  type TokenProbabilityResolution
} from "./token-probability-capabilities.js";
import { defaultConnectionTimeouts } from "./settings-provider-defaults.js";
import { MAX_SETTINGS_TIMEOUT_MS, MIN_SETTINGS_TIMEOUT_MS } from "./settings-validation-scalars.js";
import { scalarChipText, scalarInvalidReason, typedScalarValue, type SettingsScalar } from "./settings-scalar.js";
import { settingsReadOnlyMessage } from "./settings-read-only.js";
import { settingsTextDraftForDocument, type SettingsTextDraft } from "./settings-text-draft.js";
import {
  CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES,
  type ContinuationPromptOptimizationV2
} from "./continuation-prompt-optimization.js";

/** The reading and writing of the selected profile's own fields, as the
 * Settings surfaces need them: the terminal and the web both go through here,
 * so a hint, a choice list, and a write rule exist once. Every function takes
 * the draft (and the view, where the read-only reason matters). */

function selection(draft: SettingsTextDraft): { document: SettingsDocumentV2; profileId: string } | null {
  return draft.document === null || draft.selectedProfileId === null
    ? null
    : { document: draft.document, profileId: draft.selectedProfileId };
}

function selectedRoute(draft: SettingsTextDraft): SelectedSettingsRouteV2 | null {
  const chosen = selection(draft);
  if (chosen === null || chosen.document.profiles[chosen.profileId] === undefined) return null;
  return resolveSettingsProfile(chosen.document, chosen.profileId) as never;
}

/** The draft with the selected profile rewritten, or `null` when there is no
 * profile to write. */
export function draftWithProfile(
  draft: SettingsTextDraft,
  write: (profile: GenerationProfileV2) => GenerationProfileV2
): SettingsTextDraft | null {
  const chosen = selection(draft);
  const profile = chosen === null ? undefined : chosen.document.profiles[chosen.profileId];
  if (chosen === null || profile === undefined) return null;
  return settingsTextDraftForDocument({
    ...chosen.document,
    profiles: { ...chosen.document.profiles, [chosen.profileId]: write(profile) }
  }, chosen.profileId);
}

// --- prompt layout ---------------------------------------------------------

export const CONTINUATION_PROMPT_CHOICES: readonly (ContinuationPromptOptimizationV2 | null)[] = [
  null,
  ...CONTINUATION_PROMPT_OPTIMIZATION_V2_VALUES
];

export function continuationPromptOptimization(draft: SettingsTextDraft): ContinuationPromptOptimizationV2 | null {
  const chosen = selection(draft);
  return chosen === null ? null : chosen.document.profiles[chosen.profileId]?.continuationPromptOptimization ?? null;
}

/** "on" and "off" for the experimental layout; a newer schema shows what it
 * reports. */
export function continuationPromptValueText(view: SettingsView, draft: SettingsTextDraft): string {
  if (view.readOnlyReason === "successor-schema") {
    const layout = view.effectiveProseContinuationPromptLayout;
    return layout === undefined ? "successor-owned" : layout === "compatibility" ? "off" : "on";
  }
  return continuationPromptOptimization(draft) === null ? "off" : "on";
}

export function continuationPromptHint(view: SettingsView, draft: SettingsTextDraft): string {
  if (view.readOnlyReason === "successor-schema") return settingsReadOnlyMessage(view.readOnlyReason);
  return continuationPromptOptimization(draft) === null
    ? "Uses the established Continue and Retake layout; the alternative is experimental."
    : "The experimental layout moves task instructions after story context to improve prompt caching.";
}

/** Off removes the optional key. */
export function profileWithContinuationPromptOptimization(
  profile: GenerationProfileV2,
  optimization: ContinuationPromptOptimizationV2 | null
): GenerationProfileV2 {
  if (optimization === null) {
    const { continuationPromptOptimization: _dropped, ...rest } = profile;
    return rest;
  }
  return { ...profile, continuationPromptOptimization: optimization };
}

// --- thoughts --------------------------------------------------------------

export function keepThoughts(draft: SettingsTextDraft): boolean {
  const chosen = selection(draft);
  return chosen === null || chosen.document.profiles[chosen.profileId]?.discardReasoning !== true;
}

/** Keeping thoughts is the default and absent; off writes `true`. */
export function profileWithKeepThoughts(profile: GenerationProfileV2, keep: boolean): GenerationProfileV2 {
  if (keep) {
    const { discardReasoning: _dropped, ...rest } = profile;
    return rest;
  }
  return { ...profile, discardReasoning: true };
}

export interface ReasoningRowState {
  readonly route: SelectedSettingsRouteV2 | null;
  readonly display: ReasoningDisplayV2;
}

export function reasoningRowState(draft: SettingsTextDraft): ReasoningRowState {
  const chosen = selection(draft);
  const profile = chosen === null ? undefined : chosen.document.profiles[chosen.profileId];
  return { route: selectedRoute(draft), display: profile?.reasoning ?? "marker" };
}

export function reasoningRowChoices(draft: SettingsTextDraft): readonly ReasoningDisplayV2[] {
  const state = reasoningRowState(draft);
  return state.route === null ? REASONING_DISPLAY_V2_VALUES : reasoningDisplayChoicesForRoute(state.route);
}

/** Whether the selected route can change the reasoning display. A missing
 * route or an unsupported display is a status, not a choice. */
export function reasoningRowHasArrows(draft: SettingsTextDraft): boolean {
  const state = reasoningRowState(draft);
  return state.route !== null
    && reasoningDisplayChoicesForRoute(state.route).length > 1
    && reasoningDisplayAvailabilityForRoute(state.route, state.display).kind === "available";
}

export function reasoningRowHint(state: ReasoningRowState): string {
  if (state.route === null) return "Controls whether model reasoning is hidden, marked, or shown.";
  return reasoningDisplayAvailabilityForRoute(state.route, state.display).kind === "unavailable"
    ? "This route does not expose model reasoning."
    : "Controls whether model reasoning is hidden, marked, or shown.";
}

export function reasoningDisplayUnavailableOrNull(state: ReasoningRowState): boolean {
  return state.route !== null
    && reasoningDisplayAvailabilityForRoute(state.route, state.display).kind === "unavailable";
}

/** `marker` is the default and absent; `open` and `off` write the field. */
export function profileWithReasoning(profile: GenerationProfileV2, reasoning: ReasoningDisplayV2): GenerationProfileV2 {
  if (reasoning === "marker") {
    const { reasoning: _dropped, ...rest } = profile;
    return rest;
  }
  return { ...profile, reasoning };
}

// --- effort ----------------------------------------------------------------

export function generationEffortChoices(
  document: SettingsDocumentV2,
  profileId: string
): readonly (typeof GENERATION_EFFORT_V2_VALUES)[number][] {
  if (document.profiles[profileId] === undefined) return ["default"];
  return generationEffortChoicesForRoute(resolveSettingsProfile(document, profileId) as never);
}

export function effortChoicesForDraft(draft: SettingsTextDraft): readonly (typeof GENERATION_EFFORT_V2_VALUES)[number][] {
  const chosen = selection(draft);
  return chosen === null ? ["default"] : generationEffortChoices(chosen.document, chosen.profileId);
}

export function effortOfDraft(draft: SettingsTextDraft): string {
  const chosen = selection(draft);
  return chosen === null ? "default" : chosen.document.profiles[chosen.profileId]?.generationReasoning.effort ?? "default";
}

export function effortHint(view: SettingsView, draft: SettingsTextDraft): string {
  const chosen = selection(draft);
  if (chosen === null) {
    return view.readOnlyReason === "successor-schema"
      ? settingsReadOnlyMessage(view.readOnlyReason)
      : "Sets how much reasoning the model does before writing.";
  }
  return (effortChoicesForDraft(draft) as readonly string[]).includes(effortOfDraft(draft))
    ? "Sets how much reasoning the model does before writing."
    : "This model does not support reasoning effort.";
}

// --- alternatives ----------------------------------------------------------

/** `off`, then every alternative count a request can ask for. */
export const TOKEN_PROBABILITIES_CHOICES: readonly (number | null)[] = [
  null,
  ...Array.from({ length: MAX_ALTERNATIVE_TOKENS }, (_, index) => index + 1)
];

export function samplingContextForDraft(view: SettingsView, draft: SettingsTextDraft): SamplingContext | null {
  if (!view.editable) {
    return {
      protocol: "legacy-v1",
      preset: "legacy-v1",
      remoteModelId: view.effective.model,
      temperatureSupport: "unknown"
    };
  }
  const route = selectedRoute(draft);
  return route === null ? null : samplingContextForRoute(route);
}

export interface TokenProbabilitiesRowState {
  readonly resolution: TokenProbabilityResolution | null;
  readonly count: number | null;
  readonly readOnlyReason?: SettingsView["readOnlyReason"];
}

export function tokenProbabilitiesRowState(view: SettingsView, draft: SettingsTextDraft): TokenProbabilitiesRowState {
  const context = samplingContextForDraft(view, draft);
  const chosen = selection(draft);
  return {
    resolution: context === null ? null : resolveTokenProbabilities(context),
    count: chosen === null ? null : chosen.document.profiles[chosen.profileId]?.tokenProbabilities ?? null,
    ...(view.readOnlyReason === undefined ? {} : { readOnlyReason: view.readOnlyReason })
  };
}

/** An available route offers every count. An unavailable route offers only a
 * stored count, so the writer can turn it off. */
export function tokenProbabilitiesRowHasArrows(view: SettingsView, draft: SettingsTextDraft): boolean {
  const state = tokenProbabilitiesRowState(view, draft);
  return state.resolution?.kind === "available"
    || state.resolution?.kind === "unavailable" && state.count !== null;
}

export function tokenProbabilitiesChoices(view: SettingsView, draft: SettingsTextDraft): readonly (number | null)[] {
  return tokenProbabilitiesRowState(view, draft).resolution?.kind === "available"
    ? TOKEN_PROBABILITIES_CHOICES
    : [null];
}

export function tokenProbabilitiesRowHint(state: TokenProbabilitiesRowState): string {
  if (state.resolution === null) return "";
  if (state.resolution.kind === "available") return "Shows other tokens the model considered while writing.";
  const storedPrefix = state.count === null
    ? ""
    : `Stored count: ${state.count}. Use Left or Right to turn it off. `;
  if (state.resolution.reason === "legacy-v1") {
    return state.readOnlyReason === "successor-schema"
      ? "Newer settings schema is read-only here; update 1667."
      : "Legacy settings are read-only.";
  }
  if (state.resolution.reason === "preset-unknown") {
    return `${storedPrefix}Alternative token data might not be available from this provider.`;
  }
  return storedPrefix + (state.resolution.reason === "model-refused"
    ? "This model does not offer alternative token data."
    : "This provider does not offer alternative token data.");
}

/** Off removes the field; a count is never 0. */
export function profileWithTokenProbabilities(
  profile: GenerationProfileV2,
  tokenProbabilities: number | null
): GenerationProfileV2 {
  if (tokenProbabilities === null) {
    const { tokenProbabilities: _dropped, ...rest } = profile;
    return rest;
  }
  return { ...profile, tokenProbabilities };
}

// --- image input -----------------------------------------------------------

export interface ImageInputStatus {
  readonly supported: boolean;
  readonly hint: string;
}

/** The read-only status row: what the route and the model already say. */
export function imageInputStatus(draft: SettingsTextDraft): ImageInputStatus {
  const route = selectedRoute(draft);
  if (route === null) {
    return { supported: false, hint: "Shows whether this model accepts image attachments." };
  }
  const resolution = resolveImageInputCapability({
    protocol: route.connection.protocol,
    remoteModelId: route.model.remoteId
  });
  if (resolution.support === "supported") {
    return { supported: true, hint: "This model accepts image attachments." };
  }
  return {
    supported: false,
    hint: resolution.reason === "protocol-unsupported"
      ? "The selected protocol cannot send image attachments."
      : "Image support is unknown for this model."
  };
}

// --- connection fields -----------------------------------------------------

export function splitThinkTags(draft: SettingsTextDraft): boolean {
  const chosen = selection(draft);
  return chosen !== null && resolveSettingsProfile(chosen.document, chosen.profileId).connection.splitThinkTags === true;
}

/** The draft with the split turned on or off, or `null` when no text
 * connection owns it. Turning it off lowers what the route can return, so a
 * reasoning display picked while it was on comes off with it. */
export function draftWithSplitThinkTags(draft: SettingsTextDraft, on: boolean): SettingsTextDraft | null {
  const chosen = selection(draft);
  if (chosen === null || draft.generation.provider !== "text-completion") return null;
  const route = resolveSettingsProfile(chosen.document, chosen.profileId);
  const { splitThinkTags: _dropped, ...rest } = route.connection;
  return settingsTextDraftForDocument(withSupportedReasoningDisplays({
    ...chosen.document,
    connections: {
      ...chosen.document.connections,
      [route.model.connectionId]: on ? { ...rest, splitThinkTags: true as const } : rest
    }
  }), chosen.profileId);
}

export function textPromptFormat(draft: SettingsTextDraft): TextPromptFormatV2 {
  const chosen = selection(draft);
  return chosen === null
    ? "raw"
    : resolveSettingsProfile(chosen.document, chosen.profileId).connection.textPromptFormat ?? "raw";
}

export function textPromptFormatChoices(draft: SettingsTextDraft): readonly TextPromptFormatV2[] {
  const chosen = selection(draft);
  if (chosen === null) return ["raw", "chatml"];
  const preset = resolveSettingsProfile(chosen.document, chosen.profileId).connection.preset;
  return preset === "llama-cpp"
    ? TEXT_PROMPT_FORMAT_V2_VALUES
    : TEXT_PROMPT_FORMAT_V2_VALUES.filter((format) => format !== "server-template");
}

export function draftWithTextPromptFormat(draft: SettingsTextDraft, format: TextPromptFormatV2): SettingsTextDraft | null {
  const chosen = selection(draft);
  if (chosen === null || draft.generation.provider !== "text-completion") return null;
  const route = resolveSettingsProfile(chosen.document, chosen.profileId);
  return settingsTextDraftForDocument({
    ...chosen.document,
    connections: {
      ...chosen.document.connections,
      [route.model.connectionId]: { ...route.connection, textPromptFormat: format }
    }
  }, chosen.profileId);
}

// --- timeouts --------------------------------------------------------------

export type ConnectionTimeoutRow = "timeout-headers" | "timeout-idle" | "timeout-total";

export const CONNECTION_TIMEOUT_ROWS = [
  "timeout-headers",
  "timeout-idle",
  "timeout-total"
] as const satisfies readonly ConnectionTimeoutRow[];

type TimeoutUnit = "seconds" | "minutes";
const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
/** Enough to spell any whole millisecond against a seconds divisor. */
const TIMEOUT_INPUT_DECIMALS = 3;

interface ConnectionTimeoutRowSpec {
  readonly field: keyof ConnectionTimeoutsV2;
  readonly label: string;
  readonly unit: TimeoutUnit;
  readonly unitSuffix: string;
  /** The track a stepper walks. The accepted range below is the real limit. */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly acceptedMax: number;
  readonly acceptedMin: number;
  readonly hint: string;
}

const CONNECTION_TIMEOUT_ROW_SPECS: Record<ConnectionTimeoutRow, ConnectionTimeoutRowSpec> = {
  "timeout-headers": {
    field: "responseHeaderMs",
    label: "headers",
    unit: "seconds",
    unitSuffix: "s",
    min: 1,
    max: 600,
    acceptedMax: MAX_SETTINGS_TIMEOUT_MS / MS_PER_SECOND,
    acceptedMin: MIN_SETTINGS_TIMEOUT_MS / MS_PER_SECOND,
    step: 5,
    hint: "Stops if the model service does not begin responding."
  },
  "timeout-idle": {
    field: "idleMs",
    label: "idle",
    unit: "seconds",
    unitSuffix: "s",
    min: 1,
    max: 600,
    acceptedMax: MAX_SETTINGS_TIMEOUT_MS / MS_PER_SECOND,
    acceptedMin: MIN_SETTINGS_TIMEOUT_MS / MS_PER_SECOND,
    step: 5,
    hint: "Stops if a response pauses for this long."
  },
  "timeout-total": {
    field: "totalMs",
    label: "total",
    unit: "seconds",
    unitSuffix: "s",
    min: 1,
    max: 10_800,
    acceptedMax: MAX_SETTINGS_TIMEOUT_MS / MS_PER_SECOND,
    acceptedMin: MIN_SETTINGS_TIMEOUT_MS / MS_PER_SECOND,
    step: 30,
    hint: "Stops a generation after this total time."
  }
};

export function connectionTimeoutLabel(row: ConnectionTimeoutRow): string {
  return CONNECTION_TIMEOUT_ROW_SPECS[row].label;
}

export function connectionTimeoutHint(row: ConnectionTimeoutRow): string {
  return CONNECTION_TIMEOUT_ROW_SPECS[row].hint;
}

function timeoutDecimals(storedMs: number, divisor: number): number {
  for (let decimals = 0; decimals < 3; decimals += 1) {
    const factor = 10 ** decimals;
    if (Math.round(storedMs / divisor * factor) / factor * divisor === storedMs) return decimals;
  }
  return 3;
}

function unitDivisor(unit: TimeoutUnit): number {
  return unit === "seconds" ? MS_PER_SECOND : MS_PER_MINUTE;
}

/** The row's value off the draft document, in display units. `null` when
 * there is no document to read (the read-only legacy view). */
export function connectionTimeoutScalarForDraft(
  row: ConnectionTimeoutRow,
  draft: SettingsTextDraft
): SettingsScalar | null {
  const chosen = selection(draft);
  if (chosen === null) return null;
  const spec = CONNECTION_TIMEOUT_ROW_SPECS[row];
  const route = resolveSettingsProfile(chosen.document, chosen.profileId);
  const divisor = unitDivisor(spec.unit);
  const defaults = defaultConnectionTimeouts(draft.generation.provider);
  return {
    row,
    value: route.connection.timeouts[spec.field] / divisor,
    min: spec.min,
    max: spec.max,
    acceptedMax: spec.acceptedMax,
    acceptedMin: spec.acceptedMin,
    inputDecimals: TIMEOUT_INPUT_DECIMALS,
    step: spec.step,
    defaultValue: defaults[spec.field] / divisor,
    decimals: timeoutDecimals(route.connection.timeouts[spec.field], divisor),
    sentinel: null,
    sentinelEntry: spec.min
  };
}

/** The chip text: the number in its display unit, with a one-letter suffix. */
export function connectionTimeoutValueText(row: ConnectionTimeoutRow, scalar: SettingsScalar): string {
  return `${scalarChipText(scalar)}${CONNECTION_TIMEOUT_ROW_SPECS[row].unitSuffix}`;
}

export function draftWithConnectionTimeoutValue(
  draft: SettingsTextDraft,
  row: ConnectionTimeoutRow,
  displayValue: number
): SettingsTextDraft {
  const chosen = selection(draft);
  if (chosen === null) return draft;
  const spec = CONNECTION_TIMEOUT_ROW_SPECS[row];
  const route = resolveSettingsProfile(chosen.document, chosen.profileId);
  const milliseconds = Math.round(displayValue * unitDivisor(spec.unit));
  return settingsTextDraftForDocument({
    ...chosen.document,
    connections: {
      ...chosen.document.connections,
      [route.model.connectionId]: {
        ...route.connection,
        timeouts: { ...route.connection.timeouts, [spec.field]: milliseconds }
      }
    }
  }, chosen.profileId);
}

/** A typed timeout: the draft it gives, or the reason it is refused. */
export function draftWithConnectionTimeoutText(
  draft: SettingsTextDraft,
  row: ConnectionTimeoutRow,
  text: string
): { readonly draft: SettingsTextDraft } | { readonly error: string } {
  const scalar = connectionTimeoutScalarForDraft(row, draft);
  if (scalar === null) return { error: "These settings are read-only." };
  const typed = typedScalarValue(scalar, text);
  if ("refused" in typed) return { error: typed.refused };
  const reason = scalarInvalidReason(typed.scalar);
  if (reason !== null) return { error: reason };
  if (typed.scalar.value === null) return { error: "this row needs a number" };
  return { draft: draftWithConnectionTimeoutValue(draft, row, typed.scalar.value) };
}

// --- routing ---------------------------------------------------------------

/** The profile a route points at; `null` for an optional route that follows
 * the default. */
export function routeProfileId(document: SettingsDocumentV2, purpose: SettingsRoutePurpose): string | null {
  return purpose === "default" ? document.routing.default : document.routing[purpose] ?? null;
}

export function routeHint(purpose: SettingsRoutePurpose): string {
  return purpose === "default"
    ? "Used when a task does not have its own profile."
    : purpose === "prose"
      ? "Used to write and rewrite story prose."
      : "Used for summaries and other support tasks.";
}

export function profileHint(view: SettingsView, draft: SettingsTextDraft): string {
  const chosen = selection(draft);
  if (chosen === null) {
    return view.readOnlyReason === "successor-schema"
      ? settingsReadOnlyMessage(view.readOnlyReason)
      : "Legacy settings are read-only.";
  }
  const { document, profileId } = chosen;
  const routed = document.routing.default === profileId || document.routing.prose === profileId
    || document.routing.utility === profileId;
  return routed ? "Groups a model with its generation settings." : "No requests currently use this profile.";
}

import {
  applyBasicSettingsDraft
} from "../../shared/settings-basic-draft.js";
import {
  SAMPLING_KNOB_V2_VALUES,
  type SamplingKnobV2,
  type SamplingSettingsV2
} from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import {
  samplingContextForRoute,
  samplingKnobLabel,
  samplingKnobPresentation,
  type SamplingContext
} from "../../shared/sampling-capabilities.js";
import {
  MAX_SAMPLING_LOGIT_BIAS_ENTRIES,
  MAX_SAMPLING_STOP_SEQUENCES,
  requireSamplingLogitBias,
  requireSamplingNumber,
  requireSamplingStopSequences,
  requireSamplingTopK
} from "../../server/settings-v2-scalars.js";
import type { SettingsOverlayState, SamplingPanelId } from "./state.js";
import { createComposer, type ComposerState } from "./composer-model.js";

export type SamplingScalarKnob = Exclude<SamplingKnobV2, "stop" | "logitBias">;
export const SAMPLING_SCALAR_KNOBS = SAMPLING_KNOB_V2_VALUES.filter(
  (knob): knob is SamplingScalarKnob => knob !== "stop" && knob !== "logitBias"
);

export interface SamplingScalarRow {
  readonly label: string;
  readonly available: boolean;
  readonly reason: string;
  readonly reasonCompact: string;
  readonly knob: SamplingScalarKnob;
  readonly value: string;
}

export interface SamplingListRow {
  readonly panel: "stop" | "logit-bias";
  readonly label: string;
  readonly value: string;
  readonly count: number;
  readonly maximum: number;
  readonly available: boolean;
  readonly reason: string;
  readonly reasonCompact: string;
}

export const SAMPLING_LAYER_ROWS = [
  ...SAMPLING_SCALAR_KNOBS.map((knob) => ({ kind: "scalar" as const, knob })),
  { kind: "list" as const, panel: "stop" as const },
  { kind: "list" as const, panel: "logit-bias" as const }
];

export function samplingContextForOverlay(
  overlay: SettingsOverlayState
): SamplingContext {
  if (!overlay.view.editable) {
    return {
      protocol: "legacy-v1",
      preset: "legacy-v1",
      remoteModelId: overlay.view.effective.model,
      temperatureSupport: "unknown"
    };
  }
  try {
    const profileId = overlay.draft.selectedProfileId;
    if (profileId === null) throw new Error("selected settings profile is unavailable");
    const projected = applyBasicSettingsDraft(
      overlay.view.document,
      overlay.draft.generation,
      profileId
    );
    return samplingContextForRoute(resolveSettingsProfile(projected, profileId));
  } catch {
    // The basic editor may contain an incomplete endpoint while it is being
    // typed. Keep the route's central capability answer visible until save
    // reports the endpoint error.
    const profileId = overlay.draft.selectedProfileId;
    const route = profileId === null
      ? resolveSettingsProfile(overlay.view.document, overlay.view.document.routing.default)
      : resolveSettingsProfile(overlay.view.document, profileId);
    return {
      ...samplingContextForRoute(route),
      remoteModelId: overlay.draft.generation.model
    };
  }
}

export function samplingScalarRows(
  overlay: SettingsOverlayState
): readonly SamplingScalarRow[] {
  const context = samplingContextForOverlay(overlay);
  return SAMPLING_SCALAR_KNOBS.map((knob) => {
    const presentation = samplingKnobPresentation(context, knob);
    const value = overlay.draft.sampling[knob];
    return {
      ...presentation,
      knob,
      value: value === null ? "default" : String(value)
    };
  });
}

export function samplingListRows(
  overlay: SettingsOverlayState
): readonly SamplingListRow[] {
  const sampling = overlay.draft.sampling;
  const context = samplingContextForOverlay(overlay);
  const stopPresentation = samplingKnobPresentation(context, "stop");
  const logitPresentation = samplingKnobPresentation(context, "logitBias");
  return [
    {
      panel: "stop",
      value: sampling.stop.length === 0 ? "empty" : `${sampling.stop.length}/${MAX_SAMPLING_STOP_SEQUENCES}`,
      count: sampling.stop.length,
      maximum: MAX_SAMPLING_STOP_SEQUENCES,
      ...stopPresentation
    },
    {
      panel: "logit-bias",
      value: Object.keys(sampling.logitBias).length === 0
        ? "empty"
        : `${Object.keys(sampling.logitBias).length}/${MAX_SAMPLING_LOGIT_BIAS_ENTRIES}`,
      count: Object.keys(sampling.logitBias).length,
      maximum: MAX_SAMPLING_LOGIT_BIAS_ENTRIES,
      ...logitPresentation
    }
  ];
}

export function samplingLogitBiasEntries(
  overlay: SettingsOverlayState
): Array<[string, number]> {
  const values = overlay.draft.sampling.logitBias;
  const byToken = new Map(Object.entries(values));
  const order = overlay.sampling?.logitBiasOrder ?? Object.keys(values);
  const seen = new Set<string>();
  const entries: Array<[string, number]> = [];
  for (const token of order) {
    const weight = byToken.get(token);
    if (weight === undefined || seen.has(token)) continue;
    seen.add(token);
    entries.push([token, weight]);
  }
  for (const [token, weight] of Object.entries(values)) {
    if (seen.has(token)) continue;
    seen.add(token);
    entries.push([token, weight]);
  }
  return entries;
}

export function samplingSummary(sampling: SamplingSettingsV2): string {
  const fields = SAMPLING_KNOB_V2_VALUES.map((knob) => {
    const value = sampling[knob];
    if (typeof value === "number") return `${samplingKnobLabel(knob)} ${value}`;
    if (Array.isArray(value) && value.length > 0) return `stop ${value.length}`;
    if (value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
      return `bias ${Object.keys(value).length}`;
    }
    return null;
  }).filter((value): value is string => value !== null);
  return fields.length === 0 ? "default" : fields.join(" · ");
}

export function samplingRowValue(overlay: SettingsOverlayState): string {
  const summary = samplingSummary(overlay.draft.sampling);
  if (overlay.view.editable) return summary;
  const reason = samplingScalarRows(overlay)[0]!.reasonCompact;
  return `${summary} · [disabled · ${reason}]`;
}

export function boundedSamplingCursor(
  overlay: SettingsOverlayState,
  panel: SamplingPanelId = overlay.sampling?.panel ?? "sampling",
  cursor = overlay.sampling?.cursor ?? 0
): number {
  const length = panel === "sampling"
    ? SAMPLING_LAYER_ROWS.length
    : panel === "stop"
      ? Math.max(1, overlay.draft.sampling.stop.length)
      : Math.max(1, Object.keys(overlay.draft.sampling.logitBias).length);
  return Math.max(0, Math.min(length - 1, cursor));
}

export function setSamplingScalar(
  overlay: SettingsOverlayState,
  knob: SamplingScalarKnob,
  raw: string
): string | null {
  const text = raw.trim();
  const value = text.length === 0 ? null : Number(text);
  if (value !== null && !Number.isFinite(value)) {
    return `${labelFor(knob)} must be a number or blank`;
  }
  const next = { ...overlay.draft.sampling, [knob]: value } as SamplingSettingsV2;
  const error = validateSampling(next);
  if (error !== null) return error;
  updateSamplingDraft(overlay, next);
  return null;
}

export function setStopSequence(
  overlay: SettingsOverlayState,
  index: number,
  raw: string
): string | null {
  const nextStop = [...overlay.draft.sampling.stop];
  if (index > nextStop.length) return "stop sequence row is no longer available";
  if (index === nextStop.length) nextStop.push(raw);
  else nextStop[index] = raw;
  const next = { ...overlay.draft.sampling, stop: nextStop };
  const error = validateSampling(next);
  if (error !== null) return error;
  updateSamplingDraft(overlay, next);
  return null;
}

export function setLogitBias(
  overlay: SettingsOverlayState,
  index: number,
  raw: string
): string | null {
  const divider = raw.indexOf(":");
  if (divider <= 0) return "use token ID:integer bias";
  const token = raw.slice(0, divider).trim();
  const weightText = raw.slice(divider + 1).trim();
  if (!/^\d+$/u.test(token) || !Number.isSafeInteger(Number(token))) {
    return "token ID must be a non-negative integer";
  }
  if (!/^-?\d+$/u.test(weightText)) return "bias must be an integer";
  const weight = Number(weightText);
  if (!Number.isSafeInteger(weight)) return "bias must be an integer";
  const entries = samplingLogitBiasEntries(overlay);
  if (index < 0 || index > entries.length) return "logit bias row is no longer available";
  const existingToken = index < entries.length ? entries[index]![0] : null;
  if (entries.some(([key]) => key === token && key !== existingToken)) {
    return "token ID already exists";
  }
  if (index === entries.length) entries.push([token, weight]);
  else entries[index] = [token, weight];
  const next = {
    ...overlay.draft.sampling,
    logitBias: Object.fromEntries(entries)
  };
  const error = validateSampling(next);
  if (error !== null) return error;
  updateSamplingDraft(overlay, next);
  if (overlay.sampling !== null) overlay.sampling.logitBiasOrder = entries.map(([key]) => key);
  return null;
}

export function deleteSamplingItem(
  overlay: SettingsOverlayState,
  panel: "stop" | "logit-bias",
  index: number
): boolean {
  const sampling = overlay.draft.sampling;
  if (panel === "stop") {
    if (index < 0 || index >= sampling.stop.length) return false;
    const stop = sampling.stop.filter((_, item) => item !== index);
    updateSamplingDraft(overlay, { ...sampling, stop });
    return true;
  }
  const entries = samplingLogitBiasEntries(overlay);
  if (index < 0 || index >= entries.length) return false;
  entries.splice(index, 1);
  updateSamplingDraft(overlay, { ...sampling, logitBias: Object.fromEntries(entries) });
  if (overlay.sampling !== null) overlay.sampling.logitBiasOrder = entries.map(([key]) => key);
  return true;
}

export function moveStopSequence(
  overlay: SettingsOverlayState,
  step: -1 | 1
): boolean {
  const stop = [...overlay.draft.sampling.stop];
  const index = overlay.sampling?.cursor ?? 0;
  const nextIndex = index + step;
  if (index < 0 || index >= stop.length || nextIndex < 0 || nextIndex >= stop.length) {
    return false;
  }
  [stop[index], stop[nextIndex]] = [stop[nextIndex]!, stop[index]!];
  updateSamplingDraft(overlay, { ...overlay.draft.sampling, stop });
  if (overlay.sampling !== null) overlay.sampling.cursor = nextIndex;
  return true;
}

export function beginSamplingEdit(overlay: SettingsOverlayState): string | null {
  const nested = overlay.sampling;
  if (nested === null) return "sampling is closed";
  if (nested.panel === "sampling") {
    const row = SAMPLING_LAYER_ROWS[boundedSamplingCursor(overlay)]!;
    if (row.kind !== "scalar") return null;
    const scalar = samplingScalarRows(overlay).find((item) => item.knob === row.knob)!;
    if (!scalar.available) return `${scalar.label} disabled · ${scalar.reasonCompact}`;
    const initial = overlay.draft.sampling[row.knob] === null
      ? ""
      : String(overlay.draft.sampling[row.knob]);
    nested.edit = {
      kind: "scalar",
      index: 0,
      knob: row.knob,
      composer: createSamplingComposer(initial),
      initial
    };
    return null;
  }
  const list = samplingListRows(overlay).find((row) => row.panel === nested.panel)!;
  if (!list.available) return `${list.label} disabled · ${list.reasonCompact}`;
  const values = nested.panel === "stop"
    ? overlay.draft.sampling.stop
    : samplingLogitBiasEntries(overlay).map(([token, weight]) => `${token}:${weight}`);
  const index = boundedSamplingCursor(overlay);
  if (index >= values.length) return null;
  const initial = values[index]!;
  nested.edit = {
    kind: nested.panel,
    index,
    composer: createSamplingComposer(initial),
    initial
  };
  return null;
}

export function beginNewSamplingEdit(overlay: SettingsOverlayState): string | null {
  const nested = overlay.sampling;
  if (nested === null || nested.panel === "sampling") return "choose a list first";
  const list = samplingListRows(overlay).find((row) => row.panel === nested.panel)!;
  if (!list.available) return `${list.label} disabled · ${list.reasonCompact}`;
  const count = nested.panel === "stop"
    ? overlay.draft.sampling.stop.length
    : Object.keys(overlay.draft.sampling.logitBias).length;
  const maximum = nested.panel === "stop"
    ? MAX_SAMPLING_STOP_SEQUENCES
    : MAX_SAMPLING_LOGIT_BIAS_ENTRIES;
  if (count >= maximum) return `list limit reached · ${maximum} items maximum`;
  nested.cursor = count;
  nested.edit = {
    kind: nested.panel,
    index: count,
    composer: createSamplingComposer(""),
    initial: ""
  };
  return null;
}

export function createSamplingComposer(initial: string): ComposerState {
  const composer = createComposer(initial);
  if (initial.length > 0) composer.anchor = 0;
  return composer;
}

export function validateSampling(sampling: SamplingSettingsV2): string | null {
  try {
    if (sampling.topP !== null) requireSamplingNumber(sampling.topP, "top p", 0, 1);
    if (sampling.topK !== null) requireSamplingTopK(sampling.topK, "top k");
    if (sampling.minP !== null) requireSamplingNumber(sampling.minP, "min p", 0, 1);
    if (sampling.frequencyPenalty !== null) requireSamplingNumber(sampling.frequencyPenalty, "frequency penalty", -2, 2);
    if (sampling.presencePenalty !== null) requireSamplingNumber(sampling.presencePenalty, "presence penalty", -2, 2);
    if (sampling.repeatPenalty !== null) requireSamplingNumber(sampling.repeatPenalty, "repeat penalty", 1, 10);
    requireSamplingStopSequences(sampling.stop, "stop sequences");
    requireSamplingLogitBias(sampling.logitBias, "logit bias");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function updateSamplingDraft(
  overlay: SettingsOverlayState,
  sampling: SamplingSettingsV2
): void {
  overlay.draft = { ...overlay.draft, sampling };
  if (overlay.conflict !== null) overlay.conflict.armed = false;
  overlay.result = null;
  if (overlay.sampling !== null) overlay.sampling.result = "draft updated · save in Settings";
}

function labelFor(knob: SamplingScalarKnob): string {
  return samplingKnobPresentation(
    {
      protocol: "openai-chat-completions",
      preset: "openai",
      remoteModelId: "",
      temperatureSupport: "supported"
    },
    knob
  ).label;
}

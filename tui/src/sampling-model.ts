import {
  SAMPLING_KNOB_V2_VALUES,
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingScalarKnobV2,
  type SamplingSettingsV2
} from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import {
  samplingContextForRoute,
  samplingKnobLabel,
  samplingKnobPresentation,
  type SamplingContext
} from "../../shared/sampling-capabilities.js";
import type { SamplingListPanelId, SamplingPanelId, SettingsOverlayState } from "./state.js";
import { createComposer, type ComposerState } from "./composer-model.js";
import {
  SAMPLING_LIST_SPECS,
  samplingListItemIdentity,
  samplingListValues,
  type SamplingListRow
} from "./sampling-list-model.js";
import { updateSamplingDraft, validateSampling } from "./sampling-draft.js";

export type SamplingScalarKnob = SamplingScalarKnobV2;
export const SAMPLING_SCALAR_KNOBS = SAMPLING_SCALAR_KNOB_V2_VALUES;

export interface SamplingScalarRow {
  readonly label: string;
  readonly available: boolean;
  readonly reason: string;
  readonly reasonCompact: string;
  readonly knob: SamplingScalarKnob;
  readonly value: string;
  /** A standing hint shown only while the row is available — e.g. `0 disables`.
   *  Blank for every knob that has none. An unavailable reason always wins. */
  readonly hint: string;
}

export interface SamplingScalarPresentation {
  /** Amount `←→` moves the value by, in the knob's own unit. */
  readonly step: number;
  /** Where `←→` lands when nudging off a blank (`null`) field. */
  readonly neutral: number;
  readonly precision: number;
  /** How the numeric value reads when it is not a plain number — e.g.
   *  Mirostat's three states read `off` / `v1` / `v2`. Absent for every knob
   *  whose value is its own display string. */
  readonly format?: (value: number | null) => string;
  /** A standing hint shown only while the row is available. Absent for every
   *  knob whose zero has no documented, non-obvious meaning. */
  readonly hint?: string;
}

/** One entry per scalar knob, covering both its stepper geometry (read by
 *  `sampling-actions.ts`'s `←→` handler) and its presentation (read by
 *  `samplingScalarRows` below). A knob earns a `format` or `hint` entry here
 *  instead of a special case in the renderer, so the two tables this branch
 *  once kept alongside `sampling-actions.ts`'s stepper table cannot drift
 *  from each other or from the table they were merged into. */
export const SAMPLING_SCALAR_PRESENTATION: Readonly<Record<SamplingScalarKnob, SamplingScalarPresentation>> = {
  topP: { step: 0.05, neutral: 1, precision: 2 },
  topK: { step: 1, neutral: 0, precision: 0 },
  minP: { step: 0.01, neutral: 0, precision: 2 },
  frequencyPenalty: { step: 0.1, neutral: 0, precision: 1 },
  presencePenalty: { step: 0.1, neutral: 0, precision: 1 },
  repeatPenalty: { step: 0.05, neutral: 1, precision: 2 },
  dryMultiplier: { step: 0.05, neutral: 0, precision: 2, hint: "0 disables" },
  dryBase: { step: 0.05, neutral: 1.75, precision: 2 },
  dryRange: { step: 64, neutral: 0, precision: 0, hint: "0 disables" },
  xtcThreshold: { step: 0.01, neutral: 0.1, precision: 2 },
  xtcProbability: { step: 0.05, neutral: 0, precision: 2, hint: "0 disables" },
  dynatempRange: { step: 0.05, neutral: 0, precision: 2, hint: "0 disables" },
  // Mirostat is the existing stepper, not new cycler machinery: `neutral: 1`
  // and `step: 1` make `←→` walk off (null) to v1 to v2 and back off through
  // the same crossing/clamping stepSamplingScalar already does for every
  // other scalar.
  mirostat: {
    step: 1,
    neutral: 1,
    precision: 0,
    format: (value) => value === null ? "off" : value === 1 ? "v1" : value === 2 ? "v2" : String(value)
  },
  mirostatTau: { step: 0.1, neutral: 5, precision: 1 },
  mirostatEta: { step: 0.01, neutral: 0.1, precision: 2 }
};

function samplingScalarDisplay(knob: SamplingScalarKnob, value: number | null): string {
  const format = SAMPLING_SCALAR_PRESENTATION[knob].format;
  if (format !== undefined) return format(value);
  return value === null ? "default" : String(value);
}

function samplingScalarHint(knob: SamplingScalarKnob): string {
  return SAMPLING_SCALAR_PRESENTATION[knob].hint ?? "";
}

export type SamplingLayerRowSpec =
  | { readonly kind: "scalar"; readonly knob: SamplingScalarKnob; readonly section?: string }
  | { readonly kind: "list"; readonly panel: SamplingListPanelId; readonly section?: string };

/** The Sampling panel's focus stops, top to bottom. One entry per row —
 *  headings are never a focus stop. `section` marks the first row of a C-04
 *  group and carries the rule text the renderer paints above it; every other
 *  row leaves it unset. New knobs are appended after `stop` and `logit bias`,
 *  per #292 — existing knob order never moves. */
export const SAMPLING_LAYER_ROWS: readonly SamplingLayerRowSpec[] = [
  { kind: "scalar", knob: "topP" },
  { kind: "scalar", knob: "topK" },
  { kind: "scalar", knob: "minP" },
  { kind: "scalar", knob: "frequencyPenalty" },
  { kind: "scalar", knob: "presencePenalty" },
  { kind: "scalar", knob: "repeatPenalty" },
  { kind: "list", panel: "stop" },
  { kind: "list", panel: "logit-bias" },
  { kind: "scalar", knob: "dryMultiplier", section: "dry · don't repeat yourself" },
  { kind: "scalar", knob: "dryBase" },
  { kind: "scalar", knob: "dryRange" },
  { kind: "list", panel: "dry-breakers" },
  { kind: "scalar", knob: "xtcThreshold", section: "xtc · exclude top choices" },
  { kind: "scalar", knob: "xtcProbability" },
  { kind: "scalar", knob: "dynatempRange", section: "temperature shaping" },
  { kind: "scalar", knob: "mirostat" },
  { kind: "scalar", knob: "mirostatTau" },
  { kind: "scalar", knob: "mirostatEta" }
];

export function samplingLayerRowIdentity(
  row: (typeof SAMPLING_LAYER_ROWS)[number]
): string {
  return row.kind === "scalar"
    ? `sampling:scalar:${row.knob}`
    : `sampling:list:${row.panel}`;
}

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
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) {
    throw new Error("editable settings draft is unavailable");
  }
  return samplingContextForRoute(resolveSettingsProfile(document, profileId));
}

export function samplingScalarRows(
  overlay: SettingsOverlayState
): readonly SamplingScalarRow[] {
  const context = samplingContextForOverlay(overlay);
  return SAMPLING_SCALAR_KNOBS.map((knob) => {
    const presentation = samplingKnobPresentation(context, overlay.draft.sampling, knob);
    const value = overlay.draft.sampling[knob];
    return {
      ...presentation,
      knob,
      value: samplingScalarDisplay(knob, value),
      hint: samplingScalarHint(knob)
    };
  });
}

export function samplingListRows(
  overlay: SettingsOverlayState
): readonly SamplingListRow[] {
  const sampling = overlay.draft.sampling;
  const context = samplingContextForOverlay(overlay);
  return Object.values(SAMPLING_LIST_SPECS).map((spec) => {
    const values = spec.values(overlay);
    const presentation = samplingKnobPresentation(context, sampling, spec.knob);
    return {
      panel: spec.panel,
      value: values.length === 0 ? "empty" : `${values.length}/${spec.maximum}`,
      count: values.length,
      maximum: spec.maximum,
      ...presentation
    };
  });
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
    : samplingListItemCount(overlay, panel);
  return Math.max(0, Math.min(length - 1, cursor));
}

function samplingListItemCount(
  overlay: SettingsOverlayState,
  panel: SamplingListPanelId
): number {
  const persisted = samplingListValues(overlay, panel).length;
  const edit = overlay.sampling?.edit;
  const hasPendingRow = edit !== null && edit !== undefined
    && edit.kind === panel
    && edit.index === persisted;
  return Math.max(1, persisted + (hasPendingRow ? 1 : 0));
}

export function setSamplingScalar(
  overlay: SettingsOverlayState,
  knob: SamplingScalarKnob,
  raw: string
): string | null {
  const text = raw.trim();
  const value = text.length === 0 ? null : Number(text);
  if (value !== null && !Number.isFinite(value)) {
    return `${samplingKnobLabel(knob)} must be a number or blank`;
  }
  const next = { ...overlay.draft.sampling, [knob]: value } as SamplingSettingsV2;
  const error = validateSampling(next);
  if (error !== null) return error;
  updateSamplingDraft(overlay, next);
  return null;
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
  const spec = SAMPLING_LIST_SPECS[nested.panel];
  const values = spec.values(overlay).map((value) => spec.editText(value));
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
  const spec = SAMPLING_LIST_SPECS[nested.panel];
  const count = spec.values(overlay).length;
  const maximum = spec.maximum;
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

export function samplingSelectedRowIdentity(
  overlay: SettingsOverlayState
): string | null {
  const nested = overlay.sampling;
  if (nested === null) return null;
  if (nested.panel === "sampling") {
    return samplingLayerRowIdentity(SAMPLING_LAYER_ROWS[boundedSamplingCursor(overlay)]!);
  }
  const values = samplingListValues(overlay, nested.panel);
  const cursor = boundedSamplingCursor(overlay, nested.panel, nested.cursor);
  const value = values[cursor];
  if (value !== undefined) return samplingListItemIdentity(nested.panel, value);
  const edit = nested.edit;
  return edit?.kind === nested.panel && edit.index === cursor
    ? samplingListItemIdentity(nested.panel, undefined, true)
    : null;
}

import {
  SAMPLING_KNOB_V2_VALUES,
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingScalarKnobV2,
  type SamplingSettingsV2
} from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import {
  isLogitBiasFamilyKnob,
  samplingContextForRoute,
  samplingKnobLabel,
  samplingKnobPresentation,
  type SamplingContext
} from "../../shared/sampling-capabilities.js";
import {
  SAMPLING_LIST_PANEL_ORDER,
  samplingListPanelSpec,
  updateSamplingDraft,
  validateSampling
} from "./sampling-panel-spec.js";
import type { SettingsOverlayState, SamplingPanelId, SamplingListPanel } from "./state.js";
import {
  type SamplingLayerRowSpec,
  SAMPLING_LAYER_ROWS,
  SAMPLING_SCALAR_PRESENTATION,
  samplingScalarDisplay,
  samplingScalarHint
} from "../../shared/sampling-row-presentation.js";
export {
  SAMPLING_LAYER_ROWS,
  SAMPLING_SCALAR_PRESENTATION
};
export type { SamplingLayerRowSpec, SamplingScalarPresentation } from "../../shared/sampling-row-presentation.js";
import { createComposer, type ComposerState } from "./composer-model.js";

export type { SamplingListPanel } from "./state.js";

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

export interface SamplingListRow {
  readonly panel: SamplingListPanel;
  readonly label: string;
  readonly value: string;
  readonly count: number;
  readonly maximum: number;
  readonly available: boolean;
  readonly reason: string;
  readonly reasonCompact: string;
}

export interface SamplingListActionability {
  readonly edit: boolean;
  readonly add: boolean;
  readonly delete: boolean;
  readonly reorder: boolean;
}

/** Keep stored list values editable and removable after a provider change,
 * but do not allow new or reordered values while the list is unavailable. */
export function samplingListActionability(
  overlay: SettingsOverlayState,
  panel: SamplingListPanel
): SamplingListActionability {
  const row = samplingListRows(overlay).find((item) => item.panel === panel)!;
  const hasStoredValues = samplingListPanelSpec(panel).values(overlay).length > 0;
  return {
    edit: row.available || hasStoredValues,
    add: row.available,
    delete: row.available || hasStoredValues,
    reorder: row.available && samplingListPanelSpec(panel).reorderable
  };
}

export function samplingLayerRowIdentity(
  row: SamplingLayerRowSpec
): string {
  return row.kind === "scalar"
    ? `sampling:scalar:${row.knob}`
    : `sampling:list:${row.panel}`;
}

export function samplingLayerRowIndex(
  target: SamplingScalarKnob | Exclude<SamplingPanelId, "sampling">
): number {
  return SAMPLING_LAYER_ROWS.findIndex((row) => (row.kind === "scalar"
    ? row.knob === target
    : row.panel === target));
}

/** Null exactly when the view is editable but the draft has no document or
 *  no selected profile — a broken draft, not a route the capability matrix
 *  can speak to. `samplingContextForOverlay` throws on that state because it
 *  was written for the Sampling panel, where the precondition always holds;
 *  a caller that can run while the draft is still settling (issue #291's
 *  token-probabilities row, on every Settings render) reads this instead. */
export function samplingContextForOverlayOrNull(
  overlay: SettingsOverlayState
): SamplingContext | null {
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
  if (document === null || profileId === null) return null;
  return samplingContextForRoute(resolveSettingsProfile(document, profileId) as never);
}

export function samplingContextForOverlay(
  overlay: SettingsOverlayState
): SamplingContext {
  const context = samplingContextForOverlayOrNull(overlay);
  if (context === null) {
    throw new Error("editable settings draft is unavailable");
  }
  return context;
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
  const context = samplingContextForOverlay(overlay);
  const resolvedCount = samplingResolvedEntryCount(overlay);
  return SAMPLING_LIST_PANEL_ORDER.map((panel) => {
    const spec = samplingListPanelSpec(panel);
    const rawCount = spec.values(overlay).length;
    // The logit-bias-family panels (logit-bias, phrase-bias, banned-strings)
    // share one cap on one resolved object (shared/sampling-validation-
    // policy.ts, SAMPLING_RESOLVED_LOGIT_BIAS_POLICY) — a phrase-bias entry
    // list of 51 can resolve to far more than 51 logit_bias entries once
    // every surface variant expands. Displaying the raw list length against
    // that bound let the panel say "51/200" while a save actually failed at
    // 204 (issue #282 review round 2, finding 4). Report the resolved count
    // once it is known; fall back to the raw count only while resolution is
    // idle, pending, or failed, so the header never goes blank.
    const count = isLogitBiasFamilyKnob(spec.knob) && resolvedCount !== null ? resolvedCount : rawCount;
    const maximum = spec.maximum(context);
    return {
      panel,
      value: rawCount === 0 ? "empty" : `${count}/${maximum}`,
      count,
      maximum,
      ...samplingKnobPresentation(context, overlay.draft.sampling, spec.knob)
    };
  });
}

/** The most recently resolved total logit-bias entry count for the current
 * draft (server/sampling-phrase-bias.ts, `resolvedEntryCount`) — the same
 * number `maxResolvedLogitBiasEntries` bounds — or null while there is
 * nothing to report yet (idle, pending, failed, or the tokenizer itself is
 * unavailable). */
function samplingResolvedEntryCount(overlay: SettingsOverlayState): number | null {
  const state = overlay.sampling?.biasResolution;
  if (state === undefined || state.kind !== "ready" || state.result.kind !== "resolved") return null;
  return state.result.resolvedEntryCount;
}

export function samplingListItemIdentity(
  panel: SamplingListPanel,
  key: string | null,
  pending = false
): string | null {
  if (pending) return `sampling:${panel}:pending`;
  if (key === null) return null;
  return `sampling:${panel}:${JSON.stringify(key)}`;
}

export function samplingSelectedRowIdentity(
  overlay: SettingsOverlayState
): string | null {
  const nested = overlay.sampling;
  if (nested === null) return null;
  if (nested.panel === "sampling") {
    return samplingLayerRowIdentity(SAMPLING_LAYER_ROWS[boundedSamplingCursor(overlay)]!);
  }
  const spec = samplingListPanelSpec(nested.panel);
  const values = spec.values(overlay);
  const cursor = boundedSamplingCursor(overlay, nested.panel, nested.cursor);
  const value = values[cursor];
  if (value !== undefined) return samplingListItemIdentity(nested.panel, spec.identityKey(value));
  const edit = nested.edit;
  return edit?.kind === "list" && edit.panel === nested.panel && edit.index === cursor
    ? samplingListItemIdentity(nested.panel, null, true)
    : null;
}

export function samplingSummary(sampling: SamplingSettingsV2): string {
  // Every line names its own knob. The counted lines used to be spelled `stop`
  // and `bias`, which held only while `stop` was the one list and `logitBias`
  // the one record — a second list read as a second `stop`.
  const fields = SAMPLING_KNOB_V2_VALUES.map((knob) => {
    const value = sampling[knob];
    if (typeof value === "number") return `${samplingKnobLabel(knob)} ${value}`;
    if (Array.isArray(value)) {
      return value.length === 0 ? null : `${samplingKnobLabel(knob)} ${value.length}`;
    }
    if (value !== null && Object.keys(value).length > 0) {
      return `${samplingKnobLabel(knob)} ${Object.keys(value).length}`;
    }
    return null;
  }).filter((value): value is string => value !== null);
  return fields.length === 0 ? "default" : fields.join(" · ");
}

export function samplingRowValue(overlay: SettingsOverlayState): string {
  if (overlay.view.readOnlyReason === "successor-schema") return "‹ successor-owned ›";
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
  panel: SamplingListPanel
): number {
  const persisted = samplingListPanelSpec(panel).values(overlay).length;
  const edit = overlay.sampling?.edit;
  const hasPendingRow = edit !== null && edit !== undefined
    && edit.kind === "list" && edit.panel === panel
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
  const spec = samplingListPanelSpec(nested.panel);
  const values = spec.values(overlay);
  if (!samplingListActionability(overlay, nested.panel).edit) {
    return `${list.label} disabled · ${list.reasonCompact}`;
  }
  const index = boundedSamplingCursor(overlay);
  if (index >= values.length) return null;
  const initial = spec.editableText(values[index]!);
  nested.edit = {
    kind: "list",
    panel: nested.panel,
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
  // Gate on the same displayed count samplingListRows reports (issue #282
  // review round 2, finding 4): for the logit-bias-family panels that is the
  // resolved-token bound, not this panel's own raw list length, so the
  // editor stops accepting new entries at the same point a save would
  // reject them, not later.
  if (list.count >= list.maximum) return `list limit reached · ${list.maximum} items maximum`;
  const spec = samplingListPanelSpec(nested.panel);
  const rawCount = spec.values(overlay).length;
  nested.cursor = rawCount;
  nested.edit = {
    kind: "list",
    panel: nested.panel,
    index: rawCount,
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

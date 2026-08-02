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
import { createComposer, type ComposerState } from "./composer-model.js";

export type { SamplingListPanel } from "./state.js";
export { updateSamplingDraft, validateSampling, samplingLogitBiasEntries } from "./sampling-panel-spec.js";

export type SamplingScalarKnob = SamplingScalarKnobV2;
export const SAMPLING_SCALAR_KNOBS = SAMPLING_SCALAR_KNOB_V2_VALUES;

export interface SamplingScalarRow {
  readonly label: string;
  readonly available: boolean;
  readonly reason: string;
  readonly reasonCompact: string;
  readonly knob: SamplingScalarKnob;
  readonly value: string;
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

export const SAMPLING_LAYER_ROWS = [
  ...SAMPLING_SCALAR_KNOBS.map((knob) => ({ kind: "scalar" as const, knob })),
  ...SAMPLING_LIST_PANEL_ORDER.map((panel) => ({ kind: "list" as const, panel }))
];

export function samplingLayerRowIdentity(
  row: (typeof SAMPLING_LAYER_ROWS)[number]
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
      ...samplingKnobPresentation(context, spec.knob)
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
  const fields = SAMPLING_KNOB_V2_VALUES.map((knob) => samplingSummaryField(sampling, knob))
    .filter((value): value is string => value !== null);
  return fields.length === 0 ? "default" : fields.join(" · ");
}

/** Kept as one explicit branch per knob, not a generic "any array/object is
 * non-empty" check: stop, logitBias, phraseBias, and bannedStrings are all
 * array- or object-shaped, and a shape-based check cannot tell them apart. */
function samplingSummaryField(
  sampling: SamplingSettingsV2,
  knob: (typeof SAMPLING_KNOB_V2_VALUES)[number]
): string | null {
  const value = sampling[knob];
  if (typeof value === "number") return `${samplingKnobLabel(knob)} ${value}`;
  if (knob === "stop") return sampling.stop.length > 0 ? `stop ${sampling.stop.length}` : null;
  if (knob === "logitBias") {
    const count = Object.keys(sampling.logitBias).length;
    return count > 0 ? `bias ${count}` : null;
  }
  if (knob === "phraseBias") {
    return sampling.phraseBias.length > 0 ? `phrase bias ${sampling.phraseBias.length}` : null;
  }
  if (knob === "bannedStrings") {
    return sampling.bannedStrings.length > 0 ? `banned ${sampling.bannedStrings.length}` : null;
  }
  return null;
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

export function deleteSamplingItem(
  overlay: SettingsOverlayState,
  panel: SamplingListPanel,
  index: number
): boolean {
  return samplingListPanelSpec(panel).remove(overlay, index);
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
  const spec = samplingListPanelSpec(nested.panel);
  const values = spec.values(overlay);
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

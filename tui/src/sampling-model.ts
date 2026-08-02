import {
  SAMPLING_KNOB_V2_VALUES,
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingPhraseBiasEntryV2,
  type SamplingScalarKnobV2,
  type SamplingSettingsV2
} from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import {
  applySamplingSettings,
  samplingContextForRoute,
  samplingKnobLabel,
  samplingKnobPresentation,
  type SamplingContext
} from "../../shared/sampling-capabilities.js";
import {
  SAMPLING_BANNED_STRINGS_POLICY,
  SAMPLING_LOGIT_BIAS_POLICY,
  SAMPLING_PHRASE_BIAS_POLICY,
  SAMPLING_STOP_POLICY,
  validateSamplingLogitBiasEntry,
  validateSamplingSettings
} from "../../shared/sampling-validation-policy.js";
import type { SettingsOverlayState, SamplingPanelId } from "./state.js";
import { createComposer, type ComposerState } from "./composer-model.js";

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

export type SamplingListPanel = Exclude<SamplingPanelId, "sampling">;

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
  { kind: "list" as const, panel: "stop" as const },
  { kind: "list" as const, panel: "logit-bias" as const },
  { kind: "list" as const, panel: "phrase-bias" as const },
  { kind: "list" as const, panel: "banned-strings" as const }
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
  return [
    listRow("stop", sampling.stop.length, samplingKnobPresentation(context, "stop")),
    listRow(
      "logit-bias",
      Object.keys(sampling.logitBias).length,
      samplingKnobPresentation(context, "logitBias")
    ),
    listRow("phrase-bias", sampling.phraseBias.length, samplingKnobPresentation(context, "phraseBias")),
    listRow("banned-strings", sampling.bannedStrings.length, samplingKnobPresentation(context, "bannedStrings"))
  ];
}

function listRow(
  panel: SamplingListPanel,
  count: number,
  presentation: ReturnType<typeof samplingKnobPresentation>
): SamplingListRow {
  const maximum = samplingListMaximum(panel);
  return {
    panel,
    value: count === 0 ? "empty" : `${count}/${maximum}`,
    count,
    maximum,
    ...presentation
  };
}

function samplingListMaximum(panel: SamplingListPanel): number {
  switch (panel) {
    case "stop": return SAMPLING_STOP_POLICY.maxSequences;
    case "logit-bias": return SAMPLING_LOGIT_BIAS_POLICY.maxEntries;
    case "phrase-bias": return SAMPLING_PHRASE_BIAS_POLICY.maxEntries;
    case "banned-strings": return SAMPLING_BANNED_STRINGS_POLICY.maxEntries;
  }
}

/** The panel's entries in the shape sampling-panel.ts and
 * samplingListItemIdentity need to derive a stable per-row key. */
function samplingListIdentityValues(
  overlay: SettingsOverlayState,
  panel: SamplingListPanel
): readonly (string | readonly [string, number] | SamplingPhraseBiasEntryV2)[] {
  switch (panel) {
    case "stop": return overlay.draft.sampling.stop;
    case "logit-bias": return samplingLogitBiasEntries(overlay);
    case "phrase-bias": return overlay.draft.sampling.phraseBias;
    case "banned-strings": return overlay.draft.sampling.bannedStrings;
  }
}

/** The panel's entries as the single-line text its inline composer edits. */
function samplingListEditableValues(
  overlay: SettingsOverlayState,
  panel: SamplingListPanel
): readonly string[] {
  switch (panel) {
    case "stop": return overlay.draft.sampling.stop;
    case "logit-bias": return samplingLogitBiasEntries(overlay).map(([token, weight]) => `${token}:${weight}`);
    case "phrase-bias": return overlay.draft.sampling.phraseBias.map((entry) => `${entry.phrase}:${entry.weight}`);
    case "banned-strings": return overlay.draft.sampling.bannedStrings;
  }
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

export function samplingListItemIdentity(
  panel: SamplingListPanel,
  value: string | readonly [string, number] | SamplingPhraseBiasEntryV2 | undefined,
  pending = false
): string | null {
  if (pending) return `sampling:${panel}:pending`;
  if (value === undefined) return null;
  const key = typeof value === "string"
    ? value
    : "phrase" in value ? value.phrase : value[0];
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
  const values = samplingListIdentityValues(overlay, nested.panel);
  const cursor = boundedSamplingCursor(overlay, nested.panel, nested.cursor);
  const value = values[cursor];
  if (value !== undefined) return samplingListItemIdentity(nested.panel, value);
  const edit = nested.edit;
  return edit?.kind === nested.panel && edit.index === cursor
    ? samplingListItemIdentity(nested.panel, undefined, true)
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
  const persisted = samplingListEditableValues(overlay, panel).length;
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
  if (!/^-?\d+$/u.test(weightText)) return "bias must be an integer";
  const weight = Number(weightText);
  try {
    validateSamplingLogitBiasEntry(token, weight, "logit bias");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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
  panel: SamplingListPanel,
  index: number
): boolean {
  const sampling = overlay.draft.sampling;
  if (panel === "stop") {
    if (index < 0 || index >= sampling.stop.length) return false;
    const stop = sampling.stop.filter((_, item) => item !== index);
    updateSamplingDraft(overlay, { ...sampling, stop });
    return true;
  }
  if (panel === "phrase-bias") {
    if (index < 0 || index >= sampling.phraseBias.length) return false;
    const phraseBias = sampling.phraseBias.filter((_, item) => item !== index);
    updateSamplingDraft(overlay, { ...sampling, phraseBias });
    return true;
  }
  if (panel === "banned-strings") {
    if (index < 0 || index >= sampling.bannedStrings.length) return false;
    const bannedStrings = sampling.bannedStrings.filter((_, item) => item !== index);
    updateSamplingDraft(overlay, { ...sampling, bannedStrings });
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
  const values = samplingListEditableValues(overlay, nested.panel);
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
  const count = samplingListEditableValues(overlay, nested.panel).length;
  const maximum = samplingListMaximum(nested.panel);
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
    validateSamplingSettings(sampling);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function updateSamplingDraft(
  overlay: SettingsOverlayState,
  sampling: SamplingSettingsV2
): void {
  const document = overlay.draft.document === null || overlay.draft.selectedProfileId === null
    ? overlay.draft.document
    : applySamplingSettings(
        overlay.draft.document,
        sampling,
        overlay.draft.selectedProfileId
      );
  overlay.draft = { ...overlay.draft, document, sampling };
  if (overlay.conflict !== null) overlay.conflict.armed = false;
  overlay.result = null;
  if (overlay.sampling !== null) overlay.sampling.result = "draft updated · save in Settings";
}

import {
  SAMPLING_KNOB_V2_VALUES,
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  type SamplingKnobV2,
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
  SAMPLING_DRY_BREAKERS_POLICY,
  SAMPLING_LOGIT_BIAS_POLICY,
  SAMPLING_STOP_POLICY,
  validateSamplingLogitBiasEntry,
  validateSamplingSettings
} from "../../shared/sampling-validation-policy.js";
import type { SettingsOverlayState, SamplingPanelId } from "./state.js";
import { createComposer, type ComposerState } from "./composer-model.js";

export type SamplingScalarKnob = SamplingScalarKnobV2;
export const SAMPLING_SCALAR_KNOBS = SAMPLING_SCALAR_KNOB_V2_VALUES;
export type SamplingListPanelId = Exclude<SamplingPanelId, "sampling">;
export type SamplingListValue = string | readonly [string, number];

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
  readonly panel: SamplingListPanelId;
  readonly label: string;
  readonly value: string;
  readonly count: number;
  readonly maximum: number;
  readonly available: boolean;
  readonly reason: string;
  readonly reasonCompact: string;
}

/** Mirostat's three states read `off` / `v1` / `v2`, not `default` / `1` / `2`.
 *  A knob earns an entry here instead of a special case in the renderer. */
const SAMPLING_SCALAR_DISPLAY: Partial<Record<SamplingScalarKnob, (value: number | null) => string>> = {
  mirostat: (value) => value === null ? "off" : value === 1 ? "v1" : value === 2 ? "v2" : String(value)
};

function samplingScalarDisplay(knob: SamplingScalarKnob, value: number | null): string {
  const formatter = SAMPLING_SCALAR_DISPLAY[knob];
  if (formatter !== undefined) return formatter(value);
  return value === null ? "default" : String(value);
}

/** The only knobs whose zero has a documented, non-obvious meaning. Every
 *  other scalar's hint column stays blank. */
const SAMPLING_SCALAR_ZERO_HINT_KNOBS: ReadonlySet<SamplingScalarKnob> = new Set([
  "dryMultiplier",
  "dryRange",
  "xtcProbability",
  "dynatempRange"
]);

function samplingScalarHint(knob: SamplingScalarKnob): string {
  return SAMPLING_SCALAR_ZERO_HINT_KNOBS.has(knob) ? "0 disables" : "";
}

/** One descriptor per Sampling list panel — what it holds, its bound, its
 *  copy, and the four operations a list panel supports. `stop` and
 *  `dry-breakers` share a plain-string implementation; only `logit-bias`
 *  needs its own, because it stores a keyed record instead of an ordered list.
 *  `sampling-actions.ts` and `screens/sampling-panel.ts` read this table
 *  instead of branching on the panel id, so a fourth list panel would fall
 *  out of one new entry here rather than a new branch in three files. */
interface SamplingListSpec {
  readonly panel: SamplingListPanelId;
  readonly knob: SamplingKnobV2;
  readonly kind: "string" | "record";
  readonly title: string;
  readonly itemLabel: string;
  readonly maximum: number;
  readonly reorderable: boolean;
  readonly emptyCopy: readonly string[];
  values(overlay: SettingsOverlayState): readonly SamplingListValue[];
  editText(value: SamplingListValue): string;
  set(overlay: SettingsOverlayState, index: number, raw: string): string | null;
  delete(overlay: SettingsOverlayState, index: number): boolean;
  move(overlay: SettingsOverlayState, step: -1 | 1): boolean;
}

function stringListValue(value: SamplingListValue, panel: SamplingListPanelId): string {
  if (typeof value !== "string") throw new Error(`${panel} row has an invalid value`);
  return value;
}

function setStringListEntry(
  overlay: SettingsOverlayState,
  field: "stop" | "dryBreakers",
  index: number,
  raw: string
): string | null {
  const list = [...overlay.draft.sampling[field]];
  if (index > list.length) return `${samplingKnobLabel(field)} row is no longer available`;
  if (index === list.length) list.push(raw);
  else list[index] = raw;
  const next = { ...overlay.draft.sampling, [field]: list };
  const error = validateSampling(next);
  if (error !== null) return error;
  updateSamplingDraft(overlay, next);
  return null;
}

function deleteStringListEntry(
  overlay: SettingsOverlayState,
  field: "stop" | "dryBreakers",
  index: number
): boolean {
  const list = overlay.draft.sampling[field];
  if (index < 0 || index >= list.length) return false;
  const next = list.filter((_, item) => item !== index);
  updateSamplingDraft(overlay, { ...overlay.draft.sampling, [field]: next });
  return true;
}

function moveStringListEntry(
  overlay: SettingsOverlayState,
  field: "stop" | "dryBreakers",
  step: -1 | 1
): boolean {
  const list = [...overlay.draft.sampling[field]];
  const index = overlay.sampling?.cursor ?? 0;
  const nextIndex = index + step;
  if (index < 0 || index >= list.length || nextIndex < 0 || nextIndex >= list.length) {
    return false;
  }
  [list[index], list[nextIndex]] = [list[nextIndex]!, list[index]!];
  updateSamplingDraft(overlay, { ...overlay.draft.sampling, [field]: list });
  if (overlay.sampling !== null) overlay.sampling.cursor = nextIndex;
  return true;
}

function stringListSpec(
  panel: "stop" | "dry-breakers",
  field: "stop" | "dryBreakers",
  title: string,
  itemLabel: string,
  maximum: number,
  emptyCopy: readonly string[]
): SamplingListSpec {
  return {
    panel,
    knob: field,
    kind: "string",
    title,
    itemLabel,
    maximum,
    reorderable: true,
    emptyCopy,
    values: (overlay) => overlay.draft.sampling[field],
    editText: (value) => stringListValue(value, panel),
    set: (overlay, index, raw) => setStringListEntry(overlay, field, index, raw),
    delete: (overlay, index) => deleteStringListEntry(overlay, field, index),
    move: (overlay, step) => moveStringListEntry(overlay, field, step)
  };
}

const SAMPLING_LIST_SPECS: Readonly<Record<SamplingListPanelId, SamplingListSpec>> = {
  stop: stringListSpec("stop", "stop", "stop sequences", "stop sequence", SAMPLING_STOP_POLICY.maxSequences, [
    "  no stop sequences yet.",
    "  n writes one · the model stops when it types one"
  ]),
  "logit-bias": {
    panel: "logit-bias",
    knob: "logitBias",
    kind: "record",
    title: "logit bias",
    itemLabel: "token ID",
    maximum: SAMPLING_LOGIT_BIAS_POLICY.maxEntries,
    reorderable: false,
    emptyCopy: [
      "  no biased tokens yet.",
      "  n writes one · token IDs come from the model's tokenizer."
    ],
    values: (overlay) => samplingLogitBiasEntries(overlay),
    editText: (value) => {
      if (typeof value === "string") throw new Error("logit-bias row has an invalid value");
      return `${value[0]}:${value[1]}`;
    },
    set: (overlay, index, raw) => setLogitBias(overlay, index, raw),
    delete: (overlay, index) => deleteLogitBiasEntry(overlay, index),
    move: () => false
  },
  "dry-breakers": stringListSpec(
    "dry-breakers",
    "dryBreakers",
    "dry breakers",
    "breaker",
    SAMPLING_DRY_BREAKERS_POLICY.maxSequences,
    [
      "  no dry breakers yet.",
      // An empty list is not sent, and the provider then uses its own
      // breakers — so the empty state must not read as "dry has none".
      "  n writes one · until then the provider uses its own list"
    ]
  )
};

const SAMPLING_LIST_PANELS: readonly SamplingListPanelId[] = ["stop", "logit-bias", "dry-breakers"];

export interface SamplingListPanelInfo {
  readonly panel: SamplingListPanelId;
  /** The sampling parameter this panel edits. */
  readonly knob: SamplingKnobV2;
  readonly kind: "string" | "record";
  readonly title: string;
  readonly itemLabel: string;
  readonly maximum: number;
  readonly reorderable: boolean;
  readonly emptyCopy: readonly string[];
}

export function samplingListPanelInfo(panel: SamplingListPanelId): SamplingListPanelInfo {
  const spec = SAMPLING_LIST_SPECS[panel];
  return {
    panel: spec.panel,
    knob: spec.knob,
    kind: spec.kind,
    title: spec.title,
    itemLabel: spec.itemLabel,
    maximum: spec.maximum,
    reorderable: spec.reorderable,
    emptyCopy: spec.emptyCopy
  };
}

export function samplingListValues(
  overlay: SettingsOverlayState,
  panel: SamplingListPanelId
): readonly SamplingListValue[] {
  return SAMPLING_LIST_SPECS[panel].values(overlay);
}

export function setSamplingListItem(
  overlay: SettingsOverlayState,
  panel: SamplingListPanelId,
  index: number,
  raw: string
): string | null {
  return SAMPLING_LIST_SPECS[panel].set(overlay, index, raw);
}

export function moveSamplingListItem(
  overlay: SettingsOverlayState,
  panel: SamplingListPanelId,
  step: -1 | 1
): boolean {
  return SAMPLING_LIST_SPECS[panel].move(overlay, step);
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
  return SAMPLING_LIST_PANELS.map((panel) => {
    const spec = SAMPLING_LIST_SPECS[panel];
    const values = spec.values(overlay);
    const presentation = samplingKnobPresentation(context, sampling, spec.knob);
    return {
      panel,
      value: values.length === 0 ? "empty" : `${values.length}/${spec.maximum}`,
      count: values.length,
      maximum: spec.maximum,
      ...presentation
    };
  });
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
  panel: SamplingListPanelId,
  value: string | readonly [string, number] | undefined,
  pending = false
): string | null {
  if (pending) return `sampling:${panel}:pending`;
  if (value === undefined) return null;
  const key = typeof value === "string" ? value : value[0];
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
  const values = samplingListValues(overlay, nested.panel);
  const cursor = boundedSamplingCursor(overlay, nested.panel, nested.cursor);
  const value = values[cursor];
  if (value !== undefined) return samplingListItemIdentity(nested.panel, value);
  const edit = nested.edit;
  return edit?.kind === nested.panel && edit.index === cursor
    ? samplingListItemIdentity(nested.panel, undefined, true)
    : null;
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

function deleteLogitBiasEntry(overlay: SettingsOverlayState, index: number): boolean {
  const entries = samplingLogitBiasEntries(overlay);
  if (index < 0 || index >= entries.length) return false;
  entries.splice(index, 1);
  updateSamplingDraft(overlay, { ...overlay.draft.sampling, logitBias: Object.fromEntries(entries) });
  if (overlay.sampling !== null) overlay.sampling.logitBiasOrder = entries.map(([key]) => key);
  return true;
}

export function deleteSamplingItem(
  overlay: SettingsOverlayState,
  panel: SamplingListPanelId,
  index: number
): boolean {
  return SAMPLING_LIST_SPECS[panel].delete(overlay, index);
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

export function validateSampling(sampling: SamplingSettingsV2): string | null {
  try {
    validateSamplingSettings(sampling);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function updateSamplingDraft(
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

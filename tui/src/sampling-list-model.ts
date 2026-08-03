import type { SamplingKnobV2 } from "../../shared/settings-v2-types.js";
import { samplingKnobLabel } from "../../shared/sampling-capabilities.js";
import {
  SAMPLING_DRY_BREAKERS_POLICY,
  SAMPLING_LOGIT_BIAS_POLICY,
  SAMPLING_STOP_POLICY,
  validateSamplingLogitBiasEntry
} from "../../shared/sampling-validation-policy.js";
import type { SamplingListPanelId, SettingsOverlayState } from "./state.js";
import { updateSamplingDraft, validateSampling } from "./sampling-draft.js";

export type { SamplingListPanelId };

export type SamplingListValue = string | readonly [string, number];

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
  /** The status bar's name for this panel while it is open, e.g. `STOP`. Kept
   *  distinct from `title` — `stop`'s title is `stop sequences`, and the
   *  status bar has no room for it. */
  readonly statusLabel: string;
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
  statusLabel: string,
  itemLabel: string,
  maximum: number,
  emptyCopy: readonly string[]
): SamplingListSpec {
  return {
    panel,
    knob: field,
    kind: "string",
    title,
    statusLabel,
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

function samplingLogitBiasEntries(
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

function setLogitBias(
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

export const SAMPLING_LIST_SPECS: Readonly<Record<SamplingListPanelId, SamplingListSpec>> = {
  stop: stringListSpec(
    "stop",
    "stop",
    "stop sequences",
    "STOP",
    "stop sequence",
    SAMPLING_STOP_POLICY.maxSequences,
    [
      "  no stop sequences yet.",
      "  n writes one · the model stops when it types one"
    ]
  ),
  "logit-bias": {
    panel: "logit-bias",
    knob: "logitBias",
    kind: "record",
    title: "logit bias",
    statusLabel: "LOGIT BIAS",
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
    "DRY BREAKERS",
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

export type SamplingListPanelInfo =
  Omit<SamplingListSpec, "values" | "editText" | "set" | "delete" | "move">;

export function samplingListPanelInfo(panel: SamplingListPanelId): SamplingListPanelInfo {
  return SAMPLING_LIST_SPECS[panel];
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

export function deleteSamplingItem(
  overlay: SettingsOverlayState,
  panel: SamplingListPanelId,
  index: number
): boolean {
  return SAMPLING_LIST_SPECS[panel].delete(overlay, index);
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

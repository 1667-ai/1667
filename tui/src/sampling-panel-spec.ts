import {
  applySamplingSettings,
  type SamplingContext
} from "../../shared/sampling-capabilities.js";
import {
  maxResolvedLogitBiasEntries,
  SAMPLING_DRY_BREAKERS_POLICY,
  SAMPLING_RESOLVED_LOGIT_BIAS_POLICY,
  SAMPLING_STOP_POLICY,
  validateSamplingLogitBiasEntry,
  validateSamplingSettings
} from "../../shared/sampling-validation-policy.js";
import type {
  SamplingKnobV2,
  SamplingPhraseBiasEntryV2,
  SamplingSettingsV2
} from "../../shared/settings-v2-types.js";
import { replaceSettingsDraft } from "./settings-draft-transition.js";
import type { SamplingListPanel, SettingsOverlayState } from "./state.js";

/**
 * One spec per list panel, replacing four near-identical setters and the
 * dispatch chains that picked among them (issue #282 review, finding G).
 * Each spec owns its value shape through the generic; callers erase to
 * `unknown` once, at `samplingListPanelSpec`, instead of narrowing (or
 * throwing on an unreachable shape) at every call site.
 */
export interface SamplingListPanelSpec<Value> {
  readonly panel: SamplingListPanel;
  /** Which SamplingSettingsV2 knob this panel edits — the capability matrix
   * (shared/sampling-capabilities.ts) reasons about availability per knob,
   * not per panel. */
  readonly knob: SamplingKnobV2;
  /** The status bar's name for this panel while it is open, e.g. `STOP`. */
  readonly statusLabel: string;
  /** Only a plain-string list (stop, dry breakers) supports ←→ reordering. */
  readonly reorderable: boolean;
  maximum(context: SamplingContext): number;
  values(overlay: SettingsOverlayState): readonly Value[];
  identityKey(value: Value): string;
  editableText(value: Value): string;
  /** Parses `raw` and applies it at `index` (appending when `index` is one
   * past the end). Returns an error message, or null on success. */
  set(overlay: SettingsOverlayState, index: number, raw: string): string | null;
  remove(overlay: SettingsOverlayState, index: number): boolean;
  /** Reorders the entry at the current cursor by `step`. Every panel that is
   * not `reorderable` returns false unconditionally. */
  move(overlay: SettingsOverlayState, step: -1 | 1): boolean;
}

/** Every logit-bias-family panel's displayed ceiling is the *resolved*
 * bound, not its own raw list-length policy: a phraseBias or bannedStrings
 * entry expands to one or more tokens, and even a bare numeric logitBias
 * entry counts 1:1 against the same merged object
 * (server/sampling-phrase-bias.ts). The resolved bound is almost always the
 * binding constraint in practice, and is what a KoboldCpp writer actually
 * hits — see SAMPLING_RESOLVED_LOGIT_BIAS_PRESET_OVERRIDES in
 * shared/sampling-validation-policy.ts. */
function resolvedBiasMaximum(context: SamplingContext): number {
  // A read-only format-1 view has no real preset, and every list panel
  // reads "unavailable" for it regardless — this only sets a display
  // fallback, never a bound anything is actually validated against.
  return context.preset === "legacy-v1"
    ? SAMPLING_RESOLVED_LOGIT_BIAS_POLICY.maxEntries
    : maxResolvedLogitBiasEntries(context.preset);
}

/** Reorders a plain string list at the panel's current cursor by `step` —
 * shared by every reorderable panel (`stop`, `dry-breakers`) so the swap
 * logic exists once. */
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

const STOP_SPEC: SamplingListPanelSpec<string> = {
  panel: "stop",
  knob: "stop",
  statusLabel: "STOP",
  reorderable: true,
  maximum: () => SAMPLING_STOP_POLICY.maxSequences,
  values: (overlay) => overlay.draft.sampling.stop,
  identityKey: (value) => value,
  editableText: (value) => value,
  set: (overlay, index, raw) => {
    const nextStop = [...overlay.draft.sampling.stop];
    if (index > nextStop.length) return "stop sequence row is no longer available";
    if (index === nextStop.length) nextStop.push(raw);
    else nextStop[index] = raw;
    return applySamplingUpdate(overlay, { ...overlay.draft.sampling, stop: nextStop });
  },
  remove: (overlay, index) => {
    const sampling = overlay.draft.sampling;
    if (index < 0 || index >= sampling.stop.length) return false;
    updateSamplingDraft(overlay, { ...sampling, stop: sampling.stop.filter((_, item) => item !== index) });
    return true;
  },
  move: (overlay, step) => moveStringListEntry(overlay, "stop", step)
};

const DRY_BREAKERS_SPEC: SamplingListPanelSpec<string> = {
  panel: "dry-breakers",
  knob: "dryBreakers",
  statusLabel: "DRY BREAKERS",
  reorderable: true,
  maximum: () => SAMPLING_DRY_BREAKERS_POLICY.maxSequences,
  values: (overlay) => overlay.draft.sampling.dryBreakers,
  identityKey: (value) => value,
  editableText: (value) => value,
  set: (overlay, index, raw) => {
    const nextBreakers = [...overlay.draft.sampling.dryBreakers];
    if (index > nextBreakers.length) return "dry breaker row is no longer available";
    if (index === nextBreakers.length) nextBreakers.push(raw);
    else nextBreakers[index] = raw;
    return applySamplingUpdate(overlay, { ...overlay.draft.sampling, dryBreakers: nextBreakers });
  },
  remove: (overlay, index) => {
    const sampling = overlay.draft.sampling;
    if (index < 0 || index >= sampling.dryBreakers.length) return false;
    updateSamplingDraft(overlay, {
      ...sampling,
      dryBreakers: sampling.dryBreakers.filter((_, item) => item !== index)
    });
    return true;
  },
  move: (overlay, step) => moveStringListEntry(overlay, "dryBreakers", step)
};

const LOGIT_BIAS_SPEC: SamplingListPanelSpec<readonly [string, number]> = {
  panel: "logit-bias",
  knob: "logitBias",
  statusLabel: "LOGIT BIAS",
  reorderable: false,
  maximum: resolvedBiasMaximum,
  values: (overlay) => samplingLogitBiasEntries(overlay),
  identityKey: (value) => value[0],
  editableText: (value) => `${value[0]}:${value[1]}`,
  set: (overlay, index, raw) => {
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
    const error = applySamplingUpdate(overlay, { ...overlay.draft.sampling, logitBias: Object.fromEntries(entries) });
    if (error === null && overlay.sampling !== null) overlay.sampling.logitBiasOrder = entries.map(([key]) => key);
    return error;
  },
  remove: (overlay, index) => {
    const entries = samplingLogitBiasEntries(overlay);
    if (index < 0 || index >= entries.length) return false;
    entries.splice(index, 1);
    updateSamplingDraft(overlay, { ...overlay.draft.sampling, logitBias: Object.fromEntries(entries) });
    if (overlay.sampling !== null) overlay.sampling.logitBiasOrder = entries.map(([key]) => key);
    return true;
  },
  move: () => false
};

const PHRASE_BIAS_SPEC: SamplingListPanelSpec<SamplingPhraseBiasEntryV2> = {
  panel: "phrase-bias",
  knob: "phraseBias",
  statusLabel: "PHRASE BIAS",
  reorderable: false,
  maximum: resolvedBiasMaximum,
  values: (overlay) => overlay.draft.sampling.phraseBias,
  identityKey: (value) => value.phrase,
  editableText: (value) => `${value.phrase}:${value.weight}`,
  // Splits on the *last* colon, not the first: unlike a logit-bias token ID,
  // a phrase can itself legally contain a colon (e.g. "Dr. Smith: hello").
  // Format only — validateSamplingSettings (via applySamplingUpdate) is the
  // one validator for weight range and duplicate phrases, the same as
  // bannedStrings below; there is no separate pre-check to keep in sync.
  set: (overlay, index, raw) => {
    const divider = raw.lastIndexOf(":");
    if (divider <= 0) return "use phrase:integer bias";
    const phraseText = raw.slice(0, divider).trim();
    const weightText = raw.slice(divider + 1).trim();
    if (!/^-?\d+$/u.test(weightText)) return "bias must be an integer";
    const entries = [...overlay.draft.sampling.phraseBias];
    if (index < 0 || index > entries.length) return "phrase bias row is no longer available";
    const entry: SamplingPhraseBiasEntryV2 = { phrase: phraseText, weight: Number(weightText) };
    if (index === entries.length) entries.push(entry);
    else entries[index] = entry;
    return applySamplingUpdate(overlay, { ...overlay.draft.sampling, phraseBias: entries });
  },
  remove: (overlay, index) => {
    const sampling = overlay.draft.sampling;
    if (index < 0 || index >= sampling.phraseBias.length) return false;
    updateSamplingDraft(overlay, {
      ...sampling,
      phraseBias: sampling.phraseBias.filter((_, item) => item !== index)
    });
    return true;
  },
  move: () => false
};

const BANNED_STRINGS_SPEC: SamplingListPanelSpec<string> = {
  panel: "banned-strings",
  knob: "bannedStrings",
  statusLabel: "BANNED STRINGS",
  reorderable: false,
  maximum: resolvedBiasMaximum,
  values: (overlay) => overlay.draft.sampling.bannedStrings,
  identityKey: (value) => value,
  editableText: (value) => value,
  set: (overlay, index, raw) => {
    const nextBanned = [...overlay.draft.sampling.bannedStrings];
    if (index > nextBanned.length) return "banned string row is no longer available";
    if (index === nextBanned.length) nextBanned.push(raw);
    else nextBanned[index] = raw;
    return applySamplingUpdate(overlay, { ...overlay.draft.sampling, bannedStrings: nextBanned });
  },
  remove: (overlay, index) => {
    const sampling = overlay.draft.sampling;
    if (index < 0 || index >= sampling.bannedStrings.length) return false;
    updateSamplingDraft(overlay, {
      ...sampling,
      bannedStrings: sampling.bannedStrings.filter((_, item) => item !== index)
    });
    return true;
  },
  move: () => false
};

export const SAMPLING_LIST_PANEL_ORDER = [
  "stop",
  "logit-bias",
  "phrase-bias",
  "banned-strings",
  "dry-breakers"
] as const satisfies readonly SamplingListPanel[];

const SAMPLING_LIST_PANEL_SPECS: Readonly<Record<SamplingListPanel, SamplingListPanelSpec<unknown>>> = {
  stop: STOP_SPEC as SamplingListPanelSpec<unknown>,
  "logit-bias": LOGIT_BIAS_SPEC as SamplingListPanelSpec<unknown>,
  "phrase-bias": PHRASE_BIAS_SPEC as SamplingListPanelSpec<unknown>,
  "banned-strings": BANNED_STRINGS_SPEC as SamplingListPanelSpec<unknown>,
  "dry-breakers": DRY_BREAKERS_SPEC as SamplingListPanelSpec<unknown>
};

export function samplingListPanelSpec(panel: SamplingListPanel): SamplingListPanelSpec<unknown> {
  return SAMPLING_LIST_PANEL_SPECS[panel];
}

/** The status bar's short name for a list panel while it is open, e.g.
 * `STOP` — read by tui/src/screens/story/status.ts. */
export function samplingListPanelStatusLabel(panel: SamplingListPanel): string {
  return samplingListPanelSpec(panel).statusLabel;
}

/** logitBias is a Record, not an ordered list; `logitBiasOrder` on the
 * nested overlay state remembers display order across edits (an insertion
 * a writer just made stays where they put it) with any entry the order
 * forgot — e.g. one loaded from a saved document — appended at the end. */
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
  replaceSettingsDraft(overlay, { ...overlay.draft, document, sampling });
  if (overlay.conflict !== null) overlay.conflict.armed = false;
  overlay.result = null;
  if (overlay.sampling !== null) overlay.sampling.result = "draft updated · save in Settings";
}

function applySamplingUpdate(overlay: SettingsOverlayState, next: SamplingSettingsV2): string | null {
  const error = validateSampling(next);
  if (error !== null) return error;
  updateSamplingDraft(overlay, next);
  return null;
}

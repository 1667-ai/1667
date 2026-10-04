import {
  applySamplingSettings,
  samplingKnobPresentation,
  type SamplingKnobV2
} from "../../../shared/sampling-capabilities.js";
import {
  formatLogitBiasText,
  lines,
  parseLogitBiasText
} from "../../../shared/sampling-list-text.js";
import {
  SAMPLING_DRY_BREAKERS_POLICY,
  SAMPLING_STOP_POLICY,
  maxResolvedLogitBiasEntries,
  SAMPLING_RESOLVED_LOGIT_BIAS_POLICY,
  validateSamplingSettings
} from "../../../shared/sampling-validation-policy.js";
import {
  samplingScalarDisplay,
  type SamplingListPanel,
  type SamplingScalarKnob
} from "../../../shared/sampling-row-presentation.js";
import { formatPhraseBiasText, parsePhraseBiasText } from "../../../shared/story-sampling-text.js";
import { samplingContextForDraft } from "../../../shared/settings-profile-fields.js";
import type { SamplingSettingsV2, SettingsView } from "../../../shared/settings-v2-types.js";
import type { SettingsDocumentV5 } from "../../../shared/settings-v5-types.js";
import type { SettingsTextDraft } from "../../../shared/settings-text-draft.js";
import type { EditResult, SettingsEdit } from "./model.js";

/** The sampling edits of the advanced view. The rules (knob bounds, list
 * limits, the line formats) are the shared ones the terminal uses. */

export const SAMPLING_LISTS: readonly {
  readonly panel: SamplingListPanel;
  readonly knob: SamplingKnobV2;
  readonly label: string;
  readonly help: string;
}[] = [
  { panel: "stop", knob: "stop", label: "Stop sequences", help: "One per line. The model stops when it writes one." },
  { panel: "logit-bias", knob: "logitBias", label: "Logit bias", help: "One per line, as token ID:bias. The bias is a whole number." },
  { panel: "phrase-bias", knob: "phraseBias", label: "Phrase bias", help: "One per line, as phrase: weight. The weight is a whole number from -100 to 100." },
  { panel: "banned-strings", knob: "bannedStrings", label: "Banned strings", help: "One per line. The model does not write them." },
  { panel: "dry-breakers", knob: "dryBreakers", label: "DRY breakers", help: "One per line. They end a repeated sequence." }
];

export function samplingOf(draft: SettingsTextDraft): SamplingSettingsV2 {
  return draft.sampling;
}

function validate(sampling: SamplingSettingsV2): string | null {
  try {
    validateSamplingSettings(sampling);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function withSampling(edit: SettingsEdit, sampling: SamplingSettingsV2): SettingsEdit {
  const { document, selectedProfileId } = edit.draft;
  const next = document === null || selectedProfileId === null
    ? document
    : applySamplingSettings(document as never, sampling, selectedProfileId) as unknown as SettingsDocumentV5;
  return { ...edit, draft: { ...edit.draft, document: next, sampling } };
}

export function applySamplingScalar(edit: SettingsEdit, knob: SamplingScalarKnob, text: string): EditResult {
  const trimmed = text.trim();
  const value = trimmed.length === 0 ? null : Number(trimmed);
  if (value !== null && !Number.isFinite(value)) return { error: "not a number" };
  const next = { ...edit.draft.sampling, [knob]: value } as SamplingSettingsV2;
  const error = validate(next);
  return error === null ? { edit: withSampling(edit, next) } : { error };
}

export function samplingScalarText(draft: SettingsTextDraft, knob: SamplingScalarKnob): string {
  const value = draft.sampling[knob];
  return value === null ? "" : String(value);
}

export function samplingScalarShown(draft: SettingsTextDraft, knob: SamplingScalarKnob): string {
  return samplingScalarDisplay(knob, draft.sampling[knob]);
}

export function samplingListText(draft: SettingsTextDraft, panel: SamplingListPanel): string {
  const sampling = draft.sampling;
  switch (panel) {
    case "stop": return sampling.stop.join("\n");
    case "dry-breakers": return sampling.dryBreakers.join("\n");
    case "banned-strings": return sampling.bannedStrings.join("\n");
    case "logit-bias": return formatLogitBiasText(sampling.logitBias);
    case "phrase-bias": return formatPhraseBiasText(sampling.phraseBias);
  }
}

export function applySamplingList(edit: SettingsEdit, panel: SamplingListPanel, text: string): EditResult {
  const sampling = edit.draft.sampling;
  let next: SamplingSettingsV2;
  switch (panel) {
    case "stop": next = { ...sampling, stop: lines(text) }; break;
    case "dry-breakers": next = { ...sampling, dryBreakers: lines(text) }; break;
    case "banned-strings": next = { ...sampling, bannedStrings: lines(text) }; break;
    case "logit-bias": {
      const parsed = parseLogitBiasText(text);
      if ("error" in parsed) return { error: parsed.error };
      next = { ...sampling, logitBias: parsed.value };
      break;
    }
    case "phrase-bias": {
      const parsed = parsePhraseBiasText(text);
      if (!parsed.ok) return { error: parsed.toast };
      next = { ...sampling, phraseBias: parsed.value };
      break;
    }
  }
  const error = validate(next);
  return error === null ? { edit: withSampling(edit, next) } : { error };
}

/** What a sampling row says about the selected route: whether the knob
 * applies, and why not. A read-only view reads as unavailable. */
export function samplingAvailability(view: SettingsView, draft: SettingsTextDraft, knob: SamplingKnobV2) {
  const context = samplingContextForDraft(view, draft);
  return context === null
    ? { available: false, reason: "These settings are read-only." }
    : samplingKnobPresentation(context, draft.sampling, knob);
}

export function samplingListLimit(view: SettingsView, draft: SettingsTextDraft, panel: SamplingListPanel): number {
  if (panel === "stop") return SAMPLING_STOP_POLICY.maxSequences;
  if (panel === "dry-breakers") return SAMPLING_DRY_BREAKERS_POLICY.maxSequences;
  const context = samplingContextForDraft(view, draft);
  return context === null || context.preset === "legacy-v1"
    ? SAMPLING_RESOLVED_LOGIT_BIAS_POLICY.maxEntries
    : maxResolvedLogitBiasEntries(context.preset);
}

export function samplingListCount(draft: SettingsTextDraft, panel: SamplingListPanel): number {
  const sampling = draft.sampling;
  switch (panel) {
    case "stop": return sampling.stop.length;
    case "dry-breakers": return sampling.dryBreakers.length;
    case "banned-strings": return sampling.bannedStrings.length;
    case "logit-bias": return Object.keys(sampling.logitBias).length;
    case "phrase-bias": return sampling.phraseBias.length;
  }
}

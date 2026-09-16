/** Names the pending changes for the D-07 pending bar (DESIGN_SPEC.md §6):
 * "temperature 0.8 → 0.65", "utility route → quick". Kept separate from
 * `renderer-settings-model.ts` (already near the ~500-line guideline in
 * `00-common.md`) rather than folding this in and pushing it over. */
import { SAMPLING_SCALAR_KNOB_V2_VALUES, SETTINGS_ROUTE_PURPOSE_VALUES, type SamplingSettingsV2 } from "../shared/settings-v2-types.js";
import { samplingKnobLabel } from "../shared/sampling-capabilities.js";
import type { GenerationProfileV5, SettingsDocumentV5 } from "../shared/settings-v5-types.js";
import { profileGenerationReasoning } from "./renderer-settings-controls.js";
import { samplingForProfile, type SettingsEditorDraft } from "./renderer-settings-model.js";

/** The complete-draft comparison the D-07 pending bar and section nav rely
 * on for "is anything unsaved" (`describeSettingsChanges` below names only
 * some fields, so its own length used to under-report). Mirrors
 * `RendererApp.hasDirtySettings()`'s document comparison. */
export function settingsDraftDirty(document: SettingsDocumentV5, draft: SettingsEditorDraft): boolean {
  return JSON.stringify(draft.document) !== JSON.stringify(document)
    || Object.keys(draft.connectionSecrets).length > 0;
}

export function describeSettingsChanges(document: SettingsDocumentV5, draft: SettingsEditorDraft): readonly string[] {
  const next = draft.document;
  const changes: string[] = [];

  for (const purpose of SETTINGS_ROUTE_PURPOSE_VALUES) {
    const before = document.routing[purpose];
    const after = next.routing[purpose];
    if (before === after) continue;
    changes.push(`${purpose} route ${routeName(document, before)} → ${routeName(next, after)}`);
  }

  for (const id of Object.keys(next.profiles)) {
    if (document.profiles[id] === undefined) changes.push(`+ profile ${next.profiles[id]!.name || id}`);
  }
  for (const id of Object.keys(document.profiles)) {
    if (next.profiles[id] === undefined) changes.push(`- profile ${document.profiles[id]!.name || id}`);
  }
  for (const id of Object.keys(next.connections)) {
    if (document.connections[id] === undefined) changes.push(`+ connection ${next.connections[id]!.name || id}`);
  }

  const before = document.profiles[draft.selectedProfileId];
  const after = next.profiles[draft.selectedProfileId];
  if (before !== undefined && after !== undefined) {
    changes.push(...profileFieldChanges(before, after));
    changes.push(...samplingChanges(samplingForProfile(before), samplingForProfile(after)));
  }
  // Connections, other profiles, writing prompts, and pending secrets have
  // no named diff above. Rather than name every one of those fields too,
  // fall back to one catch-all entry whenever the complete draft comparison
  // still finds a difference the named changes above did not describe — so
  // the pending bar and its Discard button never under-report "0 changes"
  // while Save would still apply something.
  if (changes.length === 0 && settingsDraftDirty(document, draft)) changes.push("other settings edited");
  return changes;
}

function routeName(document: SettingsDocumentV5, profileId: string | undefined): string {
  if (profileId === undefined) return "default route";
  return document.profiles[profileId]?.name || profileId;
}

function profileFieldChanges(before: GenerationProfileV5, after: GenerationProfileV5): readonly string[] {
  const changes: string[] = [];
  if (before.name !== after.name) changes.push(`profile name ${before.name} → ${after.name}`);
  if (before.temperature !== after.temperature) changes.push(numberChange("temperature", before.temperature, after.temperature));
  if (before.maxOutputTokens !== after.maxOutputTokens) changes.push(numberChange("max output", before.maxOutputTokens, after.maxOutputTokens));
  if (before.tokenProbabilities !== after.tokenProbabilities) changes.push(numberChange("token alternatives", before.tokenProbabilities ?? null, after.tokenProbabilities ?? null));
  if (before.cachePolicy !== after.cachePolicy) changes.push(`prompt cache ${before.cachePolicy} → ${after.cachePolicy}`);
  if ((before.discardReasoning === true) !== (after.discardReasoning === true)) {
    changes.push(after.discardReasoning === true ? "keep model thoughts on → off" : "keep model thoughts off → on");
  }
  const beforeReasoning = profileGenerationReasoning(before.generationReasoning);
  const afterReasoning = profileGenerationReasoning(after.generationReasoning);
  if (beforeReasoning.effort !== afterReasoning.effort) changes.push(`reasoning effort ${beforeReasoning.effort} → ${afterReasoning.effort}`);
  return changes;
}

function samplingChanges(before: SamplingSettingsV2, after: SamplingSettingsV2): readonly string[] {
  const changes: string[] = [];
  for (const knob of SAMPLING_SCALAR_KNOB_V2_VALUES) {
    if (before[knob] !== after[knob]) changes.push(numberChange(samplingKnobLabel(knob).toLowerCase(), before[knob], after[knob]));
  }
  return changes;
}

function numberChange(label: string, before: number | null, after: number | null): string {
  return `${label} ${formatDiffNumber(before)} → ${formatDiffNumber(after)}`;
}

function formatDiffNumber(value: number | null): string {
  return value === null ? "—" : String(value);
}

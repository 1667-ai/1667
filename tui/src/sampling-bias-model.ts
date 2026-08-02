import { validateSamplingPhraseBiasEntry } from "../../shared/sampling-validation-policy.js";
import type { SamplingPhraseBiasEntryV2 } from "../../shared/settings-v2-types.js";
import type { SettingsOverlayState } from "./state.js";
import { updateSamplingDraft, validateSampling } from "./sampling-model.js";

/** Setters for the two panels issue #282 added: phrase bias and banned
 * strings. Split out of sampling-model.ts to keep that file under the
 * repository's file-size guideline; the panel-dispatch logic (row building,
 * list navigation) stays there since every panel — including these two —
 * shares it. */

/** Splits on the *last* colon, not the first: unlike a logit-bias token ID, a
 * phrase can itself legally contain a colon (e.g. "Dr. Smith: hello"). */
export function setPhraseBias(
  overlay: SettingsOverlayState,
  index: number,
  raw: string
): string | null {
  const divider = raw.lastIndexOf(":");
  if (divider <= 0) return "use phrase:integer bias";
  const phraseText = raw.slice(0, divider).trim();
  const weightText = raw.slice(divider + 1).trim();
  if (!/^-?\d+$/u.test(weightText)) return "bias must be an integer";
  const weight = Number(weightText);
  let entry: SamplingPhraseBiasEntryV2;
  try {
    entry = validateSamplingPhraseBiasEntry(phraseText, weight, "phrase bias");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const entries = [...overlay.draft.sampling.phraseBias];
  if (index < 0 || index > entries.length) return "phrase bias row is no longer available";
  const existingPhrase = index < entries.length ? entries[index]!.phrase : null;
  if (entries.some((item) => item.phrase === entry.phrase && item.phrase !== existingPhrase)) {
    return "phrase already exists";
  }
  if (index === entries.length) entries.push(entry);
  else entries[index] = entry;
  const next = { ...overlay.draft.sampling, phraseBias: entries };
  const error = validateSampling(next);
  if (error !== null) return error;
  updateSamplingDraft(overlay, next);
  return null;
}

export function setBannedString(
  overlay: SettingsOverlayState,
  index: number,
  raw: string
): string | null {
  const nextBanned = [...overlay.draft.sampling.bannedStrings];
  if (index > nextBanned.length) return "banned string row is no longer available";
  if (index === nextBanned.length) nextBanned.push(raw);
  else nextBanned[index] = raw;
  const next = { ...overlay.draft.sampling, bannedStrings: nextBanned };
  const error = validateSampling(next);
  if (error !== null) return error;
  updateSamplingDraft(overlay, next);
  return null;
}

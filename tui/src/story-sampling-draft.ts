import {
  SamplingValidationError,
  validateSamplingBannedStrings,
  validateSamplingPhraseBias
} from "../../shared/sampling-validation-policy.js";
import type { SamplingPhraseBiasEntryV2 } from "../../shared/settings-v2-types.js";

/**
 * Composer text for a story's own phraseBias overlay (issue #341) — one
 * "phrase: weight" per line, the same line-per-entry shape `bannedStrings`
 * uses below. A plain multi-line field, not a row-by-row list panel like the
 * settings overlay's sampling editor (tui/src/sampling-panel-spec.ts):
 * phraseBias and bannedStrings here are a story-level scalar in the sense
 * `story-scalar-fields.ts` already means it — one whole-story value edited
 * as one piece of text — not a per-entry commit-time-checked list. Validated
 * through the same shared policy a profile's own phraseBias goes through
 * (shared/sampling-validation-policy.ts), so a story's bounds can never
 * drift from a profile's.
 */
export function formatPhraseBiasText(entries: readonly SamplingPhraseBiasEntryV2[]): string {
  return entries.map((entry) => `${entry.phrase}: ${entry.weight}`).join("\n");
}

const PHRASE_BIAS_LINE_PATTERN = /^(.+):\s*(-?\d+)$/u;

export function parsePhraseBiasText(
  raw: string
): { ok: true; value: readonly SamplingPhraseBiasEntryV2[] } | { ok: false; toast: string } {
  const entries: SamplingPhraseBiasEntryV2[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = PHRASE_BIAS_LINE_PATTERN.exec(line);
    if (match === null) {
      return { ok: false, toast: `${JSON.stringify(line)} must read "phrase: weight" (weight −100..100)` };
    }
    entries.push({ phrase: match[1]!.trim(), weight: Number(match[2]) });
  }
  try {
    return { ok: true, value: validateSamplingPhraseBias(entries, "phraseBias") };
  } catch (error) {
    if (error instanceof SamplingValidationError) return { ok: false, toast: error.message };
    throw error;
  }
}

export function formatBannedStringsText(entries: readonly string[]): string {
  return entries.join("\n");
}

export function parseBannedStringsText(
  raw: string
): { ok: true; value: readonly string[] } | { ok: false; toast: string } {
  const entries = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  try {
    return { ok: true, value: validateSamplingBannedStrings(entries, "bannedStrings") };
  } catch (error) {
    if (error instanceof SamplingValidationError) return { ok: false, toast: error.message };
    throw error;
  }
}

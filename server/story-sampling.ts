import { ServiceError as HttpError } from "./errors.js";
import {
  SamplingValidationError,
  validateSamplingBannedStrings,
  validateSamplingPhraseBias
} from "../shared/sampling-validation-policy.js";
import type { SamplingPhraseBiasEntryV2 } from "../shared/settings-v2-types.js";
import type { Story } from "../shared/types.js";

/**
 * Store one story's phraseBias overlay, or clear it with an empty array
 * (issue #341). Mirrors `setFactsBudget`'s shape: bounds through the same
 * shared validation policy a profile's own phraseBias already goes through
 * (`shared/sampling-validation-policy.ts`) — one set of rules for one shape,
 * whichever scope it is configured in, rather than a bespoke story-side copy
 * that could drift from the profile-side one. Independent of
 * `setBannedStrings`: this never reads or touches `story.bannedStrings`, so
 * editing one story-level list never requires knowing the other's current
 * value. The value is already validated upstream on every real path (see
 * `server/worker-mutations.ts`'s `setPhraseBias` definition); this still
 * checks it directly rather than trusting that, the same way every other
 * story mutation here does not trust its caller.
 */
export function setPhraseBias(
  story: Pick<Story, "phraseBias">,
  phraseBias: readonly SamplingPhraseBiasEntryV2[]
): void {
  const valid = validated(() => validateSamplingPhraseBias(phraseBias, "phraseBias"));
  if (valid.length === 0) {
    delete story.phraseBias;
  } else {
    story.phraseBias = valid.map((entry) => ({ ...entry }));
  }
}

/** Whether this exact write would leave the story as it already is. Derived
 *  from the writer for the reason given on `authorBriefApplied`. */
export function phraseBiasApplied(
  story: Pick<Story, "phraseBias">,
  phraseBias: readonly SamplingPhraseBiasEntryV2[]
): boolean {
  const probe: Pick<Story, "phraseBias"> = { phraseBias: story.phraseBias };
  setPhraseBias(probe, phraseBias);
  return samePhraseBias(probe.phraseBias, story.phraseBias);
}

/** Same story-adds-to-profile relationship as `setPhraseBias`, for the
 *  banned-strings list. */
export function setBannedStrings(
  story: Pick<Story, "bannedStrings">,
  bannedStrings: readonly string[]
): void {
  const valid = validated(() => validateSamplingBannedStrings(bannedStrings, "bannedStrings"));
  if (valid.length === 0) {
    delete story.bannedStrings;
  } else {
    story.bannedStrings = [...valid];
  }
}

export function bannedStringsApplied(
  story: Pick<Story, "bannedStrings">,
  bannedStrings: readonly string[]
): boolean {
  const probe: Pick<Story, "bannedStrings"> = { bannedStrings: story.bannedStrings };
  setBannedStrings(probe, bannedStrings);
  return sameBannedStrings(probe.bannedStrings, story.bannedStrings);
}

function validated<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof SamplingValidationError)) throw error;
    throw new HttpError(400, error.message);
  }
}

function samePhraseBias(
  left: readonly SamplingPhraseBiasEntryV2[] | undefined,
  right: readonly SamplingPhraseBiasEntryV2[] | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.length === right.length
    && left.every((entry, index) => entry.phrase === right[index]!.phrase && entry.weight === right[index]!.weight);
}

function sameBannedStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.length === right.length && left.every((phrase, index) => phrase === right[index]);
}

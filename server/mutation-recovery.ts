import type { Story, StoryPayload } from "../shared/types.js";
import { DiagnosticServiceError, ServiceError } from "./errors.js";
import { buildStoryPayload } from "./story-payload.js";
import { StoryDurabilityError } from "./story-lifecycle.js";
import type { StoryStore } from "./stories.js";

/**
 * Canonical mapping for a durability loss inside a mutation commit: the write
 * may or may not have reached disk, so the outcome is unknown and the caller
 * must resynchronize authoritative state. Returns null for any other error.
 */
export function unknownOutcomeFromDurabilityFailure(
  error: unknown
): ServiceError | null {
  return error instanceof StoryDurabilityError
    ? mutationOutcomeUnknown({ diagnosticCause: error })
    : null;
}

export async function reconcileStoryMutation(
  stories: StoryStore,
  storyId: string,
  matches: (story: Story) => boolean | Promise<boolean>
): Promise<StoryPayload> {
  const story = await stories.loadForMutation(storyId);
  if (await matches(story)) return buildStoryPayload(story);
  throw mutationOutcomeUnknown();
}

export function mutationOutcomeUnknown(
  options?: { readonly diagnosticCause: unknown }
): ServiceError {
  return options === undefined
    ? new ServiceError(
    409,
    "The mutation may have completed before the backend stopped. Reload authoritative state before trying again.",
    "mutation_outcome_unknown"
      )
    : new DiagnosticServiceError(
        409,
        "The mutation may have completed before the backend stopped. Reload authoritative state before trying again.",
        "mutation_outcome_unknown",
        options.diagnosticCause
      );
}

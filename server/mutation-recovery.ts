import type { Story, StoryPayload } from "../shared/types.js";
import { DiagnosticServiceError, ServiceError } from "./errors.js";
import { buildStoryPayload } from "./story-payload.js";
import type { StoryStore } from "./stories.js";

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

export function generationOutcomeUnknown(
  options?: { readonly diagnosticCause: unknown }
): ServiceError {
  return options === undefined
    ? new ServiceError(
    409,
    "The model request stopped before 1667 received a final result. Reload the story before you send another request.",
    "generation_outcome_unknown"
      )
    : new DiagnosticServiceError(
        409,
        "The model request stopped before 1667 received a final result. Reload the story before you send another request.",
        "generation_outcome_unknown",
        options.diagnosticCause
      );
}

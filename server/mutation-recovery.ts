import type { Story, StoryPayload } from "../shared/types.js";
import { ServiceError } from "./errors.js";
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

export function mutationOutcomeUnknown(): ServiceError {
  return new ServiceError(
    409,
    "The mutation may have completed before the backend stopped. Reload authoritative state before trying again.",
    "mutation_outcome_unknown"
  );
}

export function generationOutcomeUnknown(): ServiceError {
  return new ServiceError(
    409,
    "The model request may have been billed or completed before the backend stopped. Reload state; retry only with a new mutation ID.",
    "generation_outcome_unknown"
  );
}

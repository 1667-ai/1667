/**
 * Mint a durable story mutation request when a transport did not supply one
 * (in-process tests and direct StoryService calls). Production worker/HTTP
 * paths always supply their own mutation identity.
 */
import { createHash, randomBytes } from "node:crypto";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { asideEntryPointsOpen } from "../shared/aside-release.js";
import type { StoryStore } from "./stories.js";
import { ServiceError } from "./errors.js";

export type MintedStoryMutationRequest = {
  transportOperationId: string;
  mutationId: string;
  fingerprint: string;
  scope: `story:${string}`;
  expectedAggregateVersion: NonNullable<
    Awaited<ReturnType<StoryStore["loadVersioned"]>>["aggregateVersion"]
  >;
  durability?: "manifest-only";
};

export async function mintStoryMutationRequest(
  stories: StoryStore,
  storyId: string,
  purpose: string,
  detail = "",
  options: { durability?: "manifest-only" } = {}
): Promise<MintedStoryMutationRequest> {
  const { aggregateVersion } = await stories.loadVersioned(storyId);
  if (aggregateVersion === null) {
    throw new ServiceError(404, `Story not found: ${storyId}`);
  }
  const mutationId = createDurableMutationId();
  const fingerprint = createHash("sha256")
    .update(`story-mutation-v1\0${purpose}\0${storyId}\0${mutationId}\0${detail}`)
    .update(randomBytes(8))
    .digest("hex");
  return {
    transportOperationId: createDurableMutationId(),
    mutationId,
    fingerprint,
    scope: `story:${storyId}`,
    expectedAggregateVersion: aggregateVersion,
    ...(options.durability === undefined ? {} : { durability: options.durability })
  };
}

/** Give direct in-process callers the durable path only when this release
 * owns the Aside successor schema. The inactive predecessor keeps its old
 * direct path, which rejects a V10 story at the storage boundary. */
export async function mintActivatedStoryMutationRequest(
  stories: StoryStore,
  storyId: string,
  purpose: string,
  detail = ""
): Promise<MintedStoryMutationRequest | undefined> {
  return asideEntryPointsOpen(stories.asideActivation)
    ? await mintStoryMutationRequest(stories, storyId, purpose, detail)
    : undefined;
}

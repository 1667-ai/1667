import type { StoryAggregateVersion } from "./mutation-coordinator.js";
import {
  sameStoryAggregateVersion,
  storyAggregateVersion,
  type StoryAggregateSnapshot
} from "./story-aggregate-state.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import type { StoryStore } from "./stories.js";

/** Process-local proof of the typed content version hidden by an active
 * provider-start revision. Durable recovery never uses this exception: after a
 * restart clients must load the published V6 version. */
export class ActiveProviderStarts {
  private readonly predecessors =
    new Map<string, Map<string, StoryAggregateVersion>>();

  pinSnapshot(
    stories: StoryStore,
    session: StoryAggregateSession,
    mutationId: string
  ): () => void {
    const storyId = session.storyId;
    const releaseSnapshot = stories.pinProviderSnapshot(session);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const storyPredecessors = this.predecessors.get(storyId);
      storyPredecessors?.delete(mutationId);
      if (storyPredecessors?.size === 0) {
        this.predecessors.delete(storyId);
      }
      releaseSnapshot();
    };
  }

  remember(
    storyId: string,
    mutationId: string,
    snapshot: StoryAggregateSnapshot
  ): void {
    const version = storyAggregateVersion(snapshot);
    const storyPredecessors = this.predecessors.get(storyId)
      ?? new Map<string, StoryAggregateVersion>();
    const existing = storyPredecessors.get(mutationId);
    if (existing !== undefined
      && !sameStoryAggregateVersion(existing, version)) {
      throw new Error("Provider start predecessor changed within one mutation");
    }
    storyPredecessors.set(mutationId, version);
    this.predecessors.set(storyId, storyPredecessors);
  }

  predecessor(
    storyId: string,
    providerMutationId: string | null
  ): StoryAggregateVersion | null {
    if (providerMutationId === null) return null;
    return this.predecessors
      .get(storyId)
      ?.get(providerMutationId) ?? null;
  }
}

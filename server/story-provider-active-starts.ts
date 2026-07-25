import type { StoryAggregateVersion } from "./mutation-coordinator.js";
import {
  sameStoryAggregateVersion,
  storyAggregateVersion,
  type StoryAggregateSnapshot
} from "./story-aggregate-state.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import type { StoryStore } from "./stories.js";

interface ActiveProviderStart {
  pins: number;
  predecessor: StoryAggregateVersion | null;
}

/** Process-local proof of the typed content version hidden by an active
 * provider-start revision. Durable recovery never uses this exception: after a
 * restart clients must load the published V6 version. */
export class ActiveProviderStarts {
  private readonly predecessors =
    new Map<string, Map<string, ActiveProviderStart>>();

  pinSnapshot(
    stories: StoryStore,
    session: StoryAggregateSession,
    mutationId: string
  ): () => void {
    const storyId = session.storyId;
    const releaseSnapshot = stories.pinProviderSnapshot(session);
    const storyPredecessors = this.predecessors.get(storyId)
      ?? new Map<string, ActiveProviderStart>();
    const start = storyPredecessors.get(mutationId)
      ?? { pins: 0, predecessor: null };
    start.pins += 1;
    storyPredecessors.set(mutationId, start);
    this.predecessors.set(storyId, storyPredecessors);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const currentPredecessors = this.predecessors.get(storyId);
      if (currentPredecessors?.get(mutationId) === start) {
        start.pins -= 1;
        if (start.pins === 0) {
          currentPredecessors.delete(mutationId);
          if (currentPredecessors.size === 0) {
            this.predecessors.delete(storyId);
          }
        }
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
    const start = this.predecessors.get(storyId)?.get(mutationId);
    if (start === undefined) {
      throw new Error("Provider start predecessor has no snapshot pin");
    }
    if (start.predecessor !== null
      && !sameStoryAggregateVersion(start.predecessor, version)) {
      throw new Error("Provider start predecessor changed within one mutation");
    }
    start.predecessor = version;
  }

  predecessor(
    storyId: string,
    providerMutationId: string | null
  ): StoryAggregateVersion | null {
    if (providerMutationId === null) return null;
    return this.predecessors
      .get(storyId)
      ?.get(providerMutationId)
      ?.predecessor ?? null;
  }
}

import {
  storyAggregateVersionIsAtLeast,
  type StoryAggregateVersion
} from "../../shared/story-aggregate-version.js";
import type {
  StoryPayload,
  StorySummary
} from "../../shared/types.js";

/** Incarnation-local optimistic-concurrency tokens for HTTP story mutations. */
export class HttpStoryVersions {
  private readonly versions = new Map<string, StoryAggregateVersion>();

  rememberPayload(payload: StoryPayload): StoryPayload {
    const candidate = payload.aggregateVersion;
    const held = this.versions.get(payload.id);
    if (candidate !== undefined
      && (held === undefined || storyAggregateVersionIsAtLeast(candidate, held))) {
      this.versions.set(payload.id, candidate);
    }
    return payload;
  }

  rememberSummaries(summaries: StorySummary[]): StorySummary[] {
    for (const summary of summaries) {
      const candidate = summary.aggregateVersion;
      if (candidate === undefined) continue;
      const held = this.versions.get(summary.id);
      if (held === undefined || storyAggregateVersionIsAtLeast(candidate, held)) {
        this.versions.set(summary.id, candidate);
      }
    }
    return summaries;
  }

  async expected(
    storyId: string,
    load: () => Promise<StoryPayload>
  ): Promise<StoryAggregateVersion> {
    const held = this.versions.get(storyId);
    if (held !== undefined) return held;
    const loaded = this.rememberPayload(await load());
    if (loaded.aggregateVersion === undefined) {
      throw new Error(
        "This story was loaded without optimistic-concurrency metadata."
      );
    }
    return loaded.aggregateVersion;
  }

  set(storyId: string, version: StoryAggregateVersion): void {
    this.versions.set(storyId, version);
  }

  forget(storyId: string): void {
    this.versions.delete(storyId);
  }
}

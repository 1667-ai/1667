import {
  buildSearchCorpus,
  createSearchScan,
  searchQueryIsRunnable,
  type SearchCorpus,
  type SearchResponse
} from "../shared/story-search.js";
import type { Story, StorySummary } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import { parseSearchRequest } from "./service-input.js";
import { StorySearchIndex } from "./story-search-index.js";

function requireLiveSearch(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ServiceError(408, "Search was superseded or cancelled");
  }
}

export interface StorySearchStore {
  loadRevision(id: string): Promise<{ title: string; updatedAt: string } | null>;
  loadHydrated(id: string): Promise<Story>;
  list(): Promise<StorySummary[]>;
}

export class StorySearch {
  private readonly searchIndex = new StorySearchIndex();

  constructor(private readonly stories: StorySearchStore) {}

  forget(storyId: string): void {
    this.searchIndex.forget(storyId);
  }

  async searchStories(input: unknown, signal?: AbortSignal): Promise<SearchResponse> {
    const request = parseSearchRequest(input);
    const query = request.query.trim();
    const base: SearchResponse = {
      query,
      scope: request.scope,
      caseSensitive: request.caseSensitive,
      hits: [],
      capped: false,
      storiesSearched: 0
    };
    if (!searchQueryIsRunnable(query)) return base;
    requireLiveSearch(signal);
    const summaries = request.scope === "tree" ? [] : await this.stories.list();
    const revisions = new Map(summaries.map((summary) =>
      [summary.id, { title: summary.title, updatedAt: summary.updatedAt }] as const));
    const targets = [
      request.storyId,
      ...summaries.map((summary) => summary.id).filter((id) => id !== request.storyId)
    ];
    const scan = createSearchScan(query, request.caseSensitive);
    for (const id of targets) {
      requireLiveSearch(signal);
      if (scan.full()) {
        scan.stopEarly();
        break;
      }
      const corpus = await this.searchCorpusFor(id, revisions.get(id));
      if (corpus === null) continue;
      scan.add(corpus);
    }
    return { ...base, hits: scan.hits, capped: scan.capped, storiesSearched: scan.storiesSearched };
  }

  /** The corpus for a story, from the cache when its revision still stands.
   *
   *  At vault scope `known` is the revision the catalog listing reported, and
   *  that listing is taken fresh at the start of this same request. A story
   *  edited or deleted inside that window is answered from the corpus the
   *  listing described, which is one keystroke stale; the next keystroke lists
   *  again and corrects it. Re-reading every manifest a second time to close a
   *  window that small would double the per-keystroke cost of the feature. */
  private async searchCorpusFor(
    id: string,
    known: { title: string; updatedAt: string } | undefined
  ): Promise<SearchCorpus | null> {
    const revision = known ?? await this.stories.loadRevision(id);
    if (revision === null) {
      this.searchIndex.forget(id);
      return null;
    }
    return await this.searchIndex.get(id, revision.title, revision.updatedAt, () =>
      this.buildSearchCorpus(id)
    );
  }

  /** A story that vanished between the listing and its turn is simply not
   *  there. Reporting it as absent is enough — the index owns retiring the
   *  entry, and only if this build still owns it. */
  private async buildSearchCorpus(id: string): Promise<SearchCorpus | null> {
    try {
      const story = await this.stories.loadHydrated(id);
      return buildSearchCorpus(story);
    } catch (error) {
      if (error instanceof ServiceError && error.status === 404) return null;
      throw error;
    }
  }
}

import {
  buildSearchCorpus,
  type SearchCorpus
} from "../shared/story-search.js";
import type { Story } from "../shared/types.js";

/** How much prepared text stays in memory, counted in UTF-16 units.
 *
 * The bound is a size, not a story count. A vault search reads every story in
 * turn, so a count-based cache smaller than the vault evicts each story just
 * before the next scan needs it and never hits again; sizing by text means the
 * cache holds the whole vault until the vault is genuinely too large for it,
 * and only then falls back to rescanning. */
const MAX_CACHED_CHARACTERS = 8_000_000;

/** Prepared searchable text, kept across keystrokes.
 *
 * A corpus is valid while the story's title and `updatedAt` stand still; every
 * mutation moves `updatedAt`. Nothing here is durable — dropping the cache only
 * costs one rescan — but keeping it is what lets a vault search answer each
 * keystroke without reading every part off disk again. */
export class StorySearchIndex {
  private readonly corpora = new Map<string, SearchCorpus>();
  private characters = 0;

  /** The prepared corpus for this exact revision, or null when it must be
   *  rebuilt from a hydrated story. */
  cached(storyId: string, title: string, updatedAt: string): SearchCorpus | null {
    const held = this.corpora.get(storyId);
    return held === undefined
      || held.updatedAt !== updatedAt
      || held.storyTitle !== title
      ? null
      : held;
  }

  /** Build and hold the corpus for a fully hydrated story. */
  adopt(story: Story): SearchCorpus {
    const corpus = buildSearchCorpus(story);
    const size = corpusSize(corpus);
    this.forget(story.id);
    if (size > MAX_CACHED_CHARACTERS) return corpus;
    this.corpora.set(story.id, corpus);
    this.characters += size;
    // Evict in insertion order. Promoting on every read would make a vault
    // scan reorder the whole cache behind itself, which is the pattern this
    // cache exists to survive.
    for (const [id, held] of this.corpora) {
      if (this.characters <= MAX_CACHED_CHARACTERS || id === story.id) break;
      this.corpora.delete(id);
      this.characters -= corpusSize(held);
    }
    return corpus;
  }

  forget(storyId: string): void {
    const held = this.corpora.get(storyId);
    if (held === undefined) return;
    this.corpora.delete(storyId);
    this.characters -= corpusSize(held);
  }
}

function corpusSize(corpus: SearchCorpus): number {
  return corpus.entries.reduce((sum, entry) => sum + entry.text.length, 0);
}

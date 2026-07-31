import type { SearchCorpus } from "../shared/story-search.js";

/** How much prepared text stays in memory, counted in UTF-16 units.
 *
 * The bound is a size, not a story count. A vault search reads every story in
 * turn, so a count-based cache smaller than the vault evicts each story just
 * before the next scan needs it and never hits again; sizing by text means the
 * cache holds the whole vault until the vault is genuinely too large for it,
 * and only then falls back to rescanning. */
const MAX_CACHED_CHARACTERS = 8_000_000;

interface HeldCorpus {
  title: string;
  updatedAt: string;
  promise: Promise<SearchCorpus | null>;
  size: number;
}

/** Prepared searchable text, kept across keystrokes.
 *
 * A corpus is valid while the story's title and `updatedAt` stand still; every
 * mutation moves `updatedAt`. Nothing here is durable — dropping the cache only
 * costs one rescan — but keeping it is what lets a vault search answer each
 * keystroke without reading every part off disk again. */
export class StorySearchIndex {
  private readonly corpora = new Map<string, HeldCorpus>();
  private characters = 0;

  /** The prepared corpus for this exact revision, or a build promise if one is
   *  currently in flight or needed. */
  async get(
    id: string,
    title: string,
    updatedAt: string,
    build: () => Promise<SearchCorpus | null>
  ): Promise<SearchCorpus | null> {
    const held = this.corpora.get(id);
    if (held !== undefined && held.title === title && held.updatedAt === updatedAt) {
      return held.promise;
    }
    if (held !== undefined) {
      this.forget(id);
    }

    let activePromise!: Promise<SearchCorpus | null>;
    activePromise = (async () => {
      try {
        const corpus = await build();
        if (corpus === null) {
          // Only this build's own entry may go. A newer revision can have
          // replaced it while this one was reading, and evicting that would
          // throw away a corpus somebody is already waiting on.
          if (this.corpora.get(id)?.promise === activePromise) this.forget(id);
          return null;
        }
        const current = this.corpora.get(id);
        if (current?.promise === activePromise) {
          const size = corpusSize(corpus);
          if (size > MAX_CACHED_CHARACTERS) {
            this.forget(id);
            return corpus;
          }
          current.size = size;
          this.characters += size;
          this.evictOverflow();
        }
        return corpus;
      } catch (error) {
        const current = this.corpora.get(id);
        if (current?.promise === activePromise) {
          this.forget(id);
        }
        throw error;
      }
    })();

    this.corpora.set(id, { title, updatedAt, promise: activePromise, size: 0 });
    return activePromise;
  }

  forget(storyId: string): void {
    const held = this.corpora.get(storyId);
    if (held === undefined) return;
    this.corpora.delete(storyId);
    this.characters -= held.size;
  }

  private evictOverflow(): void {
    for (const [id, held] of this.corpora) {
      if (this.characters <= MAX_CACHED_CHARACTERS) break;
      if (held.size === 0) continue;
      this.corpora.delete(id);
      this.characters -= held.size;
    }
  }
}

function corpusSize(corpus: SearchCorpus): number {
  return corpus.entries.reduce((sum, entry) => sum + entry.text.length, 0);
}

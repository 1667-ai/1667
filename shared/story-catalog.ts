import type { StorySummary } from "./types.js";

export interface ListStoriesPageInput {
  readonly cursor: string | null;
  readonly maxEntries: number;
}

export interface StoryCatalogPage {
  readonly scanId: string;
  readonly items: StorySummary[];
  readonly cursor: string | null;
  readonly done: boolean;
}

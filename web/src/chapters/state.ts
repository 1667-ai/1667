import type { RemovedChapterBreak } from "../../../client/api.js";

/**
 * Chapter state that lives outside the story payload (#409 step 7a): what `u`
 * can take back, the one inline rename, and the one chapter summary that is
 * running. The summary run lives at the top level (like a generation) because
 * it outlives the reader leaving the story it targets.
 */

/** What `u` can take back. Only chapter-break changes are in it, like the TUI:
 * never a rename, a summary edit, or prose. */
export type ChapterUndoEntry =
  | { readonly kind: "added"; readonly breakId: string }
  | { readonly kind: "removed"; readonly breakId: string; readonly removed: RemovedChapterBreak };

export interface SummaryRun {
  readonly storyId: string;
  readonly storyTitle: string;
  readonly breakId: string;
  readonly chapterNumber: number;
  /** A summary of this chapter already stands in; this run replaces it. */
  readonly refresh: boolean;
  /** `stopping` after Stop or Esc, until the answer or the reload arrives. */
  readonly phase: "running" | "stopping";
}

/** The one open inline rename. `breakId` is `null` for chapter one, which no
 * break opens. `origin` says which surface shows the input (the manuscript or
 * the panel), so two inputs never share one draft. */
export interface ChapterRename {
  readonly storyId: string;
  readonly breakId: string | null;
  readonly text: string;
  readonly origin: "manuscript" | "panel";
  readonly saving: boolean;
}

export interface ChaptersState {
  readonly undo: Readonly<Record<string, readonly ChapterUndoEntry[]>>;
  readonly rename: ChapterRename | null;
  readonly summaryRun: SummaryRun | null;
}

export function initialChaptersState(): ChaptersState {
  return { undo: {}, rename: null, summaryRun: null };
}

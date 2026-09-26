import type { ChapterDividerRow, StoryChapter } from "../../../shared/manuscript-model.js";

/**
 * Display only — chapter chrome carries no keyboard focus (`[/]` jump to the
 * chapter's first part instead, in `app/keymap.ts`). Ported from
 * `~/source/storytavern/web/src/ChapterDivider.tsx`'s static heading/divider
 * markup; the menu (rename/create/summarize) that file also renders is
 * write-side and stays out of this read-only step.
 */

/** Chapter one has no break to open it, so its name shows once, above the
 * first part — only worth the ink once a second chapter exists (a
 * single-chapter story has nothing to name). */
export function ChapterOneHeading({ chapters }: { readonly chapters: readonly StoryChapter[] }) {
  if (chapters.length <= 1) return null;
  const first = chapters[0];
  if (first === undefined) return null;
  return (
    <li className="chapter-one-heading" aria-hidden="true">
      <span />
      <strong>{chapterTitle(first)}</strong>
      <span />
    </li>
  );
}

export function ChapterDivider({ row }: { readonly row: ChapterDividerRow }) {
  return (
    <li className="chapter-divider" aria-hidden="true">
      <div className="chapter-divider-kicker">
        <span />
        <strong>Chapter {row.openingChapter.number}</strong>
        <span />
      </div>
      <div className={`chapter-title${row.openingChapter.title.trim().length === 0 ? " untitled" : ""}`}>
        {row.openingChapter.title.trim().length === 0 ? "Untitled chapter" : row.openingChapter.title}
      </div>
      <div className="chapter-divider-meta">
        {row.closingChapter.parts.length} {row.closingChapter.parts.length === 1 ? "part" : "parts"} above
      </div>
    </li>
  );
}

function chapterTitle(chapter: StoryChapter): string {
  return chapter.title.trim().length === 0 ? "Chapter One" : chapter.title;
}

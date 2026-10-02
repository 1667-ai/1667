import type { ChapterDividerRow, StoryChapter } from "../../../shared/manuscript-model.js";
import { chapterWord } from "../../../shared/chapter-labels.js";
import { ChapterMenu } from "../chapters/ChapterMenu.js";
import { ChapterTitle } from "../chapters/ChapterTitle.js";

/**
 * Chapter chrome in the manuscript. It carries no roving part focus (`[` and
 * `]` jump to a chapter's first part): its controls are plain buttons — the
 * title opens the inline rename, `···` opens the chapter menu. Ported from
 * `~/source/storytavern/web/src/ChapterDivider.tsx`.
 */

/** Chapter one has no break to open it, so its name shows once, above the
 * first part — only worth the ink once a second chapter exists (a
 * single-chapter story has nothing to name). */
export function ChapterOneHeading(
  { storyId, chapters }: { readonly storyId: string; readonly chapters: readonly StoryChapter[] }
) {
  if (chapters.length <= 1) return null;
  const first = chapters[0];
  if (first === undefined) return null;
  return (
    <li className="chapter-one-heading">
      <span />
      <ChapterTitle
        storyId={storyId}
        breakId={null}
        title={first.title}
        placeholder="Chapter One"
        origin="manuscript"
        className="chapter-one-title"
      />
      <span />
    </li>
  );
}

export function ChapterDivider({ storyId, row }: { readonly storyId: string; readonly row: ChapterDividerRow }) {
  const parts = row.closingChapter.parts.length;
  return (
    <li className="chapter-divider">
      <div className="chapter-divider-kicker">
        <span />
        <strong>Chapter {chapterWord(row.openingChapter.number)}</strong>
        <span />
      </div>
      <ChapterTitle
        storyId={storyId}
        breakId={row.break.id}
        title={row.openingChapter.title}
        placeholder="Untitled chapter"
        origin="manuscript"
        className="chapter-title"
      />
      <div className="chapter-divider-meta">{parts} {parts === 1 ? "part" : "parts"} above</div>
      <ChapterMenu storyId={storyId} breakId={row.break.id} />
    </li>
  );
}

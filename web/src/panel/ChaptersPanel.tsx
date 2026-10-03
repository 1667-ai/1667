import { useEffect, useState } from "react";
import { chapterDisplayTitle, extentLabel } from "../../../shared/chapter-labels.js";
import { type StoryChapter } from "../../../shared/manuscript-model.js";
import { manuscriptModelOf } from "../story/manuscript-model.js";
import { formatTokens } from "../../../shared/tokens.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { ChapterTitle } from "../chapters/ChapterTitle.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { Icon, ICONS } from "../ui/icons.js";

/** What a chapter's row says about its summary. */
function summaryState(chapter: StoryChapter, running: boolean): { readonly text: string; readonly tone: string } {
  if (running) return { text: "Summarizing…", tone: "" };
  if (chapter.closedBy === null) return { text: "Current", tone: "" };
  if (chapter.summary === null) return { text: "Raw", tone: "" };
  return chapter.stale ? { text: "Stale", tone: " stale" } : { text: "✓ stands in", tone: " ok" };
}

/** The panel's chapter list: number, title, parts, size, and summary state.
 * The keys (↑↓, Enter, e, r, D, n) are handled by `StoryPanel`, which owns the
 * keyboard; `cursor` is the selected row, shared with it. */
export function ChaptersPanel(
  { payload, cursor, onCursor, onJump }: {
    readonly payload: StoryPayload;
    readonly cursor: number;
    readonly onCursor: (index: number) => void;
    readonly onJump: (chapter: StoryChapter) => void;
  }
) {
  const { store, actions } = useAppContext();
  const run = useStore(store, (state) => state.chapters.summaryRun);
  const renaming = useStore(store, (state) => (
    state.chapters.rename?.origin === "panel" ? state.chapters.rename.breakId : undefined
  ));
  const focusedPartId = useStore(store, (state) => (
    state.story.kind === "loaded" ? effectiveFocusedPartId(state.story) : null
  ));
  const chapters = manuscriptModelOf(payload).chapters;
  const [selectedRow, setSelectedRow] = useState<HTMLElement | null>(null);

  useEffect(() => { selectedRow?.scrollIntoView({ block: "nearest" }); }, [selectedRow, cursor]);

  return (
    <ol className="panel-list" aria-label="Chapters">
      {chapters.map((chapter, index) => {
        const here = focusedPartId !== null && chapter.parts.some((part) => part.id === focusedPartId);
        const selected = index === cursor;
        const state = summaryState(chapter, run !== null && run.storyId === payload.id && run.breakId === chapter.closedBy?.id);
        const isRenaming = renaming !== undefined && renaming === chapter.openingBreakId;
        return (
          <li
            key={chapter.openingBreakId ?? "chapter-one"}
            ref={selected ? setSelectedRow : undefined}
            className={`panel-row${selected ? " selected" : ""}${here ? " here" : ""}`}
            aria-current={selected ? "true" : undefined}
            onClick={(event) => {
              // A click in the rename input is typing, not a jump.
              if (event.target instanceof HTMLInputElement) return;
              onCursor(index);
              onJump(chapter);
            }}
          >
            <span className="panel-row-number">{chapter.number}</span>
            <div className="panel-row-main">
              {isRenaming
                ? (
                  <ChapterTitle
                    storyId={payload.id}
                    breakId={chapter.openingBreakId}
                    title={chapter.title}
                    placeholder={chapterDisplayTitle(chapter, payload.title)}
                    origin="panel"
                    className="panel-row-title"
                  />
                )
                : <span className="panel-row-title">{chapterDisplayTitle(chapter, payload.title)}</span>}
              <span className="panel-row-meta">
                {extentLabel(chapter)} · ~{formatTokens(chapter.rawTokens)} tokens
              </span>
              <span className={`panel-row-state${state.tone}`}>{state.text}</span>
            </div>
            {selected && (
              <div className="panel-row-actions" onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="icon-btn"
                  title="Rename (e)"
                  aria-label="Rename (e)"
                  onClick={() => actions.chapters.startRename(chapter.openingBreakId, "panel")}
                >
                  <Icon path={ICONS.penLine} />
                </button>
                {chapter.closedBy !== null && (
                  <button
                    type="button"
                    className="icon-btn"
                    title={chapter.summary === null ? "Summarize (r)" : "Refresh summary (r)"}
                    aria-label={chapter.summary === null ? "Summarize (r)" : "Refresh summary (r)"}
                    onClick={() => { void actions.chapters.summarize(chapter.number); }}
                  >
                    <Icon path={ICONS.summary} />
                  </button>
                )}
                {chapter.openingBreakId !== null && (
                  <button
                    type="button"
                    className="icon-btn"
                    title="Remove break (D)"
                    aria-label="Remove break (D)"
                    onClick={() => { void actions.chapters.removeBreak(chapter.openingBreakId!); }}
                  >
                    <Icon path={ICONS.trash} />
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

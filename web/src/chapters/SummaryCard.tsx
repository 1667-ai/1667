import { useState } from "react";
import { chapterWord } from "../../../shared/chapter-labels.js";
import type { StoryChapter } from "../../../shared/manuscript-model.js";
import { formatTokens } from "../../../shared/tokens.js";
import type { NodeStub } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { PartEditor } from "../editor/PartEditor.js";
import { Prose } from "../story/Prose.js";
import { Icon, ICONS } from "../ui/icons.js";

/**
 * A chapter's summary under its last part: collapsed by default, showing the
 * size and whether it still stands in for the chapter. Expanded, it shows the
 * text with Edit and Refresh. While a summary runs, the card is a placeholder
 * with a caret; the text appears when the run is done. Edit uses the one
 * inline editor in its `summary` mode.
 */
export function SummaryCard(
  { chapter, summary, running }: {
    readonly chapter: StoryChapter;
    /** `null` while the first summary of the chapter is being written. */
    readonly summary: NodeStub | null;
    readonly running: boolean;
  }
) {
  const { store, actions } = useAppContext();
  const [expanded, setExpanded] = useState(false);
  const editing = useStore(store, (state) => (
    state.editor !== null && state.editor.mode === "summary" && summary !== null && state.editor.summary.id === summary.id
  ));
  const word = chapterWord(chapter.number);
  const breakId = chapter.closedBy?.id ?? null;

  if (running || summary === null) {
    return (
      <li className="summary-card summary-card-running">
        <div className="summary-card-head">
          <Icon path={ICONS.summary} />
          <span className="summary-card-title">Summarizing Chapter {word}…</span>
          <span className="caret" aria-hidden="true" />
        </div>
      </li>
    );
  }

  const open = expanded || editing;
  return (
    <li className="summary-card">
      <button
        type="button"
        className="summary-card-head summary-card-toggle"
        aria-expanded={open}
        title={open ? "Hide summary" : "Show summary"}
        onClick={() => setExpanded(!open)}
      >
        <Icon path={ICONS.summary} />
        <span className="summary-card-title">Chapter {word} summary</span>
        <span className="summary-card-meta">~{formatTokens(summary.tokens)} tokens</span>
        <span className={`summary-card-state${chapter.stale ? " stale" : ""}`}>
          {chapter.stale ? "Stale" : "✓ stands in"}
        </span>
      </button>
      {open && (
        <div className="summary-card-body">
          {editing
            ? <PartEditor partNumber={0} showDirections={false} />
            : (
              <>
                <Prose text={summary.text ?? ""} humanEdit={null} />
                <div className="summary-card-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    title="Edit summary"
                    onClick={() => { if (breakId !== null) actions.editor.openSummary(breakId); }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    title="Refresh summary"
                    onClick={() => { void actions.chapters.summarize(chapter.number); }}
                  >
                    Refresh
                  </button>
                </div>
              </>
            )}
        </div>
      )}
    </li>
  );
}

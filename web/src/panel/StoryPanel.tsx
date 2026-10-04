import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { type StoryChapter } from "../../../shared/manuscript-model.js";
import { manuscriptModelOf } from "../story/manuscript-model.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import { focusCurrentPart } from "../story/focus-dom.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { Icon, ICONS } from "../ui/icons.js";
import { FactsPanel } from "../facts/FactsPanel.js";
import { visibleFacts } from "../facts/rows.js";
import { ChaptersPanel } from "./ChaptersPanel.js";
import { findingRows } from "../factcheck/model.js";
import { FindingsPanel } from "../factcheck/FindingsPanel.js";
import { handleFactsKey } from "./facts-keys.js";

/** The width from which the panel is docked beside the manuscript; below it
 * the panel is a drawer (keep in step with `styles/panel.css`). */
const DOCKED_QUERY = "(min-width: 1200px)";

function useDockedLayout(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(DOCKED_QUERY);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(DOCKED_QUERY).matches
  );
}

const TITLES = { chapters: "Chapters", facts: "Facts", findings: "Findings" } as const;

export const CHAPTER_ONE_NO_BREAK_TOAST = "Chapter One has no break to remove.";

/**
 * The story's right-hand panel, with a Chapters view and a Facts view. It
 * owns the keyboard while it has focus (`data-owns-keys`), so the
 * manuscript's keys stay quiet. `F` docks the Facts view beside the manuscript
 * without taking the keyboard (docked layout only). Chapters keys: ↑↓ move, Enter goes to the chapter's first part,
 * `e` renames, `r` summarizes, `D` removes the break, `n` ends a chapter at
 * the focused part, Esc closes (or stops a running summary first).
 */
export function StoryPanel({ payload }: { readonly payload: StoryPayload }) {
  const { store, actions } = useAppContext();
  const requested = useStore(store, (state) => state.panel.view);
  const openSerial = useStore(store, (state) => state.panel.openSerial);
  const factsDocked = useStore(store, (state) => state.panel.factsDocked);
  const docked = useDockedLayout();
  // A docked Facts view shows without being asked for; the drawer layout has
  // no room for that, so it only opens on request.
  const view = requested ?? (factsDocked && docked ? "facts" : null);
  const asideRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [cursor, setCursor] = useState(0);
  const [factId, setFactId] = useState<string | null>(null);
  const [findingCursor, setFindingCursor] = useState(0);
  const findings = useStore(store, (state) => state.factCheck.findings);
  const findingsHere = findings !== null && findings.storyId === payload.id ? findings : null;
  const filter = useStore(store, (state) => state.facts.filter);
  const editorOpen = useStore(store, (state) => state.facts.editor !== null && state.facts.editor.storyId === payload.id);
  const picking = useStore(store, (state) => state.facts.pick !== null);
  const factRows = visibleFacts(payload, filter);
  const factCursor = Math.max(0, factRows.findIndex((fact) => fact.id === factId));

  // On opening (or switching view by key), the panel takes the keyboard; the
  // selected chapter is the one being read.
  useEffect(() => {
    if (requested === null) return;
    if (requested === "chapters") {
      const story = store.get().story;
      const focusedId = story.kind === "loaded" ? effectiveFocusedPartId(story) : null;
      const here = manuscriptModelOf(payload).parts.find((part) => part.id === focusedId)?.chapterNumber ?? 1;
      setCursor(Math.max(0, here - 1));
    }
    // A text field inside the panel (the fact editor's name) already took the
    // keyboard: a child's effect runs before this one, and the panel must not
    // take it back. A clicked tab button keeps nothing: the panel's keys need
    // the focus on the panel.
    const aside = asideRef.current;
    const active = document.activeElement;
    const fieldInside = aside !== null && active !== null && aside.contains(active)
      && active.matches("input, textarea, select, [contenteditable='true']");
    if (aside !== null && !fieldInside) aside.focus();
    // Only when the view changes: a later change to the story must not move the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, openSerial]);

  if (view === null) return null;
  const hiddenByDock = requested === null;
  const chapters = manuscriptModelOf(payload).chapters;
  const selected = chapters[Math.min(cursor, chapters.length - 1)];

  const close = (): void => {
    actions.panel.close();
    focusCurrentPart();
  };

  const jump = (chapter: StoryChapter): void => {
    const target = chapter.parts[0] ?? chapter.parts.at(-1);
    if (target !== undefined) actions.story.focusPart(target.id);
    // The story view moves the keyboard onto the part once the drawer is gone.
    if (!window.matchMedia(DOCKED_QUERY).matches) actions.panel.close();
  };

  const endChapterHere = (): void => {
    const story = store.get().story;
    const partId = story.kind === "loaded" ? effectiveFocusedPartId(story) : null;
    if (partId === null) return;
    // The new divider's title field opens in the manuscript; a drawer would
    // cover it and keep the keys.
    if (!window.matchMedia(DOCKED_QUERY).matches) actions.panel.close();
    actions.part.run("end-chapter", partId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (view === "facts") {
      handleFactsKey(event, {
        actions, rows: factRows, cursor: factCursor, filterRef, editorOpen, picking, close,
        setCursor: (index) => setFactId(factRows[index]?.id ?? null)
      });
      return;
    }
    if (view === "findings") {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const rows = findingsHere === null ? [] : findingRows(findingsHere.run, payload);
      const index = Math.min(findingCursor, Math.max(0, rows.length - 1));
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setFindingCursor(Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
      } else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        const row = rows[index];
        if (row !== undefined) actions.factCheck.select(row);
      }
      return;
    }
    // A field inside (a rename) handles its own keys.
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.target instanceof HTMLInputElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const handled = (): void => event.preventDefault();
    // A held key must not repeat an action (Shift+D would remove break after
    // break); only the arrows repeat.
    if (event.repeat && event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      handled();
      return;
    }
    switch (event.key) {
      case "Escape":
        handled();
        if (!actions.chapters.stopSummary()) close();
        return;
      case "ArrowDown": handled(); setCursor(Math.min(chapters.length - 1, cursor + 1)); return;
      case "ArrowUp": handled(); setCursor(Math.max(0, cursor - 1)); return;
      case "Enter":
        if (event.target instanceof HTMLButtonElement) return;
        handled();
        if (selected !== undefined) jump(selected);
        return;
      case "e":
        handled();
        if (selected !== undefined) actions.chapters.startRename(selected.openingBreakId, "panel");
        return;
      case "r":
        handled();
        if (selected !== undefined) void actions.chapters.summarize(selected.number);
        return;
      case "D":
        handled();
        if (selected?.openingBreakId == null) pushToast(store, CHAPTER_ONE_NO_BREAK_TOAST);
        else void actions.chapters.removeBreak(selected.openingBreakId);
        return;
      case "n": {
        handled();
        endChapterHere();
        return;
      }
      default:
    }
  };

  return (
    <>
      <button type="button" className="panel-backdrop" aria-label={`Close ${TITLES[view].toLowerCase()}`} tabIndex={-1} onClick={close} />
      <aside
        ref={asideRef}
        className="story-panel"
        role="complementary"
        aria-label={TITLES[view]}
        tabIndex={-1}
        data-owns-keys
        onKeyDown={onKeyDown}
      >
        <header className="panel-head">
          <div className="seg" role="group" aria-label="Panel view">
            {(["chapters", "facts", ...(findingsHere !== null || view === "findings" ? ["findings" as const] : [])] as const).map((name) => (
              <button
                key={name}
                type="button"
                className="seg-btn"
                aria-pressed={view === name}
                title={name === "chapters" ? "Chapters (c)" : name === "facts" ? "Facts (f)" : "The last Fact check"}
                onClick={() => actions.panel.open(name)}
              >
                {TITLES[name]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn"
            title={hiddenByDock ? "Hide (F)" : "Close (Esc)"}
            aria-label={hiddenByDock ? "Hide (F)" : "Close (Esc)"}
            onClick={hiddenByDock ? actions.panel.toggleFactsDock : close}
          >
            <Icon path={ICONS.x} />
          </button>
        </header>
        <div className="panel-body">
          {view === "chapters"
            ? <ChaptersPanel payload={payload} cursor={cursor} onCursor={setCursor} onJump={jump} />
            : view === "findings"
            ? <FindingsPanel payload={payload} cursor={findingCursor} onCursor={setFindingCursor} />
            : (
              <FactsPanel
                payload={payload}
                rows={factRows}
                cursor={factCursor}
                onCursor={(index) => setFactId(factRows[index]?.id ?? null)}
                filterRef={filterRef}
              />
            )}
        </div>
        {view === "chapters" && (
          <footer className="panel-foot">
            <button
              type="button"
              className="btn btn-small"
              title="End chapter here (n)"
              onClick={endChapterHere}
            >
              <Icon path={ICONS.plus} />
              End chapter here
            </button>
          </footer>
        )}
      </aside>
    </>
  );
}

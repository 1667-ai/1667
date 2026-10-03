import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createManuscriptModel, type StoryChapter } from "../../../shared/manuscript-model.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import { focusCurrentPart } from "../story/focus-dom.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { Icon, ICONS } from "../ui/icons.js";
import { ChaptersPanel } from "./ChaptersPanel.js";

/** The width from which the panel is docked beside the manuscript; below it
 * the panel is a drawer (keep in step with `styles/panel.css`). */
const DOCKED_QUERY = "(min-width: 1200px)";

export const CHAPTER_ONE_NO_BREAK_TOAST = "Chapter One has no break to remove.";

/**
 * The story's right-hand panel: Chapters now, Facts later. It owns the
 * keyboard while it has focus (`data-owns-keys`), so the manuscript's keys
 * stay quiet. Chapters keys: ↑↓ move, Enter goes to the chapter's first part,
 * `e` renames, `r` summarizes, `D` removes the break, `n` ends a chapter at
 * the focused part, Esc closes (or stops a running summary first).
 */
export function StoryPanel({ payload }: { readonly payload: StoryPayload }) {
  const { store, actions } = useAppContext();
  const view = useStore(store, (state) => state.panel.view);
  const asideRef = useRef<HTMLElement>(null);
  const [cursor, setCursor] = useState(0);
  const open = view !== null;

  // On opening, the selected row is the chapter being read, and the panel
  // takes the keyboard.
  useEffect(() => {
    if (!open) return;
    const story = store.get().story;
    const focusedId = story.kind === "loaded" ? effectiveFocusedPartId(story) : null;
    const model = createManuscriptModel(payload);
    const here = model.parts.find((part) => part.id === focusedId)?.chapterNumber ?? 1;
    setCursor(Math.max(0, here - 1));
    asideRef.current?.focus();
    // Only when it opens: a later change to the story must not move the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (view === null) return null;
  const chapters = createManuscriptModel(payload).chapters;
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

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // A field inside (a rename) handles its own keys.
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.target instanceof HTMLInputElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const handled = (): void => event.preventDefault();
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
        const story = store.get().story;
        const partId = story.kind === "loaded" ? effectiveFocusedPartId(story) : null;
        if (partId !== null) actions.part.run("end-chapter", partId);
        return;
      }
      default:
    }
  };

  return (
    <>
      <button type="button" className="panel-backdrop" aria-label="Close chapters" tabIndex={-1} onClick={close} />
      <aside
        ref={asideRef}
        className="story-panel"
        role="complementary"
        aria-label="Chapters"
        tabIndex={-1}
        data-owns-keys
        onKeyDown={onKeyDown}
      >
        <header className="panel-head">
          <h2 className="panel-title">Chapters</h2>
          <button type="button" className="icon-btn" title="Close (Esc)" aria-label="Close (Esc)" onClick={close}>
            <Icon path={ICONS.x} />
          </button>
        </header>
        <div className="panel-body">
          <ChaptersPanel payload={payload} cursor={cursor} onCursor={setCursor} onJump={jump} />
        </div>
        <footer className="panel-foot">
          <button
            type="button"
            className="btn btn-small"
            title="End chapter here (n)"
            onClick={() => {
              const story = store.get().story;
              const partId = story.kind === "loaded" ? effectiveFocusedPartId(story) : null;
              if (partId !== null) actions.part.run("end-chapter", partId);
            }}
          >
            <Icon path={ICONS.plus} />
            End chapter here
          </button>
        </footer>
      </aside>
    </>
  );
}

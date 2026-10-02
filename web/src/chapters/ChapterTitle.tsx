import { useEffect, useRef, type KeyboardEvent } from "react";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { focusCurrentPart } from "../story/focus-dom.js";
import type { ChapterRename } from "./state.js";

/**
 * A chapter's title: a button that opens the one inline rename, or — while
 * the rename is open on this surface — the input. Enter saves, Esc cancels,
 * and a save that fails keeps the typed text. The draft lives in the store
 * (`chapters.rename`), so the manuscript and the panel never share an input.
 */
export function ChapterTitle(
  { storyId, breakId, title, placeholder, origin, className }: {
    readonly storyId: string;
    /** `null` for chapter one, which no break opens. */
    readonly breakId: string | null;
    readonly title: string;
    /** Shown, dimmed, when the chapter has no title. */
    readonly placeholder: string;
    readonly origin: ChapterRename["origin"];
    readonly className: string;
  }
) {
  const { store, actions } = useAppContext();
  const rename = useStore(store, (state) => {
    const current = state.chapters.rename;
    return current !== null && current.storyId === storyId && current.breakId === breakId && current.origin === origin
      ? current
      : null;
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = rename !== null;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    inputRef.current?.scrollIntoView({ block: "nearest" });
  }, [editing]);

  if (rename === null) {
    return (
      <button
        type="button"
        className={`${className} chapter-title-button${title.trim().length === 0 ? " untitled" : ""}`}
        title="Rename chapter"
        onClick={() => actions.chapters.startRename(breakId, origin)}
      >
        {title.trim().length === 0 ? placeholder : title}
      </button>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void actions.chapters.saveRename().then(() => {
        if (store.get().chapters.rename === null && origin === "manuscript") focusCurrentPart();
      });
    } else if (event.key === "Escape") {
      event.preventDefault();
      actions.chapters.cancelRename();
      if (origin === "manuscript") focusCurrentPart();
    }
  };

  return (
    <input
      ref={inputRef}
      className="chapter-title-input"
      data-owns-keys
      aria-label="Chapter title"
      placeholder={placeholder}
      value={rename.text}
      disabled={rename.saving}
      onChange={(event) => actions.chapters.setRenameText(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={actions.chapters.blurRename}
    />
  );
}

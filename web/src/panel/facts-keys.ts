import type { KeyboardEvent, RefObject } from "react";
import type { ContentActions } from "../app/content-actions.js";
import type { StoryFact } from "../../../shared/types.js";

export interface FactsKeyContext {
  readonly actions: ContentActions;
  readonly rows: readonly StoryFact[];
  readonly cursor: number;
  readonly setCursor: (index: number) => void;
  readonly filterRef: RefObject<HTMLInputElement | null>;
  readonly editorOpen: boolean;
  readonly picking: boolean;
  readonly close: () => void;
}

/**
 * The Facts view's keys, for `StoryPanel`'s keyboard: ↑↓ move, Shift+↑↓
 * reorder, Enter or `e` opens, `n` adds, `/` filters, Esc closes (or ends the
 * pick). A field handles its own keys, except the filter, which Enter and Esc
 * hand back to the list.
 */
export function handleFactsKey(event: KeyboardEvent<HTMLElement>, context: FactsKeyContext): void {
  const { actions, rows, cursor, setCursor, filterRef, editorOpen, picking, close } = context;
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  const target = event.target as HTMLElement;
  const inFilter = target === filterRef.current;
  if (!inFilter && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const handled = (): void => event.preventDefault();
  const selected = rows[Math.min(cursor, rows.length - 1)];

  if (inFilter) {
    if (event.key === "Escape") {
      handled();
      if (filterRef.current!.value.length > 0) actions.facts.setFilter({ query: "" });
      event.currentTarget.focus();
    } else if (event.key === "Enter") {
      handled();
      event.currentTarget.focus();
    }
    return;
  }
  if (editorOpen) {
    if (event.key === "Escape") {
      handled();
      actions.facts.requestClose();
    }
    return;
  }
  // A held key must not repeat an action; only the arrows repeat.
  if (event.repeat && event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    handled();
    return;
  }
  const open = (): void => {
    if (selected === undefined) return;
    if (picking) void actions.facts.pickFact(selected.id);
    else actions.facts.open(selected.id);
  };
  switch (event.key) {
    case "Escape":
      handled();
      if (picking) actions.facts.cancelPick();
      else close();
      return;
    case "ArrowDown":
    case "ArrowUp": {
      handled();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (event.shiftKey && selected !== undefined) {
        // Pin the selection to this fact, so it follows the fact to its new place.
        setCursor(cursor);
        void actions.facts.move(selected.id, direction);
      } else setCursor(Math.max(0, Math.min(rows.length - 1, cursor + direction)));
      return;
    }
    case "Enter":
      if (target instanceof HTMLButtonElement) return;
      handled();
      open();
      return;
    case "e":
      handled();
      open();
      return;
    case "n":
      handled();
      actions.facts.openNew();
      return;
    case "/":
      handled();
      filterRef.current?.focus();
      return;
    default:
  }
}

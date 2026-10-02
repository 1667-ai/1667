import { useEffect, useRef, type KeyboardEvent } from "react";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { focusCurrentPart } from "../story/focus-dom.js";
import { NOT_CONNECTED_TOAST, storyChangeRefusal } from "../story/story-policy.js";
import { Icon, ICONS } from "../ui/icons.js";
import { usePopover } from "../ui/usePopover.js";

/** A disabled item's hover text: a few words. */
function shortRefusal(refusal: string): string {
  return refusal === NOT_CONNECTED_TOAST ? "Not connected" : "Busy (Esc)";
}

/**
 * The `···` menu on a chapter divider: rename the chapter, remove the break.
 * It uses the one menu look. Removing is immediate — `u` undoes it.
 */
export function ChapterMenu({ storyId, breakId }: { readonly storyId: string; readonly breakId: string }) {
  const { store, actions } = useAppContext();
  const { open, setOpen, containerRef } = usePopover();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closedByItem = useRef(false);
  const wasOpen = useRef(false);
  // Only an open menu follows the state.
  const refusal = useStore(store, (state) => (open ? storyChangeRefusal(state, storyId) : null));

  useEffect(() => {
    if (open) {
      closedByItem.current = false;
      listRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    } else if (wasOpen.current && !closedByItem.current) {
      triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const choose = (action: () => void): void => {
    closedByItem.current = true;
    setOpen(false);
    action();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (at + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (at - 1 + buttons.length) % buttons.length;
    if (next === null || buttons.length === 0) return;
    event.preventDefault();
    buttons[next]!.focus();
  };

  return (
    <div className="chapter-menu" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="icon-btn"
        title="Chapter actions"
        aria-label="Chapter actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon path={ICONS.dots} />
      </button>
      {open && (
        <div className="menu chapter-menu-popover" role="menu" aria-label="Chapter actions" data-owns-keys ref={listRef} onKeyDown={onKeyDown}>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            title="Rename"
            onClick={() => choose(() => actions.chapters.startRename(breakId, "manuscript"))}
          >
            <Icon path={ICONS.penLine} />
            <span className="menu-item-text">Rename</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-item-danger"
            title={refusal === null ? "Remove break" : shortRefusal(refusal)}
            disabled={refusal !== null}
            onClick={() => choose(() => { void actions.chapters.removeBreak(breakId).then(focusCurrentPart); })}
          >
            <Icon path={ICONS.trash} />
            <span className="menu-item-text">Remove break</span>
          </button>
        </div>
      )}
    </div>
  );
}

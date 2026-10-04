import { useEffect, useRef, type KeyboardEvent } from "react";
import { useAppContext } from "../app/context.js";
import { Icon, ICONS } from "../ui/icons.js";
import { usePopover } from "../ui/usePopover.js";

/**
 * The "Use" menu of one Aside answer: Copy, Insert into compose (at the
 * composer's caret), Insert into story… (pick a place), Insert as new Fact.
 * Enter on a selected turn opens it (`keys.ts` clicks the trigger).
 */
export function AsideUseMenu({ answer, disabled }: { readonly answer: string; readonly disabled: boolean }) {
  const { actions } = useAppContext();
  const { open, setOpen, containerRef } = usePopover();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closedByItem = useRef(false);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      closedByItem.current = false;
      const first = listRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      first?.focus();
      listRef.current?.scrollIntoView({ block: "nearest" });
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
    <div className="aside-use" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="btn btn-small btn-ghost aside-use-trigger"
        title="Use this answer (Enter)"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Icon path={ICONS.arrowRight} />
        Use
      </button>
      {open && (
        <div className="menu aside-use-popover" role="menu" aria-label="Use this answer" data-owns-keys ref={listRef} onKeyDown={onKeyDown}>
          <button type="button" role="menuitem" className="menu-item" onClick={() => choose(() => { void actions.aside.copyAnswer(answer); })}>
            <Icon path={ICONS.summary} />
            <span className="menu-item-text">Copy</span>
          </button>
          <button type="button" role="menuitem" className="menu-item" title="At the composer's caret" onClick={() => choose(() => actions.aside.insertIntoCompose(answer))}>
            <Icon path={ICONS.squarePen} />
            <span className="menu-item-text">Insert into compose</span>
          </button>
          <button type="button" role="menuitem" className="menu-item" title="Pick a place in the story" onClick={() => choose(() => actions.aside.startPlacement(answer))}>
            <Icon path={ICONS.signpost} />
            <span className="menu-item-text">Insert into story…</span>
          </button>
          <button type="button" role="menuitem" className="menu-item" title="Edit it as a Fact first" onClick={() => choose(() => actions.aside.insertAsFact(answer))}>
            <Icon path={ICONS.facts} />
            <span className="menu-item-text">Insert as new Fact</span>
          </button>
        </div>
      )}
    </div>
  );
}

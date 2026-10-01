import { useEffect, useRef, type KeyboardEvent } from "react";
import { partActions, type PartActionId } from "../../../shared/part-actions.js";
import type { StoryPart } from "../../../shared/manuscript-model.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Icon, ICONS } from "../ui/icons.js";
import { usePopover } from "../ui/usePopover.js";
import { partActionRefusal } from "./part-policy.js";
import { useRequestSignal } from "../ui/useRequestSignal.js";

interface MenuItem {
  readonly id: PartActionId;
  readonly label: string;
  /** The key that does the same thing, shown in the hover text. */
  readonly key: string;
  readonly danger?: boolean;
}

/** The TUI's part actions (`shared/part-actions.ts`) that the web UI has,
 * in the TUI's order. Which of them one part offers comes from
 * `partActions` itself. */
const ITEMS: readonly MenuItem[] = [
  { id: "continue", label: "Continue", key: "Space" },
  { id: "direct", label: "Direct", key: "i" },
  { id: "retake", label: "Retake", key: "r" },
  { id: "retake-with-prompt", label: "Retake with direction", key: "R" },
  { id: "write", label: "Write", key: "w" },
  { id: "edit", label: "Edit", key: "e" },
  { id: "prune", label: "Delete", key: "D", danger: true }
];

/**
 * The `···` menu in a part's header (the TUI's `x`): every action a part
 * offers, for the writer who does not know the keys. Each item asks the one
 * policy (`partActionRefusal`) while the menu is open — a refused item is
 * disabled and its hover text is the reason — and a click goes through the
 * same dispatcher the keys use. `menuSerial` is raised by the `x` key.
 */
export function PartActionsMenu(
  { part, isLeaf, disabled, menuSerial }: {
    readonly part: StoryPart;
    readonly isLeaf: boolean;
    /** The editor sits in this part: nothing in the menu applies. */
    readonly disabled: boolean;
    readonly menuSerial: number;
  }
) {
  const { store, actions } = useAppContext();
  const { open, setOpen, containerRef } = usePopover();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closedByItem = useRef(false);
  const wasOpen = useRef(false);
  // Only an open menu follows the whole state; a closed one costs nothing on
  // each streamed frame.
  const state = useStore(store, (current) => (open ? current : null));

  useRequestSignal(menuSerial, () => setOpen(true));

  useEffect(() => {
    if (open) {
      closedByItem.current = false;
      listRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    } else if (wasOpen.current && !closedByItem.current) {
      // Escape or an outside press: the keyboard goes back to the trigger.
      triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const available = new Set(partActions(part.node, isLeaf).map((action) => action.id));
  const items = ITEMS.filter((item) => available.has(item.id));

  const run = (id: PartActionId): void => {
    closedByItem.current = true;
    setOpen(false);
    actions.part.run(id, part.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (at + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (at - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next === null || buttons.length === 0) return;
    event.preventDefault();
    buttons[next]!.focus();
  };

  return (
    <div className="part-menu" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="icon-btn part-menu-trigger"
        aria-label="Part actions (x)"
        title="Part actions (x)"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Icon path={ICONS.dots} />
      </button>
      {open && (
        <div className="part-menu-popover" role="menu" aria-label={`Actions for part ${part.number}`} data-owns-keys ref={listRef} onKeyDown={onKeyDown}>
          {items.map((item) => {
            const refusal = state === null ? null : partActionRefusal(state, part.id, item.id);
            return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`part-menu-item${item.danger === true ? " part-menu-danger" : ""}`}
              title={refusal ?? `${item.label} (${item.key})`}
              disabled={refusal !== null}
              onClick={() => run(item.id)}
            >
              {item.label}
              <span className="part-menu-key" aria-hidden="true">{item.key}</span>
            </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

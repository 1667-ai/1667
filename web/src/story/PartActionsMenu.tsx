import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { partActions } from "../../../shared/part-actions.js";
import type { StoryPart } from "../../../shared/manuscript-model.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Icon, ICONS } from "../ui/icons.js";
import { usePopover } from "../ui/usePopover.js";
import {
  EDITOR_OPEN_TOAST,
  NOT_CONNECTED_TOAST,
  PART_SWITCHING_TOAST,
  PART_UNAVAILABLE_TOAST,
  PART_WRITING_TOAST,
  partActionRefusal,
  type WebPartActionId,
  FACT_EDITOR_BUSY_TOAST,
  NO_FACTS_TOAST,
  STORY_LOCKED_TOAST,
  SUMMARY_RETAKE_TOAST,
  UNSAVED_TOAST
} from "./part-policy.js";
import { SUMMARY_LOCKED_TOAST } from "../app/run-lock.js";
import { STATES_UNAVAILABLE_TOAST } from "../facts/state.js";
import { useRequestSignal } from "../ui/useRequestSignal.js";
import { selectionInPart, type PartSelection } from "./selection-range.js";

interface MenuItem {
  readonly id: WebPartActionId;
  readonly label: string;
  /** The key that does the same thing, shown in the hover text. */
  readonly key: string;
  readonly icon: string;
  readonly danger?: boolean;
  /** The first item of the facts group: a heading goes above it. */
  readonly group?: "facts";
}

/** The TUI's part actions (`shared/part-actions.ts`) that the web UI has,
 * in the TUI's order. Which of them one part offers comes from
 * `partActions` itself. */
const ITEMS: readonly MenuItem[] = [
  { id: "continue", label: "Continue", key: "Space", icon: ICONS.arrowRight },
  { id: "direct", label: "Direct", key: "i", icon: ICONS.signpost },
  { id: "retake", label: "Retake", key: "r", icon: ICONS.rotate },
  { id: "retake-with-prompt", label: "Retake with direction", key: "R", icon: ICONS.message },
  { id: "write", label: "Write", key: "w", icon: ICONS.penLine },
  { id: "edit", label: "Edit", key: "e", icon: ICONS.squarePen },
  { id: "copy", label: "Copy", key: "y", icon: ICONS.copy },
  { id: "rewrite-selection", label: "Rewrite selection", key: "", icon: ICONS.pen },
  { id: "copy-line", label: "Copy story line below", key: "", icon: ICONS.copy },
  { id: "paste-line", label: "Paste story line below", key: "", icon: ICONS.paste },
  { id: "tag", label: "Tag line", key: "t", icon: ICONS.flag },
  { id: "end-chapter", label: "End chapter here", key: "C", icon: ICONS.summary },
  { id: "prune", label: "Delete", key: "D", danger: true, icon: ICONS.trash },
  { id: "fact-here", label: "Fact from here", key: "", icon: ICONS.diamond, group: "facts" },
  { id: "fact-state", label: "New fact state", key: "", icon: ICONS.plus },
  { id: "fact-end", label: "End fact here", key: "", icon: ICONS.x },
  { id: "new-fact", label: "New fact", key: "", icon: ICONS.facts },
  { id: "fact-from-selection", label: "New fact from selection", key: "", icon: ICONS.penLine }
];

/** A disabled item's hover text: a few words, where the toast for the same
 * refusal is a full sentence. */
const SHORT_REFUSAL: ReadonlyMap<string, string> = new Map([
  [STORY_LOCKED_TOAST, "Busy writing (Esc)"],
  [UNSAVED_TOAST, "Unsaved text"],
  [SUMMARY_LOCKED_TOAST, "Busy summarizing (Esc)"],
  [PART_UNAVAILABLE_TOAST, "Not on this line"],
  [PART_SWITCHING_TOAST, "Take switching"],
  [PART_WRITING_TOAST, "Still writing"],
  [SUMMARY_RETAKE_TOAST, "Not for summaries"],
  [EDITOR_OPEN_TOAST, "Editor open"],
  [NOT_CONNECTED_TOAST, "Not connected"],
  [FACT_EDITOR_BUSY_TOAST, "Fact editor open"],
  [NO_FACTS_TOAST, "No facts yet"],
  [STATES_UNAVAILABLE_TOAST, "Needs a newer backend"]
]);

/** Space kept between the menu and the edge of the scroll area, in pixels. */
const EDGE_GAP = 12;

function shortRefusal(refusal: string): string {
  // `generationBusyToast` names the other story: "Already writing in ….".
  const known = SHORT_REFUSAL.get(refusal);
  if (known !== undefined) return known;
  if (refusal.startsWith("Already writing in ")) return "Busy writing (Esc)";
  if (refusal.startsWith("Already summarizing in ")) return "Busy summarizing (Esc)";
  return refusal.endsWith("already ends here.") ? "Already ends here" : refusal;
}

/**
 * The `···` menu in a part's header (the TUI's `x`): every action a part
 * offers, for the writer who does not know the keys. Each item asks the one
 * policy (`partActionRefusal`) while the menu is open — a refused item is
 * disabled and its hover text is the short reason — and a click goes through the
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

  // The text selected in this part when the menu opens, for "New fact from
  // selection". Read once on opening: clicking a menu item may clear it.
  const [selection, setSelection] = useState("");
  // The same selection as offsets into the part's text, for "Rewrite selection".
  const [rewriteRange, setRewriteRange] = useState<PartSelection | null>(null);
  const hasCopiedLine = useStore(store, (current) => (
    current.partUi.lineClip !== null && current.story.kind === "loaded"
    && current.partUi.lineClip.storyId === current.story.payload.id
  ));
  useLayoutEffect(() => {
    if (!open) {
      setSelection("");
      setRewriteRange(null);
      return;
    }
    const selected = window.getSelection();
    const article = triggerRef.current?.closest("[data-part-id]") ?? null;
    const range = selected !== null && article !== null ? selectionInPart(article, part.node.text, selected) : null;
    const inside = selected !== null && !selected.isCollapsed && article !== null
      && article.contains(selected.anchorNode) && article.contains(selected.focusNode);
    setSelection(range !== null ? range.text : inside && selected !== null ? selected.toString() : "");
    setRewriteRange(range);
  }, [open]);

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

  const available = new Set<WebPartActionId>(partActions(part.node, isLeaf).map((action) => action.id));
  available.add("end-chapter");
  for (const id of ["fact-here", "fact-state", "fact-end", "new-fact"] as const) available.add(id);
  const hasSelection = selection.trim().length > 0;
  if (hasSelection) available.add("fact-from-selection");
  if (rewriteRange !== null) available.add("rewrite-selection");
  if (hasCopiedLine) available.add("paste-line");
  const items = ITEMS.filter((item) => available.has(item.id));

  // The menu opens on the side of the trigger with more room, and is capped
  // to that room (it scrolls inside) so it never leaves the manuscript's
  // scroll area or the window.
  const [place, setPlace] = useState<{ readonly up: boolean; readonly maxHeight: number | null }>({ up: false, maxHeight: null });
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (!open || trigger === null || list === null) return;
    const rect = trigger.getBoundingClientRect();
    const area = trigger.closest(".story-scroll")?.getBoundingClientRect();
    const top = Math.max(area?.top ?? 0, 0);
    const bottom = Math.min(area?.bottom ?? window.innerHeight, window.innerHeight);
    const below = bottom - rect.bottom - EDGE_GAP;
    const above = rect.top - top - EDGE_GAP;
    const natural = list.scrollHeight + (list.offsetHeight - list.clientHeight);
    const up = natural > below && above > below;
    const room = Math.max(0, up ? above : below);
    setPlace({ up, maxHeight: natural > room ? room : null });
  }, [open, items.length]);

  const run = (id: WebPartActionId): void => {
    closedByItem.current = true;
    setOpen(false);
    actions.part.run(
      id,
      part.id,
      id === "fact-from-selection"
        ? { selection: selection.trim() }
        : id === "copy" && hasSelection
          ? { selection }
          : id === "rewrite-selection" && rewriteRange !== null
            ? { rewrite: { start: rewriteRange.start, end: rewriteRange.end, expected: rewriteRange.text } }
            : {}
    );
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
        // A press on the button must not collapse the text selected in the
        // part: the menu reads it when it opens.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <Icon path={ICONS.dots} />
      </button>
      {open && (
        <div className={`menu part-menu-popover${place.up ? " menu-up" : ""}`} style={place.maxHeight === null ? undefined : { maxHeight: place.maxHeight, overflowY: "auto" }} role="menu" aria-label={`Actions for part ${part.number}`} data-owns-keys ref={listRef} onKeyDown={onKeyDown}>
          {items.map((item) => {
            const refusal = state === null ? null : partActionRefusal(state, part.id, item.id);
            return (
            <Fragment key={item.id}>
            {item.group === "facts" && <div className="menu-heading" role="presentation">Facts</div>}
            <button
              type="button"
              role="menuitem"
              className={`menu-item${item.danger === true ? " menu-item-danger" : ""}`}
              title={refusal === null ? (item.key === "" ? item.label : `${item.label} (${item.key})`) : shortRefusal(refusal)}
              disabled={refusal !== null}
              onClick={() => run(item.id)}
            >
              <Icon path={item.icon} />
              <span className="menu-item-text">{item.id === "copy" && hasSelection ? "Copy selection" : item.label}</span>
              <span className="menu-key" aria-hidden="true">{item.key}</span>
            </button>
            </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

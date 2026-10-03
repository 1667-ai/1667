import { useEffect, useRef, useState, type RefObject } from "react";

export interface Popover {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** Wrap BOTH the trigger and the popover in the element this ref is
   * attached to. A press or `Escape` outside that element closes the
   * popover; a press on the trigger itself is "inside" it, so nothing here
   * needs the `parentElement` DOM-nesting trick the old `ThemePicker` used
   * to reach its trigger's sibling container. */
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /** For a popover rendered through a portal (`react-dom`'s `createPortal`,
   * e.g. `story/TakePeek.tsx` — its content escapes an ancestor's
   * `overflow: hidden`/`auto` on purpose, so it is never a DOM descendant of
   * `containerRef`): attach this to the portaled root instead, so a press
   * inside it still counts as "inside" rather than closing the popover on
   * itself. Optional — a popover that never portals can ignore it. */
  readonly popoverRef: RefObject<HTMLDivElement | null>;
}

/**
 * Shared open/close-on-outside-press-or-Escape behavior for a
 * trigger-and-popover pair (review fix C9) — previously duplicated as two
 * near-identical `mousedown`/`keydown` listener pairs in
 * `library/StoryRow.tsx`'s row menu and `theme/ThemeControls.tsx`'s palette
 * picker.
 */
export function usePopover(
  controlled?: { readonly open: boolean; readonly setOpen: (open: boolean) => void }
): Popover {
  const [localOpen, setLocalOpen] = useState(false);
  // A popover whose open state lives in the store (the tag popover, which `t`
  // opens from anywhere) passes it in; both kinds close the same way.
  const open = controlled?.open ?? localOpen;
  const setOpen = controlled?.setOpen ?? setLocalOpen;
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPress = (event: MouseEvent): void => {
      const target = event.target as Node;
      const insideContainer = containerRef.current !== null && containerRef.current.contains(target);
      const insidePortaledPopover = popoverRef.current !== null && popoverRef.current.contains(target);
      if (!insideContainer && !insidePortaledPopover) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Review fix #3: without this, `app/keymap.ts`'s own global Escape
      // handler (registered on `window`, which this `document`-level
      // listener always runs before in the bubble phase) could not tell "a
      // popover just consumed this Escape" from "nothing did" — a menu
      // closing and a background generation stopping would both happen on
      // the same keypress.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return { open, setOpen, containerRef, popoverRef };
}

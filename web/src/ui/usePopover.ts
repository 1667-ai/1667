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
}

/**
 * Shared open/close-on-outside-press-or-Escape behavior for a
 * trigger-and-popover pair (review fix C9) — previously duplicated as two
 * near-identical `mousedown`/`keydown` listener pairs in
 * `library/StoryRow.tsx`'s row menu and `theme/ThemeControls.tsx`'s palette
 * picker.
 */
export function usePopover(): Popover {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPress = (event: MouseEvent): void => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, containerRef };
}

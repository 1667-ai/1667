import { useEffect, type RefObject } from "react";

/**
 * The app's keybindings beyond native browser behavior (Enter submits a
 * dialog's form, Escape closes it — both native, need no code here). Today
 * that is only `/` to focus search; later steps add more fields here and
 * more branches in the one `keydown` listener below, rather than each screen
 * wiring its own (review fix B6 — moved out of `library/Sidebar.tsx`).
 */
export interface Keymap {
  readonly searchRef: RefObject<HTMLInputElement | null>;
}

export function useKeymap(keymap: Keymap): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      event.preventDefault();
      keymap.searchRef.current?.focus();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [keymap.searchRef]);
}

import { useEffect, type RefObject } from "react";
import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import { fieldHasFocus, resolveManuscriptBinding } from "./keymap-dom.js";

/**
 * The app's keybindings beyond native browser behavior. `/` (focus search)
 * stays first and always wins, checked before any screen's own keys ever
 * get a look (owner decision — `open-search` is not itself in the TUI table
 * this reads from `app/keymap-dom.ts`'s step-6 addition on).
 *
 * A screen registers its own key handler with `registerScreenKeys` while it
 * is mounted (`story/StoryView.tsx`, the only caller so far) instead of
 * wiring its own `keydown` listener — one listener here resolves the key
 * through the TUI's own table (`shared/reference-bindings.ts`) and hands the
 * screen only the resolved `ReferenceBinding`, so a screen never touches a
 * raw `KeyboardEvent`'s key-naming quirks itself. `preventDefault` runs only
 * when the handler reports it actually did something with the key — every
 * other later-step key (the map, facts, and so on) resolves to nothing and
 * keeps its native browser behavior, exactly as an unhandled key would.
 */
export interface Keymap {
  readonly searchRef: RefObject<HTMLInputElement | null>;
}

/** Returns `true` when it handled the binding (and so `preventDefault` should
 * run) — a `ReferenceBinding` whose action this screen does not implement
 * returns `false`, the same as no binding having resolved at all. */
export type ScreenKeyHandler = (binding: ReferenceBinding, event: KeyboardEvent) => boolean;

let currentScreenHandler: ScreenKeyHandler | null = null;

/** Registers the one active screen's key handler; returns the disposer that
 * unregisters it. A later call replaces an earlier one outright (no stack —
 * only one screen is ever "current"), and unregistering a handler that has
 * already been replaced is a no-op, so an effect's cleanup running after a
 * route change never clobbers whatever the new screen just registered. */
export function registerScreenKeys(handler: ScreenKeyHandler): () => void {
  currentScreenHandler = handler;
  return () => {
    if (currentScreenHandler === handler) currentScreenHandler = null;
  };
}

export function useKeymap(keymap: Keymap): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !fieldHasFocus()) {
        event.preventDefault();
        keymap.searchRef.current?.focus();
        return;
      }
      if (currentScreenHandler === null || fieldHasFocus()) return;
      const binding = resolveManuscriptBinding(event);
      if (binding === null) return;
      if (currentScreenHandler(binding, event)) event.preventDefault();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [keymap.searchRef]);
}

import { useEffect, useRef } from "react";
import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import { pushKeyLayer } from "../app/keymap.js";

/** What the inspector pages' keys mean. They are the TUI viewers' own keys
 * (`REQUEST`, `RECORD` and `PROBS` modes), which have no rows in the shared
 * reference table. */
export type InspectAction = "up" | "down" | "left" | "right" | "next" | "top" | "end" | "cancel";

const BY_KEY: Readonly<Record<string, InspectAction>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Tab: "next",
  g: "top",
  G: "end",
  Escape: "cancel"
};

/** Tab moves to the next part only while nothing has focus; a focused button
 * or link keeps Tab for the browser, so the page never traps the keyboard. */
function nothingFocused(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || (active instanceof HTMLElement && active.dataset.inspectRoot === "true");
}

function resolveInspectKey(event: KeyboardEvent): ReferenceBinding | null {
  if (event.metaKey || event.altKey || event.ctrlKey) return null;
  const action = BY_KEY[event.key];
  if (action === undefined) return null;
  if (action === "next" && (event.shiftKey || !nothingFocused())) return null;
  // The binding shape is the key layers' own; these actions are local to the inspector pages.
  return { display: event.key, lane: "nav", name: event.key, mode: "NAV", action } as unknown as ReferenceBinding;
}

/**
 * Puts the inspector page's keys on top of the story's: Esc closes the page
 * even while a generation runs (the stop bar stops it), and the rest go to
 * `handle`. Returns nothing; the layer lives as long as the page.
 */
export function useInspectKeys(close: () => void, handle: (action: InspectAction) => boolean): void {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => pushKeyLayer({
    resolve: resolveInspectKey,
    claimsEscape: true,
    handle: (binding) => {
      const action = binding.action as unknown as InspectAction;
      if (action === "cancel") {
        close();
        return true;
      }
      return latest.current(action);
    }
  }), [close]);
}

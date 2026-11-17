import { useEffect, useRef } from "react";
import type { ReferenceBinding } from "../../../shared/reference-bindings.js";
import { pushKeyLayer } from "../app/keymap.js";

type SteerAction = "close" | "keep";

/** Enter keeps the shown words, unless the focus is on a button other than the knob: Enter then presses that button. */
function resolveSteerKey(event: KeyboardEvent): ReferenceBinding | null {
  if (event.metaKey || event.altKey || event.ctrlKey) return null;
  let action: SteerAction;
  if (event.key === "Escape") action = "close";
  else if (event.key === "Enter") {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && active.getAttribute("role") !== "slider") return null;
    action = "keep";
  } else return null;
  // The binding shape is the key layers' own; these actions are local to the steer page.
  return { display: event.key, lane: "nav", name: event.key, mode: "NAV", action } as unknown as ReferenceBinding;
}

/**
 * Puts the steer page's keys above the story's: Esc closes the page, Enter
 * keeps the shown words. Every other key keeps its native meaning, so the
 * knob's arrows and the buttons work as usual.
 */
export function useSteerKeys(close: () => void, keep: () => void): void {
  const latest = useRef({ close, keep });
  latest.current = { close, keep };
  useEffect(() => pushKeyLayer({
    resolve: resolveSteerKey,
    claimsEscape: true,
    handle: (binding) => {
      const action = binding.action as unknown as SteerAction;
      if (action === "close") latest.current.close();
      else latest.current.keep();
      return true;
    }
  }), []);
}

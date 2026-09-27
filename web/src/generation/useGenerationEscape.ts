import { useEffect } from "react";
import { fieldHasFocus } from "../app/keymap-dom.js";
import type { AppActions } from "../app/actions.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";

/**
 * Esc stops a running/settling generation from anywhere — any route, any
 * screen, even the library, as long as no field or dialog owns the keyboard
 * (owner decision 2: "Esc stops it from anywhere"). Deliberately independent
 * of `app/keymap.ts`'s per-screen dispatch (`registerScreenKeys`): that
 * mechanism only ever has one screen's handler active, and none at all on
 * the library route, so Continue (Space, which only ever makes sense while
 * viewing a story) stays screen-scoped there while this one is mounted once,
 * for the whole app (`App.tsx`'s `Shell`).
 */
export function useGenerationEscape(store: Store<AppState>, actions: AppActions): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || fieldHasFocus()) return;
      const generation = store.get().generation;
      if (generation.kind !== "running" && generation.kind !== "settling") return;
      event.preventDefault();
      actions.generation.stop();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [store, actions]);
}

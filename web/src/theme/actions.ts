import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { applyPalette, applyTheme, persistPalette, persistTheme } from "./apply.js";
import { systemPrefersDark } from "./resolvedTheme.js";

export interface ThemeActions {
  toggleTheme(): void;
  selectPalette(paletteId: string): void;
}

/** Moved out of `App.tsx` (review fix A1): a plain module of functions
 * closing over `store`, the same pattern `library/actions.ts` and
 * `story/actions.ts` use. Both actions are synchronous DOM + localStorage
 * writes, so unlike those two this needs no `runAction`/`catchAtBoundary` —
 * there is nothing here that can reject. */
export function createThemeActions(store: Store<AppState>): ThemeActions {
  return {
    toggleTheme: () => {
      const current = store.get().theme;
      const next = current === "dark" ? "light" : current === "light" ? "dark" : oppositeOfSystem();
      applyTheme(next);
      persistTheme(next);
      store.set((state) => ({ ...state, theme: next }));
    },

    selectPalette: (paletteId) => {
      applyPalette(paletteId);
      persistPalette(paletteId);
      store.set((state) => ({ ...state, palette: paletteId }));
    }
  };
}

/** The OS preference `theme === null` was already following, so the first
 * explicit press flips away from whichever face is on screen right now. */
function oppositeOfSystem(): "light" | "dark" {
  return systemPrefersDark() ? "light" : "dark";
}

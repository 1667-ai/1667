import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { storeFactsDocked, type PanelView } from "./state.js";

export interface PanelActions {
  /** `c` and `f`: opens the panel on this view. */
  open(view: PanelView): void;
  close(): void;
  /** `F`: docks the Facts view beside the manuscript, or hides it again. The
   * keyboard stays where it is. */
  toggleFactsDock(): void;
}

export function createPanelActions(store: Store<AppState>): PanelActions {
  const set = (view: PanelView | null): void =>
    store.set((state) => (state.panel.view === view ? state : { ...state, panel: { ...state.panel, view } }));
  return {
    open: (view) => store.set((state) => ({
      ...state,
      panel: { ...state.panel, view, openSerial: state.panel.openSerial + 1 }
    })),
    close: () => set(null),
    toggleFactsDock: () => {
      const factsDocked = !store.get().panel.factsDocked;
      storeFactsDocked(factsDocked);
      store.set((state) => ({ ...state, panel: { ...state.panel, factsDocked } }));
    }
  };
}

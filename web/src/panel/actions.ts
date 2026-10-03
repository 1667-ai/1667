import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import type { PanelView } from "./state.js";

export interface PanelActions {
  /** `c`: opens the panel on this view. */
  open(view: PanelView): void;
  close(): void;
}

export function createPanelActions(store: Store<AppState>): PanelActions {
  const set = (view: PanelView | null): void =>
    store.set((state) => (state.panel.view === view ? state : { ...state, panel: { view } }));
  return { open: set, close: () => set(null) };
}

import type { AppState, OverlayKind } from "../app/state.js";
import type { Store } from "../app/store.js";

export interface OverlayActions {
  /** Opens the palette, keys help or notice log. Another one that is already open is replaced. */
  open(kind: OverlayKind): void;
  close(): void;
}

export function createOverlayActions(store: Store<AppState>): OverlayActions {
  const set = (overlay: OverlayKind | null): void =>
    store.set((state) => (state.overlay === overlay ? state : { ...state, overlay }));
  return { open: set, close: () => set(null) };
}

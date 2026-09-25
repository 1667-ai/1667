import { createContext, useContext, type ReactNode } from "react";
import type { LibraryActions } from "../library/actions.js";
import type { AppState } from "./state.js";
import type { Store } from "./store.js";

export interface AppActions {
  readonly library: LibraryActions;
  readonly reconnect: () => void;
  readonly toggleTheme: () => void;
  readonly selectPalette: (paletteId: string) => void;
}

export interface AppContextValue {
  readonly store: Store<AppState>;
  readonly actions: AppActions;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider(
  { value, children }: { readonly value: AppContextValue; readonly children: ReactNode }
) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Components read state with `useStore(store, select)` (returns an
 * existing reference when the selected slice has not changed) and dispatch
 * through `actions` — never prop drilling either one down from `App.tsx`. */
export function useAppContext(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error("useAppContext used outside <AppProvider>");
  return value;
}

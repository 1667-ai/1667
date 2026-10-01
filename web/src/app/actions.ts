import type { FlushScheduler } from "../generation/stream-buffer.js";
import { createThemeActions, type ThemeActions } from "../theme/actions.js";
import { createContentActions, type ContentActions } from "./content-actions.js";
import type { AppState } from "./state.js";
import type { Store } from "./store.js";

export interface AppActionDependencies {
  /** `app/bootstrap.ts` owns the connection lifecycle (the disposer of
   * whichever attempt is current), so it supplies this rather than
   * `app/actions.ts` reaching into `app/connection.ts` itself. */
  readonly reconnect: () => void;
  /** Test seam: replaces the animation-frame flush scheduler a generation
   * run uses. Production code omits it. */
  readonly createScheduler?: () => FlushScheduler;
}

export interface AppActions extends ContentActions {
  readonly theme: ThemeActions;
  readonly reconnect: () => void;
}

/** Composes the content actions with the theme and the reconnect hook
 * (review fix A1): each module follows `app/store.ts`'s "plain functions
 * closing over `store`" pattern on its own; this is only the wiring. */
export function createAppActions(store: Store<AppState>, deps: AppActionDependencies): AppActions {
  return {
    ...createContentActions(store, deps),
    theme: createThemeActions(store),
    reconnect: deps.reconnect
  };
}

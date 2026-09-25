import { createLibraryActions, type LibraryActions } from "../library/actions.js";
import { createStoryActions, type StoryActions } from "../story/actions.js";
import { createThemeActions, type ThemeActions } from "../theme/actions.js";
import type { AppState } from "./state.js";
import type { Store } from "./store.js";

export interface AppActionDependencies {
  /** `app/bootstrap.ts` owns the connection lifecycle (the disposer of
   * whichever attempt is current), so it supplies this rather than
   * `app/actions.ts` reaching into `app/connection.ts` itself. */
  readonly reconnect: () => void;
}

export interface AppActions {
  readonly library: LibraryActions;
  readonly story: StoryActions;
  readonly theme: ThemeActions;
  readonly reconnect: () => void;
}

/**
 * Composes the three feature action modules over one store (review fix A1):
 * `library`, `story`, and `theme` each follow `app/store.ts`'s "plain
 * functions closing over `store`" pattern on their own; this is only the
 * wiring between them. `library` and `story` share one hook
 * (`story.titleChanged`) so a rename updates whichever story is open without
 * either module writing into the other's state directly.
 */
export function createAppActions(store: Store<AppState>, deps: AppActionDependencies): AppActions {
  const story = createStoryActions(store);
  const library = createLibraryActions(store, { titleChanged: story.titleChanged });
  const theme = createThemeActions(store);
  return { library, story, theme, reconnect: deps.reconnect };
}

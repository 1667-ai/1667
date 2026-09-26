import type { BridgeRecoveryWarning } from "../../../shared/web-bridge-protocol.js";
import { initialLibraryState, type LibraryState } from "../library/state.js";
import { readStoredShowDirections } from "../reading/directions.js";
import { initialStoryState, type StoryState } from "../story/state.js";
import type { ThemeMode } from "../theme/themes.js";
import type { ConnectionState } from "./connection.js";
import type { Route } from "./router.js";

export interface Toast {
  readonly id: string;
  readonly message: string;
}

/** Reading preferences, distinct from a per-story field: "Show directions"
 * applies across every story the reader opens. See `reading/directions.ts`. */
export interface ReadingPreferences {
  readonly showDirections: boolean;
}

export interface AppState {
  readonly connection: ConnectionState;
  readonly recoveryWarnings: readonly BridgeRecoveryWarning[];
  readonly route: Route;
  readonly library: LibraryState;
  readonly story: StoryState;
  readonly reading: ReadingPreferences;
  readonly toasts: readonly Toast[];
  /** `null` theme means "follow the OS" — see `theme/apply.ts`. */
  readonly theme: ThemeMode | null;
  readonly palette: string;
}

export function initialAppState(
  route: Route,
  theme: ThemeMode | null,
  palette: string
): AppState {
  return {
    connection: { kind: "connecting" },
    recoveryWarnings: [],
    route,
    library: initialLibraryState(),
    story: initialStoryState(),
    reading: { showDirections: readStoredShowDirections() },
    toasts: [],
    theme,
    palette
  };
}

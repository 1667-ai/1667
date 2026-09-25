import type { BridgeRecoveryWarning } from "../../../shared/web-bridge-protocol.js";
import { initialLibraryState, type LibraryState } from "../library/state.js";
import { initialStoryState, type StoryState } from "../story/state.js";
import type { ThemeMode } from "../theme/themes.js";
import type { ConnectionState } from "./connection.js";
import type { Route } from "./router.js";

export interface Toast {
  readonly id: string;
  readonly message: string;
}

export interface AppState {
  readonly connection: ConnectionState;
  readonly recoveryWarnings: readonly BridgeRecoveryWarning[];
  readonly route: Route;
  readonly library: LibraryState;
  readonly story: StoryState;
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
    toasts: [],
    theme,
    palette
  };
}

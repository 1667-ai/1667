import type { StoryPayload, StorySummary } from "../../../shared/types.js";
import type { BridgeRecoveryWarning } from "../../../shared/web-bridge-protocol.js";
import type { ThemeMode } from "../theme/themes.js";
import type { ConnectionState } from "./connection.js";
import type { Route } from "./router.js";

export interface Toast {
  readonly id: string;
  readonly message: string;
}

export type DialogState =
  | { readonly kind: "none" }
  | { readonly kind: "rename"; readonly storyId: string; readonly title: string }
  | { readonly kind: "delete"; readonly storyId: string; readonly title: string };

export interface LibraryState {
  readonly stories: readonly StorySummary[] | null;
  readonly query: string;
}

export interface AppState {
  readonly connection: ConnectionState;
  readonly recoveryWarnings: readonly BridgeRecoveryWarning[];
  readonly route: Route;
  readonly library: LibraryState;
  readonly openStory: StoryPayload | null;
  readonly dialog: DialogState;
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
    library: { stories: null, query: "" },
    openStory: null,
    dialog: { kind: "none" },
    toasts: [],
    theme,
    palette
  };
}

import type { BridgeRecoveryWarning } from "../../../shared/web-bridge-protocol.js";
import { initialComposeState, type ComposeState } from "../compose/state.js";
import type { EditorState } from "../editor/state.js";
import { initialGenerationState, type GenerationState } from "../generation/state.js";
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
  /** The one generation the web UI can be running at a time (#409 step 5) —
   * top level, not inside `story`, because it outlives the reader leaving
   * the story it targets. See `generation/state.ts`. */
  readonly generation: GenerationState;
  /** The composer's drafts and history (#409 step 6). See `compose/state.ts`. */
  readonly compose: ComposeState;
  /** The one open inline editor, if any (#409 step 6). See `editor/state.ts`. */
  readonly editor: EditorState | null;
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
    generation: initialGenerationState(),
    compose: initialComposeState(),
    editor: null,
    reading: { showDirections: readStoredShowDirections() },
    toasts: [],
    theme,
    palette
  };
}

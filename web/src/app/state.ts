import type { BridgeRecoveryWarning } from "../../../shared/web-bridge-protocol.js";
import { initialChaptersState, type ChaptersState } from "../chapters/state.js";
import { initialComposeState, type ComposeState } from "../compose/state.js";
import type { EditorState } from "../editor/state.js";
import { initialFactsState, type FactsState } from "../facts/state.js";
import { initialGenerationState, type GenerationState } from "../generation/state.js";
import { initialLibraryState, type LibraryState } from "../library/state.js";
import { readStoredShowDirections } from "../reading/directions.js";
import { initialPanelState, type PanelState } from "../panel/state.js";
import { initialTagsState, type TagsState } from "../tags/state.js";
import { initialPartUiState, type PartUiState } from "../story/part-ui-state.js";
import { initialStoryState, type StoryState } from "../story/state.js";
import type { ThemeMode } from "../theme/themes.js";
import type { ConnectionState } from "./connection.js";
import type { Route } from "./router.js";

/** What the notice log (`!`) records: every toast, every connection change
 * and every recovery warning, kept for this tab only. */
export interface Notice {
  readonly id: number;
  /** Client wall-clock time (ms) the message first appeared. */
  readonly at: number;
  readonly channel: "toast" | "connection" | "recovery";
  readonly text: string;
  /** Records one message once, however often it is reported. */
  readonly key?: string;
}

export type OverlayKind = "palette" | "keys" | "log";

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
  /** The part menu request and the delete confirmation (#409 step 6). */
  readonly partUi: PartUiState;
  /** Chapter undo, the inline rename, and the running summary (#409 step
   * 7a). See `chapters/state.ts`. */
  readonly chapters: ChaptersState;
  /** The tag popover and the tag drafts (#409 step 7a). See `tags/state.ts`. */
  readonly tags: TagsState;
  /** The Facts view's filter, editor and pick mode (#409 step 7b). See
   * `facts/state.ts`. */
  readonly facts: FactsState;
  /** The story panel (#409 step 7a). See `panel/state.ts`. */
  readonly panel: PanelState;
  readonly reading: ReadingPreferences;
  readonly toasts: readonly Toast[];
  /** The notice log, oldest first. See `app/notices.ts`. */
  readonly notices: readonly Notice[];
  /** The one open dialog of the command palette, keys help, or notice log. */
  readonly overlay: OverlayKind | null;
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
    partUi: initialPartUiState(),
    chapters: initialChaptersState(),
    tags: initialTagsState(),
    facts: initialFactsState(),
    panel: initialPanelState(),
    reading: { showDirections: readStoredShowDirections() },
    toasts: [],
    notices: [],
    overlay: null,
    theme,
    palette
  };
}

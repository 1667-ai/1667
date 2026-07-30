import type {
  ModelServerCheckResult,
  StoryFact,
  StoryNode,
  StoryPayload,
  StorySummary
} from "../../shared/types.js";
import type { ConnectionState } from "./connection.js";
import type { HitRows } from "./hit.js";
import type { UserConfig } from "./config.js";
import type { ReadingPositions } from "./reading-position.js";
import type { AppMode } from "./keys.js";
import type { UndoEntry } from "./model.js";
import type { PrunePlan } from "./prune-model.js";
import type { ComposerState } from "./composer-model.js";
import type { MapState } from "./map-state.js";
import type { CommandSelectionId } from "./command-model.js";
import type {
  DiscardPendingSettingsCommand,
  SaveSettingsCommand,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type {
  ComposerSelectionProjection,
  StorySelectionProjection,
  StorySelectionSpan
} from "./selection-projection.js";
import type { SettingsTextDraft } from "./settings-text.js";

export type BackendTaskKind = "action" | "connection-reconcile" | "explicit-retry";

/** A generation in flight: where it renders and what has landed so far.
 *
 * Identity contract: a StreamView is replaced, never rewritten. Only
 * appendStreamText mutates a live stream, and it only grows `text` and its
 * trim bounds; every routing field (target, parent, append, instruction,
 * startedAt, genId) is fixed when the stream claims the request. Caches may
 * therefore key on the object identity alone (see stream-projection.ts). */
export interface StreamView {
  targetId: string;
  parentId: string | null;
  append: boolean;
  /** Client wall-clock time when this visible stream claimed the request. */
  startedAt: string;
  /** Explicit composer-owner epoch at launch. Legacy stop restoration may
   * proceed only while no newer editor has been claimed. */
  composerClaimEpoch?: number;
  instruction: string;
  text: string;
  /** Incrementally maintained String.trim() bounds in UTF-16 offsets. */
  trimStart?: number;
  trimEnd?: number;
  /** When set (regenerate), the virtual part renders at this position. */
  partNumber?: number;
  /** Original part for a prompted retake, used to restore a stopped draft. */
  retakeNodeId?: string;
  /** Identity + append base for saving the partial when the user stops. */
  genId?: string;
  appendBaseHash?: string;
  /** Exact submitted draft owned by this generation, if it came from COMPOSE. */
  pendingDraft?: PendingGenerationDraft;
  /** Exact legacy retake editor restored by an empty stop, if any. */
  restoredRetakePrompt?: RetakePromptSession;
}

export interface TagPrompt {
  nodeId: string;
  name: string;
  statusIndex: number;
  choosingStatus: boolean;
  existing: boolean;
  returnMode: "NAV" | "MAP";
}

export type TextPrompt =
  | {
      kind: "filter";
      initial: {
        query: string;
        cursor: number;
        storyId: string | null;
      };
    }
  | {
      kind: "rename";
      value: string;
      /** Frozen at prompt-open so later movement or refresh cannot retarget it. */
      targetId: string;
    }
  | {
      kind: "delete";
      value: string;
      /** Frozen at prompt-open so later movement or refresh cannot retarget it. */
      targetId: string;
    };
export interface LibraryOverlayState { stories: StorySummary[]; cursor: number; query: string; prompt: TextPrompt | null }
export interface FactsOverlayState {
  cursor: number;
  query: string;
  chip: number;
  /** Stable identity while the sorted chip list changes after a mutation. */
  selectedTag: string | null;
  filtering: boolean;
  deleteArmedId: string | null;
}
export interface CommandsOverlayState {
  query: string;
  cursor: number;
  /** Stable identity across live Suggested-section reordering. */
  selectedId: CommandSelectionId | null;
  view: "commands" | "tags";
}
export interface ChaptersOverlayState {
  cursor: number;
  rename: { breakId: string; value: string } | null;
  deleteArmedId: string | null;
}
export type SettingsRowId =
  | "theme"
  | "compose-focus"
  | "provider"
  | "base-url"
  | "allow-insecure-http"
  | "model"
  | "api-key"
  | "api-key-env"
  | "temperature"
  | "max-tokens"
  | "context-window"
  | "cache-policy"
  | "system-prompt";

export interface SettingsEditBufferState {
  composer: ComposerState;
  initial: string;
}

export interface SettingsInlineEditState extends SettingsEditBufferState {
  kind: "inline";
  row: Exclude<SettingsRowId, "system-prompt">;
  mode: "text" | "secret";
}

export interface SettingsOverlaySaveIntent {
  readonly command: Omit<SaveSettingsCommand, "transportOperationId">;
  readonly draft: SettingsTextDraft;
  readonly connectionSecrets: Readonly<Record<string, string | null>>;
}
export interface SettingsOverlayState {
  view: SettingsView;
  /** Last authoritative projection used to detect/rebase external refreshes. */
  base: SettingsTextDraft;
  /** Atomic unsaved form state. Runtime generation remains pinned to view.effective. */
  draft: SettingsTextDraft;
  /** Write-only key material; never projected into GenerationSettings/document. */
  connectionSecrets: Record<string, string | null>;
  cursor: number;
  /** Settings-menu row editor. Full-screen prompts use `RuntimeState.editor`. */
  edit: SettingsInlineEditState | null;
  conflict: { message: string; armed: boolean } | null;
  saveIntent?: SettingsOverlaySaveIntent;
  checking: boolean;
  probing: boolean;
  result: ModelServerCheckResult | null;
  discardIntent?: Omit<DiscardPendingSettingsCommand, "transportOperationId">;
}
export interface SummaryOverlayState {
  start: number;
  end: number;
  totalParts: number;
  text: string;
  controller: AbortController;
}

export type InlineEditorTarget =
  | { kind: "part"; node: StoryNode; pathIndex: number; savedNode: StoryNode | null }
  | { kind: "human-take"; node: StoryNode; pathIndex: number; savedNode: StoryNode | null }
  | { kind: "chapter-summary"; summaryId: string; expected: string }
  | { kind: "settings-prompt"; owner: SettingsOverlayState; scope: "global" };

export interface FactEditorTarget {
  kind: "fact";
  factId: string | null;
  base: StoryFact | null;
}

interface EditorSessionBase {
  composer: ComposerState;
  title: string;
  placeholder: string;
  /** Explicit second-press consent when OSC 52 cannot confirm a destructive cut. */
  cutConfirmation: { start: number; end: number; text: string } | null;
}

export interface InlineEditorSession extends EditorSessionBase {
  kind: "document";
  initial: string;
  target: InlineEditorTarget;
  returnMode: "NAV" | "FACTS" | "SETTINGS";
  conflict: {
    message: string;
    resolution: "overwrite" | "create";
    armed: boolean;
  } | null;
}

export interface FactEditorSession extends EditorSessionBase {
  kind: "fact";
  target: FactEditorTarget;
  returnMode: "NAV" | "FACTS";
  conflict: InlineEditorSession["conflict"];
  tag: ComposerState;
  focus: "tag" | "body";
  initialFact: { tag: string | null; text: string };
  tagCutConfirmation: EditorSessionBase["cutConfirmation"];
}

export type DocumentEditorSession =
  | InlineEditorSession
  | FactEditorSession;

export interface PartActionsOverlay {
  cursor: number;
  partId: string;
  selectionText?: string | null;
  /** Semantic source spans repainted while the native selection is cleared. */
  selectionSpans?: readonly StorySelectionSpan[];
}

/** Everything the overlay panels render from. */
export interface OverlayState {
  /** Part-actions menu (right-click a part, or press x). */
  actions: PartActionsOverlay | null;
  /** Row→target map from the last render; mouse handling reads it. */
  hitRows: HitRows;
  config: UserConfig;
  /** Local changing store: last focused part per story. Not settings. */
  readingPositions: ReadingPositions;
  demo: boolean;
  storyFolder: string;
  library: LibraryOverlayState | null;
  facts: FactsOverlayState | null;
  commands: CommandsOverlayState | null;
  chapters: ChaptersOverlayState | null;
  settings: SettingsOverlayState | null;
  summary: SummaryOverlayState | null;
  connection: ConnectionState;
}

/** Everything the story screen renders from. */
export interface StoryScreenState extends OverlayState {
  payload: StoryPayload;
  focusIndex: number;
  mode: AppMode;
  showInstructions: boolean;
  /** Prompt rows expanded inline for reading and terminal text selection. */
  expandedPromptIds: Set<string>;
  composer: ComposerState;
  editor: DocumentEditorSession | null;
  /** Atomic edited-prompt owner; null means the persistent Direct composer. */
  retakePrompt: RetakePromptSession | null;
  toast: string | null;
  stream: StreamView | null;
  /** The cancellable operation whose backend owner is still settling. */
  abort:
    | {
        kind: "generation";
        controller: AbortController;
        /** Latest Stop interaction that can focus the settled take. */
        stopInteractionVersion: number | null;
      }
    | { kind: "summary"; controller: AbortController }
    | null;
  freshLandedAt: ReadonlyMap<string, number>;
  now: number;
  model: string;
  contextWindow: number | null;
  /** Maximum provider response size. The context meter shows this as secondary
   *  text only; bar growth uses a likely-response estimate from recent prose. */
  maxTokens: number;
  systemPrompt: string;
  /** Whether the configured provider accepts an assistant continuation prefill. */
  assistantPrefill: boolean;
  map: MapState | null;
  contextMeterExpanded: boolean;
  prune: PrunePlan | null;
  tag: TagPrompt | null;
  /** Expanded dead-end chapter-summary cards in the reading column. */
  expandedChapterSummaryIds: Set<string>;
  /** Direct divider deletion uses the same two-step safety as prune. */
  chapterDeleteArmedId: string | null;
  typewriter: boolean;
  /** Free viewport scroll (ctrl+d/u); null = follow the focused part. */
  viewScroll: number | null;
  /** Relative scroll awaiting the next complete cold-frame derivation. */
  viewScrollDelta: number;
  /** Where the last complete frame's viewport started. */
  lastViewportStart: number;
  /** First logical composer row painted in the last frame. */
  composerScrollTop: number;
  /** First logical row painted by the full-screen in-TUI editor. */
  editorScrollTop: number;
  /** First row of the key reference shown, for terminals too short for it. */
  keysScrollTop: number;
  /** Last presented page-buffer cells that correspond to raw editor text. */
  composerSelectionProjection: ComposerSelectionProjection | null;
  /** Last NAV page-buffer cells that correspond to raw story fields. */
  storySelectionProjection: StorySelectionProjection | null;
  /** Visible owner for the one unsettled backend action. */
  backendTask: { id: number; kind: BackendTaskKind; label: string; storyId: string } | null;
}

export type PendingGenerationDraft =
  | {
      kind: "direct";
      text: string;
      composer: ComposerState;
      composerClaimEpoch: number;
      cursor: number;
      fullscreen: boolean;
      composerScrollTop: number;
      restored: boolean;
    }
  | {
      kind: "retake";
      text: string;
      /** Exact movable prompt owner; target identity comes from the session. */
      retakePrompt: RetakePromptSession;
      restored: boolean;
    };

/** Persistent Direct-composer state displaced by an edited-prompt retake. */
export interface RetakePromptReturnState {
  composer: ComposerState;
  composerScrollTop: number;
  historyIndex: number;
  historyDraft: string | null;
  historyWasLive: boolean;
}

/** One movable owner spanning prompt entry and its pending generation. */
export interface RetakePromptSession {
  nodeId: string;
  composer: ComposerState;
  composerScrollTop: number;
  returnState: RetakePromptReturnState;
}

/** Screen state plus runtime-only bookkeeping the renderer never reads. */
export interface RuntimeState extends StoryScreenState {
  undo: UndoEntry[];
  history: string[];
  historyIndex: number;
  /** Unsent live-slot draft retained while submitted history is visible. */
  historyDraft: string | null;
  pendingGenerationDraft: PendingGenerationDraft | null;
  /** Monotonic fence for explicit Direct/retake editor claims. */
  composerClaimEpoch: number;
  quitArmed: boolean;
  /** Changes once per user reducer; async completions use it to avoid
   * restoring launch-time focus, mode, or overlays after later input. */
  interactionVersion: number;
}

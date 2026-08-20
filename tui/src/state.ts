import type {
  ModelServerCheckResult,
  StoryFact,
  StoryNode,
  StoryPayload,
  StorySummary,
  TextRange
} from "../../shared/types.js";
import type { FactPriority, FactRecursion, FactSecondaryMode } from "../../shared/fact-metadata.js";
import type { FactDraft } from "../../shared/fact-draft.js";
import type { FactEditorRow } from "./fact-editor-rows.js";
import type { ConnectionState } from "./connection.js";
import type { FilePathPrompt } from "./path-completion.js";
import type { NoticeLog } from "./notice-log.js";
import type { HitRows } from "./hit.js";
import type { SettingsViewMode, UserConfig } from "./config.js";
import type { ReadingPositions } from "./reading-position.js";
import type { AppMode, ResolvedKey } from "./keys.js";
import type { UndoEntry } from "./model.js";
import type { PrunePlan } from "./prune-model.js";
import type { ComposerState } from "./composer-model.js";
import type { MapState } from "./map-state.js";
import type { SearchState } from "./search-model.js";
import type { CommandSelectionId } from "./command-model.js";
import type {
  DiscardPendingSettingsCommand,
  ModelDiscoveryResultV2,
  ReasoningDisplayV2,
  SaveSettingsCommand,
  SamplingScalarKnobV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { ReasoningRecord } from "../../shared/reasoning.js";
import type { SamplingBiasResolutionResult } from "../../shared/sampling-capabilities.js";
import type {
  ComposerSelectionProjection,
  ProjectedStorySelection,
  StorySelectionProjection,
  StorySelectionSpan
} from "./selection-projection.js";
import type { SettingsTextDraft } from "./settings-text.js";
import type { SettingsModelPicker } from "./settings-model-picker.js";
import type { TokenProbabilityRecord } from "../../shared/token-probabilities.js";
import type { TokenProbabilityEmptyReason } from "./token-probabilities-model.js";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../../shared/generation-record.js";
import type { GenerationRecordDetailCache } from "./generation-record-detail-cache.js";
import type { PromptTokenCount } from "../../shared/tokenize-source.js";
import type { PromptProjectionIdentity } from "./request-context.js";
import type { StoryScalarField } from "./story-scalar-fields.js";
import type { DraftImage } from "./draft-image.js";

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
  /** Set for a highlighted rewrite: the node keeps its id, and the streamed
   *  replacement splices into [start, end) of its settled text in place. */
  rewrite?: Readonly<TextRange>;
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
  /** Model reasoning ("thinking") text for this stream, kept structurally
   *  apart from `text`/`trimStart`/`trimEnd` — its own text, its own
   *  incremental trim bounds, its own token count. Undefined until this
   *  stream's first reasoning delta arrives; a route that returns no
   *  reasoning leaves it undefined for the whole stream. */
  reasoning?: StreamReasoning;
}

/** See `StreamView.reasoning`. Mirrors `StreamView`'s own
 *  `text`/`trimStart`/`trimEnd` shape exactly, one level down, so reasoning
 *  can never be read back as story prose by sharing a field with it. */
export interface StreamReasoning {
  text: string;
  /** Incrementally maintained String.trim() bounds in UTF-16 offsets. */
  trimStart?: number;
  trimEnd?: number;
  /** Running total for the whole reasoning stream so far — a
   *  provider-reported count when available, otherwise a count of received
   *  reasoning deltas. */
  tokenCount: number;
}

/** The on-demand fetch of one take's stored thought, mirroring
 *  `TokenProbabilitiesViewerState`'s own loading/ready/empty shape one level
 *  down — see `reasoning-actions.ts`'s `ensureThoughtLoaded`. Keyed by node
 *  id in `StoryScreenState.thoughts`: a node id names one immutable take, so
 *  an entry once written is never re-fetched or invalidated. */
export type ThoughtCacheEntry =
  | { status: "loading" }
  | { status: "ready"; record: ReasoningRecord }
  | { status: "error" };

export interface TagPrompt {
  nodeId: string;
  name: string;
  statusIndex: number;
  choosingStatus: boolean;
  existing: boolean;
  returnMode: "NAV" | "MAP";
}

/** The source anchor "Copy story line below" captured — the copied part's
 *  descendant chain, not its content. "Paste story line below" re-derives
 *  and re-validates the actual chain from `sourceNodeId` against the live
 *  payload at paste time; `expectedLeafId` and `parts` only guard staleness
 *  and drive the toast, matching the server's own staleness check. */
export interface StoryLineClipboard {
  storyId: string;
  sourceNodeId: string;
  expectedLeafId: string;
  parts: number;
}

/** Both import prompts ask for a file path and answer the same keys. */
export type CardImportPrompt = FilePathPrompt;

export type ArchiveImportPrompt = FilePathPrompt;

/** The `attach image` command's path prompt: the reliable SSH and `--url`
 *  path, and the only path this build offers on any host — see
 *  `image-attach-actions.ts`. */
export type ImageAttachPrompt = FilePathPrompt;

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
      composer: ComposerState;
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
  /** Surface that owns the composer while the palette is open. */
  returnMode: "NAV" | "COMPOSE";
  /** Story selection captured at open time — the NAV projection it reads
   *  only exists for that one frame, so a later keystroke cannot rebuild it. */
  selection?: ProjectedStorySelection | null;
}
export interface ChaptersOverlayState {
  cursor: number;
  rename: { breakId: string | null; composer: ComposerState } | null;
  deleteArmedId: string | null;
}
export type SettingsRowId =
  | "theme"
  | "compose-focus"
  | "word-wrap"
  | "update-checks"
  | "provider"
  | "text-prompt-format"
  | "split-think-tags"
  | "base-url"
  | "allow-insecure-http"
  | "api-key"
  | "api-key-env"
  | "timeout-headers"
  | "timeout-idle"
  | "timeout-total"
  | "profile"
  | "model"
  | "image-input"
  | "temperature"
  | "max-tokens"
  | "sampling"
  | "context-window"
  | "effort"
  | "cache-policy"
  | "continuation-prompt"
  | "token-probabilities"
  | "reasoning"
  | "keep-thoughts"
  | "default-route"
  | "prose-route"
  | "utility-route"
  | "system-prompt";

export interface SettingsEditBufferState {
  composer: ComposerState;
  initial: string;
}

export interface SettingsInlineEditState extends SettingsEditBufferState {
  kind: "inline";
  row: Exclude<SettingsRowId, "system-prompt" | "sampling">;
  mode: "text" | "secret";
}

export type SamplingPanelId =
  | "sampling"
  | "stop"
  | "logit-bias"
  | "phrase-bias"
  | "banned-strings"
  | "dry-breakers";
export type SamplingListPanel = Exclude<SamplingPanelId, "sampling">;

/** One shape for every list panel's inline editor, discriminated by `panel`
 * instead of four near-identical `kind` variants — every list panel edits
 * one row's text through the same composer regardless of what that row's
 * value looks like (tui/src/sampling-panel-spec.ts owns the per-panel
 * parse/validate/apply logic). */
export type SamplingInlineEditState =
  | (SettingsEditBufferState & {
      kind: "scalar";
      index: number;
      knob: SamplingScalarKnobV2;
    })
  | (SettingsEditBufferState & { kind: "list"; panel: SamplingListPanel; index: number });

/** The last resolveSamplingBias response for the current draft's phraseBias
 * and bannedStrings — the same worker call and the same merge computation
 * the provider request uses (server/sampling-phrase-bias.ts), fetched once
 * per sampling-editor session and once per commit
 * (tui/src/sampling-bias-resolution.ts), not once per phrase.
 *
 * "failed" (issue #282 review round 2, finding 5) is the worker call itself
 * throwing — a transport failure, not a documented outcome — carrying a
 * message so the row says why instead of claiming to still be working. It
 * is a dead end, not a stage of "pending": nothing but a fresh
 * resolveSamplingBias call (a new commit, or reopening the panel) leaves it. */
export type SamplingBiasResolutionState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly result: SamplingBiasResolutionResult };

export interface SamplingOverlayState {
  panel: SamplingPanelId;
  cursor: number;
  logitBiasOrder: string[];
  edit: SamplingInlineEditState | null;
  result: string | null;
  biasResolution: SamplingBiasResolutionState;
  /** Bumped by every resolveSamplingBias call (tui/src/sampling-bias-
   * resolution.ts) and captured by the request it starts — `pending` is set
   * synchronously but cleared asynchronously, so two overlapping commits
   * (issue #282 review round 2, finding 5) can otherwise land in either
   * order with only panel identity as a staleness guard. A stale request's
   * result is dropped rather than overwriting a newer one's. */
  resolutionGeneration: number;
}

export interface SettingsOverlaySaveIntent {
  readonly command: Omit<SaveSettingsCommand, "transportOperationId">;
  readonly draft: SettingsTextDraft;
  readonly connectionSecrets: Readonly<Record<string, string | null>>;
}
export interface SettingsProfileModelSelection {
  automaticModel?: {
    remoteId: string;
    targetIdentity: string;
  };
}
export type SettingsModelSelectionByProfile = Record<
  string,
  SettingsProfileModelSelection
>;
export interface SettingsOverlayState {
  view: SettingsView;
  /** Last authoritative projection used to detect/rebase external refreshes. */
  base: SettingsTextDraft;
  /** Atomic unsaved form state. Runtime generation remains pinned to view.effective. */
  draft: SettingsTextDraft;
  /** One per-profile owner for model values inferred while this overlay is open. */
  modelSelectionByProfile: SettingsModelSelectionByProfile;
  /** Write-only key material; never projected into GenerationSettings/document. */
  connectionSecrets: Record<string, string | null>;
  cursor: number;
  /** Which rows the field list shows. Session state, seeded at open time
   *  from `UserConfig.settingsViewMode`; the `m` action flips it for the
   *  rest of the session and persists the choice back to the config
   *  (settings-view-mode.ts), the same local-preference path compose focus
   *  and word wrap use. Independent of the settings draft: which rows show
   *  is a view concern, not something the save pipeline round-trips. */
  viewMode: SettingsViewMode;
  /** Settings-menu row editor. Full-screen prompts use `RuntimeState.editor`. */
  edit: SettingsInlineEditState | null;
  /** Nested three-layer sampling editor. */
  sampling: SamplingOverlayState | null;
  /** Nested Generation Profile import flow. */
  profileTransfer: ProfileTransferPrompt | null;
  conflict: { message: string; armed: boolean } | null;
  saveIntent?: SettingsOverlaySaveIntent;
  checking: boolean;
  probing: boolean;
  /** Armed by a draft transition that just landed a model with no known
   *  context window (settings-model-selection.ts's `applySettingsModelChoice`,
   *  settings-overlay-model.ts's `cycleSettingsProvider`), drained by
   *  `detectSettingsContextForModelChange` (settings-context-detection.ts)
   *  wherever a model choice can land — the settings dispatch seam and
   *  discovery's own auto-select alike — so an automatic probe fires
   *  exactly once per model change regardless of which path landed it. */
  contextProbeArmed: boolean;
  discoveringModels: boolean;
  modelDiscovery: ModelDiscoveryResultV2 | null;
  modelDiscoveryIdentity: string | null;
  modelDiscoveryResultTargetIdentity: string | null;
  modelDiscoveryGeneration: number;
  modelDiscoveryAbortController: AbortController | null;
  modelDiscoveryTargetIdentity: string | null;
  result: ModelServerCheckResult | null;
  /** Which row's action produced `result`. C-18 reports in place, to the right
   *  of what caused it — three different rows write this one slot. */
  resultRow: SettingsRowId | null;
  /** Profile deletion is draft-only, so a second `d` is enough consent. */
  deleteArmedProfileId: string | null;
  /** C-15 option column, open over the form while a long model list is
   *  chosen. Null whenever the field list owns the arrows. */
  modelPicker: SettingsModelPicker | null;
  discardIntent?: Omit<DiscardPendingSettingsCommand, "transportOperationId">;
}

/** Source choice or file entry for a Settings Generation Profile import. */
export type ProfileTransferPrompt =
  | {
      readonly phase: "source";
      cursor: number;
      error: string | null;
    }
  | {
      readonly phase: "file";
      path: string;
      candidates: string[];
      error: string | null;
    };
export interface SummaryOverlayState {
  start: number;
  end: number;
  totalParts: number;
  text: string;
  controller: AbortController;
}

/** A chapter summary is a unary provider operation, so the provider cannot
 *  report source-consumption progress. Keep the honest stage and chapter
 *  identity visible while the action runtime owns the request. */
export interface ChapterSummaryOverlayState {
  chapterNumber: number;
  stage: "writing" | "stopping";
  controller: AbortController;
}

export interface RequestViewerState {
  cursor: number;
  /** Negative means reveal the focused message on the next render. */
  scrollTop: number;
  returnMode: "NAV" | "COMPOSE";
}

/** The token probability viewer (issue #291 phase 4), open on one take.
 *
 * Unlike `RequestViewerState.cursor` — which is reclamped every render
 * against an estimate rebuilt from the live payload — `tokenIndex` and
 * `altIndex` are clamped once, in the reducer, directly against `record`:
 * the record does not change while the surface is open, so there is no
 * second, render-time source of truth to keep it honest against. */
export interface TokenProbabilitiesViewerState {
  /** The take being inspected. Re-resolved against the live payload on
   *  every render, so a rare concurrent edit degrades to the empty state
   *  instead of describing a part that moved out from under it. */
  nodeId: string;
  /** Selected step, index into `record.steps`. Meaningless while loading or
   *  empty. */
  tokenIndex: number;
  /** Selected alternative, index into the *displayed* rows for the current
   *  step — which includes the synthetic "n more under 1%" row when one is
   *  collapsed. See `tokenProbabilityAlternativeRows`. */
  altIndex: number;
  /** Whether the current step's under-1% alternatives are unfolded. Reset
   *  whenever `tokenIndex` moves — each token starts collapsed. */
  expanded: boolean;
  /** Null while the fetch is in flight, or when the take has none. */
  record: TokenProbabilityRecord | null;
  loading: boolean;
  /** Populated once loading settles with no record to show: why, and — for
   *  `preset-unknown` and `protocol` — which presets do support it. */
  empty: TokenProbabilityEmptyReason | null;
}

/** Why a Generation Record detail fetch settled without a record to show —
 *  distinct from `kind: "unsupported"`, which is a valid resolved record
 *  (see `GenerationRecord.unsupportedReason`) rendered in the body, not an
 *  error here. */
export type GenerationRecordDetailError =
  /** The take's own history no longer lists this id (deleted, or a stale
   *  cached id from a take that has since moved on). */
  | { kind: "missing" }
  /** The server answered, but its shape failed the client's own decoder. */
  | { kind: "corrupt"; message: string }
  /** Any other transport or service failure. */
  | { kind: "failed"; message: string };

/** One fetch of a take's Generation Record summary list — see
 *  `GenerationRecordViewerState.list`. `status` mirrors `ThoughtCacheEntry`'s
 *  own discriminant, so `summaries` can never be read back while `loading`
 *  still holds, or held over stale from a previous status. */
export type GenerationRecordListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      /** Oldest first, mirroring `loadGenerationRecordSummaries`. */
      summaries: readonly GenerationRecordSummary[];
    };

/** One fetch of the selected event's resolved Generation Record — see
 *  `GenerationRecordViewerState.detail`. Every non-idle variant carries the
 *  `recordId` it is about, so a staleness check compares identities
 *  directly instead of re-deriving one from `eventIndex` against `list`.
 *  `idle` is the pre-selection state: nothing chosen yet, or `list` came
 *  back empty. */
export type GenerationRecordDetailState =
  | { status: "idle" }
  | { status: "loading"; recordId: string }
  | { status: "error"; recordId: string; error: GenerationRecordDetailError }
  | { status: "ready"; recordId: string; detail: ResolvedGenerationRecord };

/** The Generation Record Viewer (RECORD mode): the read-only history of
 *  every captured request that produced or changed one take, opened with
 *  `h` from NAV or any MAP view without moving that view's own focus.
 *
 *  `list` and `detail` are two independent async stages, each its own
 *  discriminated union so loading/error/ready stay mutually exclusive by
 *  construction — the same way `ThoughtCacheEntry` closes off a thought
 *  cache entry from claiming to be both loading and ready. The summary list
 *  loads once per `nodeId`, and each event's detail loads once per
 *  `(nodeId, eventIndex)` pair — re-checked against `state.record` after
 *  every await, so closing the viewer or moving to a different take or event
 *  before a fetch settles can never paint its answer over the wrong place. */
export interface GenerationRecordViewerState {
  /** The take being inspected. Re-resolved against the live payload on every
   *  render, so a concurrent edit degrades to an honest empty state instead
   *  of describing a take that moved out from under it. */
  nodeId: string;
  returnMode: "NAV" | "MAP";
  list: GenerationRecordListState;
  /** Index into `list.summaries`; meaningless unless `list.status` is
   *  `"ready"`. Initialized to the newest (last) entry. */
  eventIndex: number;
  /** Selected message/pipeline row within the current event's body. Reclamped
   *  at render time against the live entry count, the same way
   *  `RequestViewerState.cursor` is reclamped against message count. */
  entryIndex: number;
  /** Negative means reveal the focused entry on the next render. */
  scrollTop: number;
  detail: GenerationRecordDetailState;
  /** Bounded LRU of details already fetched this session, keyed by record
   *  id, so paging back to a recent event repaints instantly instead of
   *  re-fetching it. Paging past the bound (see
   *  GENERATION_RECORD_DETAIL_CACHE_BOUND) evicts the oldest untouched entry
   *  instead of retaining every take's full history for the session. */
  cache: GenerationRecordDetailCache;
}

/** The last answer the token-count lane published, held against the exact
 *  projection inputs and the route that produced it. The render path trusts it
 *  only while both still match, so a rendered mark always describes the prompt
 *  on screen and the connection that would receive it. */
export interface PromptTokenCountRecord {
  readonly identity: PromptProjectionIdentity;
  readonly route: string;
  readonly count: PromptTokenCount;
}

export type InlineEditorTarget =
  | { kind: "part"; node: StoryNode; pathIndex: number; savedNode: StoryNode | null }
  | { kind: "human-take"; node: StoryNode; pathIndex: number; savedNode: StoryNode | null }
  | { kind: "chapter-summary"; summaryId: string; expected: string }
  | {
      kind: "authors-note";
      expected: string;
      /** Last known authoritative depth, for reconciliation against a fresh
       *  payload — see `depth`, which the writer's key presses mutate live. */
      expectedDepth: number;
      /** Current draft depth. Saving the note sends this alongside the text. */
      depth: number;
    }
  /** Author Brief or the Facts budget — see story-scalar-fields.ts, whose
   *  table is the one place their difference lives. `expected` is the
   *  field's authoritative value as composer text — for facts-budget that
   *  means "empty is unset", matching the composer's own text, so
   *  reconciliation compares like the Author's Note editor does. */
  | { kind: "story-scalar"; field: StoryScalarField; expected: string }
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
  activation: StoryFact["activation"];
  keys: ComposerState;
  secondary: ComposerState;
  secondaryMode: FactSecondaryMode;
  scan: ComposerState;
  recursion: FactRecursion;
  priority: FactPriority;
  /** Budget as typed text; empty means "no budget set". Parsed on commit,
   *  the same way authorsNote and Fact keys already are. */
  budget: ComposerState;
  focus: FactEditorRow;
  /** Draft-of-Fact: what the editor would already match if nothing changed —
   *  see shared/fact-draft.ts. Rebased on a clean reconcile, replaced on save. */
  initialFact: FactDraft;
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

export interface TextActionsOverlay {
  cursor: number;
  owner: ComposerState | null;
  ownerSnapshot: Pick<ComposerState, "text" | "cursor" | "anchor" | "fullscreen"> | null;
  nativeSelection: ResolvedKey["nativeSelection"];
  composerSelectionProjection: ComposerSelectionProjection | null;
  copyOnly: boolean;
}

/** Everything the overlay panels render from. */
export interface OverlayState {
  /** Part-actions menu (right-click a part, or press x). */
  actions: PartActionsOverlay | null;
  /** Copy and paste menu for the active composer-backed field. */
  textActions: TextActionsOverlay | null;
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
  card: CardImportPrompt | null;
  archive: ArchiveImportPrompt | null;
  /** The `attach image` path prompt, or null/absent when it is closed.
   *  Optional so `initialState` (app.ts) and every existing fixture that
   *  builds an `OverlayState`/`RuntimeState` literal before Image Input
   *  keeps compiling without listing it. Read through `imageAttachPrompt`
   *  (`image-attach-actions.ts`), which normalizes the missing case to
   *  `null`. */
  image?: ImageAttachPrompt | null;
  chapters: ChaptersOverlayState | null;
  settings: SettingsOverlayState | null;
  summary: SummaryOverlayState | null;
  chapterSummary: ChapterSummaryOverlayState | null;
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
  /** Parts whose thought fold state was explicitly flipped away from
   *  `reasoning`'s own ambient default — see `thoughtUnfolded`
   *  (reasoning-model.ts), which is the only reader that should ever
   *  interpret membership; every writer just toggles it, the same way
   *  `story-actions.ts` toggles `expandedPromptIds`. */
  expandedThoughtIds: Set<string>;
  /** On-demand fetch state for a stored thought, by node id — see
   *  `ThoughtCacheEntry` and `ensureThoughtLoaded` (reasoning-actions.ts). */
  thoughts: Map<string, ThoughtCacheEntry>;
  composer: ComposerState;
  editor: DocumentEditorSession | null;
  /** Atomic edited-prompt owner; null means the persistent Direct composer. */
  retakePrompt: RetakePromptSession | null;
  /** Read-only projection of the next provider request. */
  request: RequestViewerState | null;
  /** The read-only token probability viewer, or null when it is closed. */
  probs: TokenProbabilitiesViewerState | null;
  /** The read-only Generation Record Viewer, or null when it is closed. */
  record: GenerationRecordViewerState | null;
  /** Full-screen Aside surface, or null when it is closed. */
  aside: import("./aside-surface.js").AsideSurfaceState | null;
  /** Placement mode for inserting a Side Note into the story line. */
  placement: import("./aside-placement.js").PlacementState | null;
  /**
   * Story-bound unresolved Placement createNode after an uncertain outcome.
   * Survives Esc back to Aside until recovery settles it or a definite failure
   * proves the write did not commit.
   */
  unresolvedPlacement: import("./aside-placement-model.js").UnresolvedPlacementSubmission | null;
  toast: string | null;
  /** C-37: every notice the session has shown, so a capped channel never
   *  loses a message for good. `!` opens it. */
  notices: NoticeLog;
  stream: StreamView | null;
  /** The cancellable operation whose backend owner is still settling. */
  abort:
    | {
        kind: "generation";
        controller: AbortController;
        /** Latest Stop interaction that can focus the settled take. */
        stopInteractionVersion: number | null;
        /** Interaction epoch captured when an Aside ask started. */
        askInteractionVersion?: number;
      }
    | { kind: "summary"; controller: AbortController }
    /** `committed` becomes true once the API call has minted a durable take,
     *  server-side — see `runSelectionRewrite` (rewrite-action.ts). Past
     *  that point a stop or a failed confirming reload must never resurrect
     *  the pre-rewrite draft; requestRewriteStop and the reload's catch
     *  branch both gate on this flag instead of assuming an abort or an
     *  error always means nothing was saved. */
    | { kind: "rewrite"; controller: AbortController; committed: boolean }
    | null;
  freshLandedAt: ReadonlyMap<string, number>;
  now: number;
  model: string;
  /** The active prose route's fold state for a thought — see
   *  `deriveGenerationRuntime`/`reasoningModeForView` (runtime-settings.ts),
   *  which populates this the same way it populates `model`. `off` gates
   *  every thought affordance shut: no waymark, no block, no keyline entry,
   *  no streaming line — checked at each of those sites individually rather
   *  than once here, so a reviewer can see the gate at the exact place it
   *  matters. */
  reasoning: ReasoningDisplayV2;
  contextWindow: number | null;
  /** Maximum provider response size. The context meter shows this as secondary
   *  text only; bar growth uses a likely-response estimate from recent prose. */
  maxTokens: number;
  systemPrompt: string;
  /** Whether the configured provider accepts an assistant continuation prefill. */
  assistantPrefill: boolean;
  /** Active prose route's continuation prompt layout. */
  continuationPromptLayout: import("../../shared/continuation-prompt-optimization.js").ContinuationPromptLayout;
  map: MapState | null;
  /** The full-bleed search navigator, or null when it is closed. */
  search: SearchState | null;
  contextMeterExpanded: boolean;
  prune: PrunePlan | null;
  tag: TagPrompt | null;
  /** The bounded source selection held between "Copy story line below" and
   *  "Paste story line below" — never the copied prose itself, just enough
   *  to re-derive and re-validate the live chain at paste time. */
  lineClipboard: StoryLineClipboard | null;
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
  /** True while a Fact-body wheel gesture owns the viewport instead of the caret. */
  editorScrollDetached: boolean;
  /** First row of the key reference shown, for terminals too short for it. */
  keysScrollTop: number;
  /** Last presented page-buffer cells that correspond to raw editor text. */
  composerSelectionProjection: ComposerSelectionProjection | null;
  /** Last NAV page-buffer cells that correspond to raw story fields. */
  storySelectionProjection: StorySelectionProjection | null;
  /** Visible owner for the one unsettled backend action. */
  backendTask: { id: number; kind: BackendTaskKind; label: string; storyId: string } | null;
  /** The freshest counted (or estimate) answer for the projected next request,
   *  or null before the lane has ever answered for this story. */
  promptTokenCount: PromptTokenCountRecord | null;
  /** Identity of the prose route the backend counts against. A token count
   *  belongs to the route that produced it, and this is what tells two routes
   *  apart — see `generationRouteKey` and PromptTokenCountRecord. */
  generationRoute: string;
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
      /** Draft Images submitted with this draft, exactly as
       *  `capturePendingDirectDraft` captured them (see `draft-image.ts`,
       *  which keys the live array off `composer` in a `WeakMap` the same
       *  way this module keys its own document/history side tables —
       *  optional so a caller built before Image Input keeps compiling).
       *  Restored alongside the text after a failure; cleared only once the
       *  mutation admits them (`clearPendingGenerationDraft`). */
      images?: readonly DraftImage[];
      restored: boolean;
    }
  | {
      kind: "retake";
      text: string;
      /** Exact movable prompt owner; target identity comes from the session. */
      retakePrompt: RetakePromptSession;
      images?: readonly DraftImage[];
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

/** What a prompt session's composed text will do on send. A discriminated
 *  union rather than an optional field on the session, so a session can never
 *  claim to be both — or neither — and the send path can switch on `kind`
 *  instead of inferring intent from which optional fields happen to be set.
 *  `rewrite` carries the target range resolved when the composer opened;
 *  the send path re-resolves it against the live payload rather than trust
 *  offsets that may no longer describe the passage. */
export type PromptIntent =
  | { kind: "retake" }
  | { kind: "rewrite"; start: number; end: number; expected: string };

/** One movable owner spanning prompt entry and its pending generation. The
 *  name predates the rewrite composer reusing this same machinery; `intent`
 *  carries which operation `nodeId`'s prompt actually performs. */
export interface RetakePromptSession {
  nodeId: string;
  intent: PromptIntent;
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

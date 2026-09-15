import type { RemovedChapterBreak } from "../client/api.js";
import type { StoryApi } from "../client/api.js";
import type {
  ChapterBreak,
  StoryFact,
  StoryPathNode,
  StoryPayload,
  StorySummary
} from "../shared/types.js";
import { deriveChapters, type ChapterPartLike } from "../shared/chapters.js";
import type { FactState } from "../shared/fact-state.js";
import type { AsidePresenceAnchorResponse, AsideSessionResponse } from "../shared/aside-transport.js";
import type { AsideAnchor } from "../shared/aside-session.js";
import type { SettingsView } from "../shared/settings-v2-view.js";
import type { DiscoveredModelV2 } from "../shared/settings-v2-types.js";
import type { FactConsistencyRun } from "../shared/fact-consistency-contract.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import type { ProviderRecoveryContext } from "../shared/provider-recovery.js";
import type { SearchHit } from "../shared/story-search.js";
import type {
  DesktopAuthPrompt,
  DesktopShellRequest,
  DesktopShellResponse,
  DesktopProjectSnapshot,
  DesktopRecentProject,
  DesktopUpdaterState
} from "./renderer-shell-contract.js";
import type { SettingsEditorActions } from "./renderer-settings-controls.js";
import type { SettingsEditorDraft } from "./renderer-settings-model.js";

export type RendererTab = "library" | "write" | "facts" | "chapters" | "map" | "settings" | "inspect";
export type StreamMode = "continue" | "direct" | "retake" | "rewrite" | "summary";
export const DESKTOP_THEMES = [
  "lantern",
  "iron gall",
  "parchment",
  "bond",
  "graphite",
  "bone",
  "hi-contrast dark",
  "hi-contrast light"
] as const;
export type DesktopTheme = typeof DESKTOP_THEMES[number];

export const ASIDE_CURRENT_KEY = "current";
export const ASIDE_UNANCHORED_KEY = "unanchored";

export function asideAnchorKey(anchor: Pick<AsideAnchor, "partId" | "takeId">): string {
  return `${anchor.partId}\u0000${anchor.takeId}`;
}

const DESKTOP_THEME_STORAGE_KEY = "1667.desktop.theme";
const DESKTOP_DIRECTIONS_STORAGE_KEY = "1667.desktop.show-directions";

export function savedDesktopTheme(): DesktopTheme {
  if (typeof localStorage === "undefined") return "graphite";
  try {
    const value = localStorage.getItem(DESKTOP_THEME_STORAGE_KEY);
    return DESKTOP_THEMES.includes(value as DesktopTheme) ? value as DesktopTheme : "graphite";
  } catch {
    return "graphite";
  }
}

export function savedDesktopDirections(): boolean {
  if (typeof localStorage === "undefined") return true;
  try { return localStorage.getItem(DESKTOP_DIRECTIONS_STORAGE_KEY) !== "0"; } catch { return true; }
}

export function persistDesktopTheme(theme: DesktopTheme): void {
  try { localStorage.setItem(DESKTOP_THEME_STORAGE_KEY, theme); } catch { /* private mode */ }
}

export function persistDesktopDirections(show: boolean): void {
  try { localStorage.setItem(DESKTOP_DIRECTIONS_STORAGE_KEY, show ? "1" : "0"); } catch { /* private mode */ }
}

export interface StoryStream {
  readonly id: string;
  readonly mode: StreamMode;
  readonly instruction: string;
  readonly text: string;
  readonly reasoning: string;
  readonly stoppedText: string;
  readonly controller: AbortController;
  readonly targetNodeId?: string;
  readonly parentId?: string | null;
  readonly appendBaseHash?: string;
  readonly generationId?: string;
  readonly attemptId?: string;
}

export interface StoppedGenerationDraft {
  readonly mode: StreamMode;
  readonly instruction: string;
  readonly text: string;
  /** False when the Host discarded an in-place rewrite's partial stash. */
  readonly saveable?: boolean;
  readonly targetNodeId?: string;
  readonly parentId?: string | null;
  readonly appendBaseHash?: string;
  readonly generationId?: string;
  readonly attemptId?: string;
}

export interface AsideState {
  readonly question: string;
  readonly answer: string;
  readonly notes: readonly { question: string; answer: string }[];
  readonly busy: boolean;
  readonly sessions: readonly AsideSessionResponse[];
  readonly anchors: readonly AsidePresenceAnchorResponse[];
  readonly unanchoredCount: number;
  readonly selectedSessionId: string | null;
  readonly anchor: AsideAnchor | null;
  readonly bucket: "current" | "historical" | "unanchored";
  readonly v2: boolean;
}

export interface LineClipboard {
  readonly storyId: string;
  readonly sourceNodeId: string;
  readonly expectedLeafId: string;
  readonly parts: number;
}

/** A native textarea selection captured before a toolbar action takes focus. */
export interface TextSelection {
  readonly start: number;
  readonly end: number;
  readonly expected: string;
}

export interface DraftImage {
  readonly leaseId: string;
  readonly attachment: StoryImageAttachment;
}

export interface RendererRecoveryWarning {
  readonly mutationId: string;
  readonly method: string;
  readonly storyId: string | null;
  readonly providerRecovery?: ProviderRecoveryContext;
  readonly resolution: "archived" | "cleared";
  readonly message: string;
}

export interface RendererDialog {
  readonly title: string;
  readonly message?: string;
  readonly kind: "text" | "choice" | "form" | "confirm" | "notice";
  readonly value: string;
  readonly multiline?: boolean;
  readonly secret?: boolean;
  readonly options?: readonly string[];
  readonly fields?: readonly RendererDialogField[];
}

export interface RendererDialogField {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly kind: "text" | "textarea" | "choice" | "number";
  readonly message?: string;
  readonly options?: readonly string[];
}

export interface RendererAuthPrompt {
  readonly interactionId: string;
  readonly prompt: DesktopAuthPrompt;
}

export interface RendererAuthLink {
  readonly url: string;
  readonly label: string;
}

export interface RendererSettingsEditorState {
  readonly draft: SettingsEditorDraft;
  readonly discovery: readonly DiscoveredModelV2[];
  readonly busy: string | null;
  readonly providerStatus: { readonly kind: "ready" | "warning" | "error"; readonly message: string } | null;
  readonly error: string | null;
  readonly fieldErrors: Readonly<Record<string, string>>;
}

export interface RendererState {
  readonly stories: readonly StorySummary[];
  readonly story: StoryPayload | null;
  readonly tab: RendererTab;
  readonly stream: StoryStream | null;
  readonly stoppedGeneration: StoppedGenerationDraft | null;
  readonly composerMode: Extract<StreamMode, "continue" | "direct">;
  readonly lineClipboard: LineClipboard | null;
  readonly draftImages: readonly DraftImage[];
  readonly recoveryWarnings: readonly RendererRecoveryWarning[];
  readonly dialog: RendererDialog | null;
  readonly aside: AsideState;
  readonly requestContext: import("./renderer-context.js").RendererContext | null;
  readonly settings: SettingsView | null;
  readonly settingsEditor: RendererSettingsEditorState | null;
  readonly factConsistency: FactConsistencyRun | null;
  readonly factConsistencyBusy: boolean;
  readonly factConsistencySeen: boolean;
  readonly focusedPartId: string | null;
  readonly chapterUndo: { readonly breakId: string; readonly removed: RemovedChapterBreak } | null;
  readonly search: string;
  readonly searchHits: readonly SearchHit[];
  readonly searchBusy: boolean;
  readonly status: string;
  readonly error: string | null;
  readonly loading: boolean;
  readonly connection: "connecting" | "live" | "offline";
  readonly inspector: { readonly title: string; readonly body: string; readonly busy: boolean } | null;
  readonly drafts: Readonly<Record<string, string>>;
  readonly project: DesktopProjectSnapshot | null;
  readonly showProjects: boolean;
  readonly recentProjects: readonly DesktopRecentProject[];
  readonly launcherBusy: boolean;
  readonly launcherError: string | null;
  readonly authStatuses: readonly { readonly provider: string; readonly label: string; readonly status: string }[];
  readonly authPrompt: RendererAuthPrompt | null;
  readonly authPromptValue: string;
  readonly authMessage: string | null;
  readonly authLinks: readonly RendererAuthLink[];
  readonly updater: DesktopUpdaterState | null;
  readonly showDirections: boolean;
  readonly theme: DesktopTheme;
}

export const INITIAL_STATE: RendererState = {
  stories: [],
  story: null,
  tab: "library",
  stream: null,
  stoppedGeneration: null,
  composerMode: "continue",
  lineClipboard: null,
  draftImages: [],
  recoveryWarnings: [],
  dialog: null,
  aside: { question: "", answer: "", notes: [], busy: false, sessions: [], anchors: [], unanchoredCount: 0, selectedSessionId: null, anchor: null, bucket: "current", v2: false },
  requestContext: null,
  settings: null,
  settingsEditor: null,
  factConsistency: null,
  factConsistencyBusy: false,
  factConsistencySeen: false,
  focusedPartId: null,
  chapterUndo: null,
  search: "",
  searchHits: [],
  searchBusy: false,
  status: "Connecting…",
  error: null,
  loading: true,
  connection: "connecting",
  inspector: null,
  drafts: {},
  project: null,
  showProjects: false,
  recentProjects: [],
  launcherBusy: false,
  launcherError: null,
  authStatuses: [],
  authPrompt: null,
  authPromptValue: "",
  authMessage: null,
  authLinks: [],
  updater: null,
  showDirections: savedDesktopDirections(),
  theme: savedDesktopTheme()
};

export interface RendererActions {
  readonly setTab: (tab: RendererTab) => void;
  readonly focusPart: (id: string) => void;
  readonly acknowledgeFactConsistencySeen: () => void;
  readonly setSearch: (value: string) => void;
  readonly openSearchHit: (hit: SearchHit) => void;
  readonly setComposerMode: (mode: Extract<StreamMode, "continue" | "direct">) => void;
  readonly setDirections: (show: boolean) => void;
  readonly setTheme: (theme: DesktopTheme) => void;
  readonly setDraft: (key: string, value: string | undefined) => void;
  readonly setAuthPromptValue: (value: string) => void;
  readonly submitDialog: (value: string) => void;
  readonly setDialogValue: (value: string) => void;
  readonly setDialogField: (id: string, value: string) => void;
  readonly cancelDialog: () => void;
  readonly selectStory: (id: string) => void;
  readonly createStory: () => void;
  readonly renameStory: () => void;
  readonly autonameStory: () => void;
  readonly deleteStory: () => void;
  readonly sealProject: () => void;
  readonly unsealProject: () => void;
  readonly revealProject: () => void;
  readonly showProjects: (show: boolean) => void;
  readonly showHelp: () => void;
  readonly continueStory: (mode: StreamMode, instruction: string) => void;
  readonly retakeLine: (node: StoryPathNode) => void;
  readonly rewriteLine: (node: StoryPathNode, selection?: TextSelection) => void;
  readonly summarizeLine: () => void;
  readonly writeManual: (text: string) => void;
  readonly attachImage: (file: File) => void;
  readonly removeImage: (index: number) => void;
  readonly stopStream: () => void;
  readonly saveStoppedGeneration: () => void;
  readonly copyStoppedGeneration: () => void;
  readonly discardStoppedGeneration: () => void;
  readonly editNode: (node: StoryPathNode, text: string) => void;
  readonly saveEditedTake: (node: StoryPathNode, text: string) => void;
  readonly editNodeDirection: (node: StoryPathNode) => void;
  readonly deleteNode: (node: StoryPathNode) => void;
  readonly switchLine: (node: StoryPathNode) => void;
  readonly switchNode: (nodeId: string) => void;
  readonly copyLine: (node: StoryPathNode) => void;
  readonly pasteLine: (node: StoryPathNode) => void;
  readonly takeFromCut: (node: StoryPathNode, selection?: TextSelection) => void;
  readonly pruneUnused: () => void;
  readonly tagLine: (node: StoryPathNode) => void;
  readonly removeTag: (node: StoryPathNode) => void;
  readonly manageTags: () => void;
  readonly exportMarkdown: () => void;
  readonly importMarkdown: () => void;
  readonly importCard: () => void;
  readonly importLorebook: () => void;
  readonly setAuthorsNote: (note: string, depth: number | undefined) => void;
  readonly setAuthorBrief: (brief: string) => void;
  readonly useAsideAnswer: () => void;
  readonly selectAsideAnchor: (key: string) => void;
  readonly editPhraseBias: () => void;
  readonly editBannedStrings: () => void;
  readonly setFactsBudget: (budget: number | null) => void;
  readonly runFactConsistency: (scope: "chapter" | "story-line") => void;
  readonly showFactConsistency: () => void;
  readonly createFact: (node?: StoryPathNode, selection?: TextSelection) => void;
  readonly editFact: (fact: StoryFact) => void;
  readonly deleteFact: (fact: StoryFact) => void;
  readonly moveFact: (fact: StoryFact, direction: -1 | 1) => void;
  readonly addFactState: (fact: StoryFact) => void;
  readonly editFactState: (fact: StoryFact, state: FactState) => void;
  readonly deleteFactState: (fact: StoryFact, state: FactState) => void;
  readonly createChapter: () => void;
  readonly renameChapter: (chapter: ChapterBreak) => void;
  readonly removeChapter: (chapter: ChapterBreak) => void;
  readonly summarizeChapter: (chapter: ChapterBreak) => void;
  readonly restoreChapter: () => void;
  readonly editChapterSummary: (chapter: ChapterBreak, node: Pick<StoryPathNode, "id" | "text">) => void;
  readonly askAside: (question: string) => void;
  readonly stopAside: () => void;
  readonly clearAside: () => void;
  readonly selectAsideSession: (sessionId: string) => void;
  readonly clearAsideSession: () => void;
  readonly resetAside: (turnIndex: number) => void;
  readonly deleteAsideTurn: (turnIndex: number) => void;
  readonly retakeAside: (turnIndex: number) => void;
  readonly settingsEditor: SettingsEditorActions;
  readonly refresh: () => void;
  readonly acknowledgeRecovery: (warning: RendererRecoveryWarning) => void;
  readonly inspect: (kind: "reasoning" | "probabilities" | "records", node: StoryPathNode) => void;
  readonly shellRequest: (request: DesktopShellRequest) => Promise<DesktopShellResponse>;
}

export interface SettingsFormValues {
  readonly profileId: string;
  readonly modelId: string;
  readonly temperature: number | null;
  readonly maxOutputTokens: number;
  readonly reasoning: "off" | "marker" | "open";
  readonly defaultAuthorBrief: string;
  readonly defaultContinueDirection: string;
  readonly effort: "default" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly cachePolicy: "off" | "auto" | "long";
  readonly tokenProbabilities: number | null;
  readonly discardReasoning: boolean;
}

export function visibleStories(state: RendererState): readonly StorySummary[] {
  const query = state.search.trim().toLocaleLowerCase();
  if (query.length === 0) return state.stories;
  return state.stories.filter((story) => story.title.toLocaleLowerCase().includes(query));
}

export function activeLeaf(story: StoryPayload): StoryPathNode | null {
  return story.path.at(-1) ?? null;
}

/** The part the inspector (D-03) is contextual to. Defaults to the active
 * leaf whenever the story loads, the path changes, or nothing was clicked
 * yet, so the field only needs to hold the writer's explicit choice. */
export function effectiveFocusedPartId(state: RendererState, story: StoryPayload): string | null {
  if (state.focusedPartId !== null && story.path.some((node) => node.id === state.focusedPartId)) {
    return state.focusedPartId;
  }
  return activeLeaf(story)?.id ?? null;
}

export function storyChapters(story: StoryPayload) {
  return deriveChapters<ChapterPartLike>(
    story.path,
    story.chapterBreaks,
    story.nodes,
    story.firstChapterTitle
  );
}

export function storyChapterInfo(
  story: StoryPayload,
  node: Pick<StoryPathNode, "id">
): { readonly number: number; readonly title: string } {
  const chapter = storyChapters(story).find((candidate) =>
    candidate.parts.some((part) => part.id === node.id)
  );
  if (chapter === undefined) return { number: 1, title: story.firstChapterTitle?.trim() || "Opening chapter" };
  return { number: chapter.number, title: chapter.title.trim() || "Untitled chapter" };
}

export function storyWordCount(story: StoryPayload): number {
  return story.path.reduce((count, node) => count + node.text.split(/\s+/u).filter(Boolean).length, 0);
}

export function storyHasUnsavedDrafts(story: StoryPayload, state: RendererState): boolean {
  if (state.draftImages.length > 0) return true;
  if (state.drafts.composer?.trim().length) return true;
  if (state.drafts["aside-question"] !== undefined
    && state.drafts["aside-question"].trim() !== state.aside.question.trim()) return true;
  if (state.drafts["authors-note"] !== undefined
    && state.drafts["authors-note"] !== (story.authorsNote ?? "")) return true;
  if (state.drafts["authors-note-depth"] !== undefined
    && state.drafts["authors-note-depth"] !== String(story.authorsNoteDepth ?? 1)) return true;
  if (state.drafts["author-brief"] !== undefined
    && state.drafts["author-brief"] !== (story.authorBrief ?? "")) return true;
  return Object.entries(state.drafts).some(([key, value]) => {
    if (!key.startsWith("part:") || value === undefined) return false;
    const node = story.path.find((candidate) => candidate.id === key.slice("part:".length));
    return node === undefined || value !== node.text;
  });
}

export function storyChapter(story: StoryPayload, node: StoryPathNode): string {
  return storyChapterInfo(story, node).title;
}

export function findFact(story: StoryPayload, factId: string): StoryFact | null {
  return story.facts.find((fact) => fact.id === factId) ?? null;
}

export function factLabel(fact: StoryFact): string {
  return fact.name?.trim() || fact.states.find((state) => "text" in state)?.text.slice(0, 48)
    || "Untitled Fact";
}

export function settingsFormValues(settings: SettingsView): SettingsFormValues | null {
  if (!settings.editable || settings.document === null) return null;
  const profileId = settings.document.routing.prose ?? settings.document.routing.default;
  const profile = settings.document.profiles[profileId];
  if (profile === undefined) return null;
  return {
    profileId,
    modelId: profile.modelId,
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    reasoning: profile.generationReasoning.kind === "independent"
      ? profile.generationReasoning.thinkingMode === "off" ? "off" : profile.generationReasoning.thinkingMode === "on" ? "open" : "marker"
      : "marker",
    defaultAuthorBrief: settings.document.writing.defaultAuthorBrief,
    defaultContinueDirection: settings.document.writing.defaultContinueDirection,
    effort: profile.generationReasoning.kind === "independent" ? profile.generationReasoning.effort : "default",
    cachePolicy: profile.cachePolicy,
    tokenProbabilities: profile.tokenProbabilities ?? null,
    discardReasoning: profile.discardReasoning === true
  };
}

export function makeMutationId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.();
  return id === undefined ? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}` : `${prefix}-${id}`;
}

export type { StoryApi };

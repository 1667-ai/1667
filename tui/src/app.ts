import {
  CliRenderEvents,
  TextRenderable,
  createCliRenderer,
  type KeyEvent
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { GenerationSettings, StoryPayload, StorySummary } from "../../shared/types.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import type { StoryApi } from "./api.js";
import type { RecoveryWarningFeed } from "./recovery-warning-feed.js";
import type { ConnectionMonitor } from "./connection.js";
import { directChapterRowAction } from "./chapter-actions.js";
import { saveConfig, type ThemeName, type UserConfig } from "./config.js";
import { createInteractiveFrameRuntime } from "./interactive-frame-runtime.js";
import type { TuiFrameProfileReport } from "./frame-profile.js";
import {
  isPlainNavigation,
  MUTATING_ACTIONS,
  overlayTextInputActive,
  pasteInto,
  resolveKey,
  sanitizePastedText,
  type ResolvedKey
} from "./keys.js";
import {
  captureMouseActionState,
  createSelectionSafeMouseGate,
  mouseToAction
} from "./mouse-actions.js";
import { createStoryViewModel, lastPartRowIndex, rowIndexForPathIndex } from "./model.js";
import { handleOverlayAction } from "./overlay-actions.js";
import { beginSettingsPasteEdit } from "./settings-overlay-model.js";
import { createPalette } from "./palette.js";
import {
  createPresentedInputQueue,
  observeInputAdmission
} from "./presented-input-queue.js";
import {
  canCapturePresentedMouseAction,
  freezeMouseEvent,
  reconcilePresentedMouseAction,
  type PresentedInteraction
} from "./presented-mouse-action.js";
import { renderStoryScreen } from "./screens/story.js";
import { frameStyledText } from "./screens/story/frame.js";
import type { RuntimeState, StreamView } from "./state.js";
import { createStorySurface } from "./story-surface.js";
import { createComposer } from "./composer-model.js";
import { mapAction } from "./map-actions.js";
import { actionsMenuAction, armPrune, bookmarkAction, composeAction, generate, generationBusy, navAction, openBookmark, pruneAction, requestGenerationStop, rerouteFromMap, type ActionContext } from "./story-actions.js";
import { createWrapCache, type ProseStyle } from "./wrap.js";
import { deriveGenerationRuntime } from "./runtime-settings.js";
import {
  ActionRuntime,
  beginInteraction,
  withActionAdmission,
  type ActionRunner
} from "./action-runtime.js";
import { startRecoveryOrchestration } from "./recovery-orchestration.js";
import { inlineEditorAction } from "./editor-action.js";
import { emptyStreamText } from "./stream-text.js";
import { selectionAwarePartMenuAction } from "./selection-menu.js";
import {
  EMPTY_NATIVE_SELECTION,
  consumesEmptyCopyShortcut,
  handleMainCopyShortcut,
  nativeSelectionMatches,
  syncMouseComposerSelection
} from "./copy-actions.js";
import {
  capturePresentedInputSelection,
  consumePresentedSelection,
  hasCopyablePresentedSelection,
  reconcilePresentedSelection,
  retirePresentedSelection
} from "./presented-selection.js";
import type { BackgroundUpdateStarter } from "./update-runtime.js";

export { recoveryNotice } from "./recovery-orchestration.js";

/** Exactly one backend behind `api` — the live server or the demo fixture
 *  adapter. Nothing below this type ever branches on which one it is. */
export interface AppSource {
  payload: StoryPayload;
  api: StoryApi;
  demo: boolean;
  stories: StorySummary[];
  settingsView: SettingsView;
  settings: GenerationSettings;
  storyFolder: string;
  /** ADR007 §4: where `/export` writes. The project root, or the working
   * directory when this client attached to a server instead of a project. */
  exportDirectory: string;
  connection: ConnectionMonitor | null;
  backendRecovery?: RecoveryWarningFeed;
  backendFailure?: Promise<Error>;
  startUpdateCheck?: BackgroundUpdateStarter;
  config: UserConfig;
}

type InteractivePresentedInteraction = PresentedInteraction & {
  composerSelectionProjection: RuntimeState["composerSelectionProjection"];
  storySelectionProjection: RuntimeState["storySelectionProjection"];
};

export async function renderOnce(source: AppSource, width: number, height: number, keys = ""): Promise<string> {
  const palette = createPalette(source.config.theme);
  const setup = await createTestRenderer({ width, height, backgroundColor: palette.color("background") });
  const state = initialState(source, true);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const cancelRenderStream = async () => {
    state.stream = null;
    state.abort = null;
  };
  // Theme changes apply to the frame but never persist from render-once.
  const applyThemeInFrame = (theme: ThemeName) => {
    source.config = { ...source.config, theme };
    state.config = source.config;
  };
  for (const character of [...keys]) {
    // The render-once demo paints a synthetic empty stream without a runtime
    // controller. Plan 010's `--keys "C"` fixture starts from the settled
    // page so the structural action can travel through the normal dispatcher.
    if (character === "C" && state.stream !== null && state.abort === null && state.stream.text.length === 0) {
      await cancelRenderStream();
    }
    const pending = handleKey(keyFromCharacter(character), state, source, cache, () => undefined,
      cancelRenderStream, () => undefined, null, applyThemeInFrame, () => undefined, backend);
    // Summary streaming is the one render-once fixture intentionally captured
    // mid-task. Interactive callers already observe the dispatcher Promise.
    if (state.abort?.kind === "summary") backend.observe(pending);
    else await pending;
  }
  const frame = renderStoryScreen(state, {
    width,
    height,
    wrapCache: cache,
    ...(state.stream === null ? {} : { viewportAnchorId: state.stream.targetId })
  }).lines;
  const text = new TextRenderable(setup.renderer, {
    id: "story",
    width,
    height,
    wrapMode: "none",
    bg: palette.color("background"),
    content: frameStyledText(frame, palette)
  });
  setup.renderer.root.add(text);
  await setup.renderOnce();
  const captured = setup.captureCharFrame();
  state.abort?.controller.abort();
  backend.dispose();
  setup.renderer.destroy();
  return captured;
}

export async function runInteractive(source: AppSource): Promise<void> {
  let palette = createPalette(source.config.theme);
  const profileEnabled = process.env.AI_1667_TUI_PROFILE === "1";
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    backgroundColor: palette.color("background"),
    // Mouse drives focus, lists, scrolling and the part menu (lazygit-style).
    // Terminals still select text on shift-drag, and y/Y copy without the
    // mouse at all.
    useMouse: true,
    gatherStats: profileEnabled
  });
  const previewTheme = (theme: ThemeName | null) => {
    palette = createPalette(theme ?? source.config.theme);
    surface.setBackground(palette.color("background"));
    repaint();
  };
  const applyTheme = (theme: ThemeName) => {
    source.config = { ...source.config, theme };
    state.config = source.config;
    saveConfig(source.config);
    palette = createPalette(theme);
    surface.setBackground(palette.color("background"));
    repaint();
  };
  const wrapCache = createWrapCache<ProseStyle>();
  const state = initialState(source, false);
  const surface = createStorySurface(renderer, palette);
  const gateMouseAction = createSelectionSafeMouseGate();
  let builtInteraction: InteractivePresentedInteraction | null = null;
  let presentedInteraction: InteractivePresentedInteraction | null = null;
  let onPresented: () => void = () => undefined;
  let onPresentationFailure: () => void = () => undefined;
  let exited = false;
  let profileReport: TuiFrameProfileReport | null = null;
  let backendFailure: Error | null = null;
  let stopRecoveryOrchestration: (() => void) | null = null;
  let stopUpdateCheck: (() => void) | null = null;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });

  const frames = createInteractiveFrameRuntime({
    state,
    renderer,
    surface,
    palette: () => palette,
    wrapCache,
    onBuilt(version, interactive, frameToken) {
      if (!interactive) gateMouseAction.reset();
      builtInteraction = {
        version,
        frameToken,
        interactive,
        storyId: state.payload.id,
        state: captureMouseActionState(state),
        composerSelectionProjection: state.composerSelectionProjection,
        storySelectionProjection: state.storySelectionProjection
      };
    },
    onPresented(frameToken) {
      if (builtInteraction?.frameToken !== frameToken) return;
      const previous = presentedInteraction;
      const ownerChanged = previous !== null
        && (previous.storyId !== builtInteraction.storyId
          || previous.state.mode !== builtInteraction.state.mode);
      if (!builtInteraction.interactive || ownerChanged) {
        gateMouseAction.reset();
      }
      presentedInteraction = builtInteraction;
      queueMicrotask(onPresented);
    },
    onPresentationFailure() {
      queueMicrotask(onPresentationFailure);
    },
    onError(error) {
      gateMouseAction.reset();
      const message = `frame failed · ${error instanceof Error ? error.message : String(error)}`;
      state.toast = message;
      console.error(message);
      renderer.console.show();
    },
    profile: profileEnabled
  });
  const repaint = () => {
    frames.invalidate();
  };
  const backend = new ActionRuntime(state, repaint);
  const captureProfile = () => {
    if (!profileEnabled || profileReport !== null) return;
    let native = null;
    try { native = renderer.getStats(); } catch { /* external teardown may already own the native handle */ }
    profileReport = frames.profile(native);
  };
  const finishExit = () => {
    if (exited) return;
    exited = true;
    captureProfile();
    frames.dispose();
    stopRecoveryOrchestration?.();
    stopUpdateCheck?.();
    backend.dispose();
    source.connection?.dispose();
    resolveExit();
  };
  const quit = () => {
    if (exited) return;
    captureProfile();
    renderer.destroy();
    finishExit();
  };
  renderer.on(CliRenderEvents.DESTROY, finishExit);
  void source.backendFailure?.then((error) => {
    if (exited) return;
    backendFailure = error;
    quit();
  });
  stopRecoveryOrchestration = startRecoveryOrchestration({
    state,
    source,
    backend,
    invalidateCache: () => wrapCache.invalidate(),
    repaint
  });
  // The generation task owns partial-save/reload reconciliation. Escape only
  // restores responsive UI and signals it; ownership remains until settlement.
  const cancelStream = async () => {
    requestGenerationStop(state, repaint);
  };
  const requestQuit = () => {
    if (state.stream === null && state.abort === null) return quit();
    if (!state.quitArmed) {
      state.quitArmed = true;
      state.toast = "streaming · press Ctrl+C again to discard and quit";
      repaint();
      return;
    }
    state.abort?.controller.abort();
    quit();
  };

  // Keyboard/paste input belongs to a presented semantic frame. If cold
  // preparation retains or replaces that frame, preserve input order and
  // resume after the matching complete frame is visible.
  const presentedFrameOwnsState = () => {
    const interaction = presentedInteraction;
    return !exited && interaction?.interactive === true
      && interaction.version === frames.version
      && interaction.frameToken === frames.frameToken
      && interaction.storyId === state.payload.id;
  };
  const inputs = createPresentedInputQueue({
    flush: () => frames.flush(),
    ready: presentedFrameOwnsState,
    recoveryExhausted: () => frames.inputRecoveryExhausted
  });
  onPresented = inputs.presented;
  onPresentationFailure = inputs.presentationFailed;
  let latestSelectionCapture: ReturnType<typeof capturePresentedInputSelection> | null = null;
  const captureQueuedSelection = () => {
    latestSelectionCapture = capturePresentedInputSelection(
      renderer, presentedInteraction, latestSelectionCapture, frames.failed
    );
    return latestSelectionCapture;
  };

  renderer.keyInput.on("keypress", (key) => {
    const controlCopy = key.ctrl && key.name === "c";
    if (controlCopy && frames.failed) return requestQuit();
    const queuedSelection = captureQueuedSelection();
    const copySurface = consumesEmptyCopyShortcut(state)
      || (presentedInteraction !== null
        && consumesEmptyCopyShortcut(presentedInteraction.state));
    if (controlCopy && !hasCopyablePresentedSelection(queuedSelection) && !copySurface
      && inputs.shouldQuitImmediately(state.mode, false)) {
      return requestQuit();
    }
    const queuedKey = { ...key } as KeyEvent;
    inputs.enqueue(() => {
      const selection = reconcilePresentedSelection(queuedSelection, frames.version, state);
      if (selection.kind === "stale") {
        retirePresentedSelection(renderer, queuedSelection);
        return;
      }
      const native = selection.kind === "captured"
        ? selection.native ?? EMPTY_NATIVE_SELECTION
        : EMPTY_NATIVE_SELECTION;
      if (controlCopy && handleMainCopyShortcut(
        native,
        state,
        repaint,
        requestQuit,
        selection.kind === "captured" ? selection : undefined
      )) return;
      if (selection.kind === "captured" && selection.native !== null) {
        syncMouseComposerSelection(selection.native, state, selection.composer);
        if (nativeSelectionMatches(renderer, selection.native)) renderer.clearSelection();
      }
      consumePresentedSelection(queuedSelection);
      return observeInputAdmission((admit) => handleKey(
        queuedKey,
        state,
        source,
        wrapCache,
        () => { repaint(); admit(); },
        () => { admit(); return cancelStream(); },
        requestQuit,
        renderer,
        applyTheme,
        previewTheme,
        withActionAdmission(backend, admit)
      ), (work) => backend.observe(work));
    }, () => {
      retirePresentedSelection(renderer, queuedSelection);
      if (controlCopy) requestQuit();
    });
  });
  renderer.keyInput.on("paste", (event) => {
    const text = new TextDecoder().decode(event.bytes);
    const queuedSelection = captureQueuedSelection();
    inputs.enqueue(() => {
      const selection = reconcilePresentedSelection(queuedSelection, frames.version, state);
      if (selection.kind === "stale") {
        retirePresentedSelection(renderer, queuedSelection);
        return;
      }
      if (selection.kind === "captured" && selection.native !== null) {
        syncMouseComposerSelection(selection.native, state, selection.composer);
        if (nativeSelectionMatches(renderer, selection.native)) renderer.clearSelection();
      }
      consumePresentedSelection(queuedSelection);
      if (sanitizePastedText(text).length > 0
        && state.mode === "SETTINGS"
        && state.settings !== null) {
        beginSettingsPasteEdit(state.settings, state.config);
      }
      if (pasteInto(state, text)) { beginInteraction(state); repaint(); }
    }, () => retirePresentedSelection(renderer, queuedSelection));
  });
  surface.onMouse((event) => {
    // Coordinates belong to the frame visible when OpenTUI emitted them.
    // A queued repaint does not supersede that frame until it is presented.
    const interaction = presentedInteraction;
    if (!canCapturePresentedMouseAction(interaction, frames.failed)) {
      gateMouseAction.reset();
      // Partial pixels cannot own coordinates, but the discarded gesture may
      // still claim the one bounded repaint recovery.
      frames.requestInputRecovery();
      return;
    }
    // Mouse-up re-resolves the down target against the currently visible
    // frame. Animated repaints survive; semantic row changes cancel the click.
    let resolved = gateMouseAction.resolve(
      event, mouseToAction(event, interaction.state, event.type === "up")
    );
    resolved = selectionAwarePartMenuAction(
      event, resolved, renderer, interaction.storySelectionProjection
    );
    if (resolved === null) return;
    if (interaction !== presentedInteraction) return;
    const queuedEvent = freezeMouseEvent(event);
    inputs.enqueue(() => {
      const reconciled = reconcilePresentedMouseAction({
        action: resolved, event: queuedEvent, captured: interaction,
        presented: presentedInteraction, currentVersion: frames.version, state
      });
      if (reconciled === null) return;
      return observeInputAdmission((admit) => dispatch(
        reconciled,
        state,
        source,
        wrapCache,
        () => { repaint(); admit(); },
        () => { admit(); return cancelStream(); },
        requestQuit,
        renderer,
        applyTheme,
        previewTheme,
        withActionAdmission(backend, admit)
      ), (work) => backend.observe(work));
    });
  });
  renderer.on(CliRenderEvents.RESIZE, () => {
    frames.invalidate("resize");
  });
  repaint();
  // One-shot requestRender frames while idle; renderables may request a live
  // loop explicitly when they own native animation.
  renderer.auto();
  stopUpdateCheck = source.startUpdateCheck?.((message) => {
    if (exited || state.toast !== null) return;
    state.toast = message;
    repaint();
  }) ?? null;

  if (source.demo) {
    state.focusIndex = lastPartRowIndex(createStoryViewModel(state.payload));
    backend.observe(backend.run("generating prose", (task) =>
      generate(state, source, wrapCache, repaint, "", null, null, task)));
  }
  await exit;
  if (profileReport !== null) {
    process.stderr.write(`1667-tui-profile ${JSON.stringify(profileReport)}\n`);
  }
  if (backendFailure !== null) throw backendFailure;
}

export async function handleKey(
  key: KeyEvent,
  state: RuntimeState,
  source: AppSource,
  wrapCache: ReturnType<typeof createWrapCache<ProseStyle>>,
  repaint: () => void,
  cancelStream: () => Promise<void>,
  requestQuit: () => void,
  renderer: ActionContext["renderer"] = null,
  applyTheme: ActionContext["applyTheme"] = () => undefined,
  previewTheme: ActionContext["previewTheme"] = () => undefined,
  backend: ActionRunner = new ActionRuntime(state, repaint)
): Promise<void> {
  if (key.ctrl && key.name === "c"
    && state.mode !== "EDITOR"
    && consumesEmptyCopyShortcut(state)) {
    return;
  }
  if (key.ctrl && key.name === "c" && state.mode !== "EDITOR") return requestQuit();
  const resolved = resolveKey(key, state.mode, {
    confirmingPrune: state.prune !== null,
    bookmarkChoosingLabel: state.bookmark?.choosingLabel ?? false,
    connectionDown: state.connection.down,
    overlayTyping: overlayTextInputActive(state),
    commandsBookmarks: state.commands?.view === "bookmarks",
    mapView: state.map?.view
  });
  return await dispatch(resolved, state, source, wrapCache, repaint, cancelStream, requestQuit,
    renderer, applyTheme, previewTheme, backend);
}

/** Everything after key resolution — shared by the keyboard and the mouse. */
export async function dispatch(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  wrapCache: ReturnType<typeof createWrapCache<ProseStyle>>,
  repaint: () => void,
  cancelStream: () => Promise<void>,
  requestQuit: () => void,
  renderer: ActionContext["renderer"] = null,
  applyTheme: ActionContext["applyTheme"] = () => undefined,
  previewTheme: ActionContext["previewTheme"] = () => undefined,
  backend: ActionRunner = new ActionRuntime(state, repaint)
): Promise<void> {
  const previousMode = state.mode;
  beginInteraction(state);
  if (generationBusy(state) && resolved.action === "cancel" && isPlainNavigation(state)) return await cancelStream();
  if (state.toast !== null) state.toast = null;
  state.quitArmed = false;
  // The part menu carries its own per-action guard (Copy stays legal during a
  // stream), so the blanket one would wrongly refuse it here.
  if (generationBusy(state) && state.actions === null && MUTATING_ACTIONS.has(resolved.action)) {
    state.toast = "stream running · esc stops it first";
    return repaint();
  }
  const context: ActionContext = {
    cache: wrapCache, repaint, backend, renderer, applyTheme, previewTheme
  };
  // Recovery belongs to the connection banner, above transient part menus
  // and confirmations. Those surfaces stay open while retry runs; otherwise
  // their reducers would swallow the banner's advertised keyboard/click action.
  if (resolved.action === "retry") await handleOverlayAction(resolved, state, source, context);
  else if (state.prune !== null) await pruneAction(resolved, state, source, context);
  else if (state.actions !== null) await actionsMenuAction(resolved, state, source, context);
  else if (await handleOverlayAction(resolved, state, source, context)) { /* handled */ }
  else if (resolved.action === "toggle-context-meter" && (state.mode === "NAV" || state.mode === "COMPOSE")) {
    state.contextMeterExpanded = !state.contextMeterExpanded;
  }
  else if (state.mode === "MAP") await mapAction(resolved, state, source, {
    ...context,
    reroute: rerouteFromMap,
    armPrune,
    openBookmark
  });
  else if (state.mode === "BOOKMARK") await bookmarkAction(resolved, state, source, context);
  else if (state.mode === "COMPOSE") await composeAction(resolved, state, source, context);
  else if (state.mode === "EDITOR") await inlineEditorAction(resolved, state, source, context);
  else if (state.mode === "KEYS") { if (resolved.action === "cancel") state.mode = "NAV"; }
  else if (state.mode === "NAV" && await directChapterRowAction(resolved, state, source, context)) { /* handled */ }
  else await navAction(resolved, state, source, context, requestQuit);
  // Native buffer offsets must not leak between the story, Direct, and the
  // full-screen editor when their rendered document changes.
  const previousTextSurface = previousMode === "COMPOSE" || previousMode === "EDITOR";
  const currentTextSurface = state.mode === "COMPOSE" || state.mode === "EDITOR";
  if (state.mode !== previousMode && (previousTextSurface || currentTextSurface)) {
    renderer?.clearSelection();
  }
  repaint();
}

export function initialState(source: AppSource, renderMode: boolean): RuntimeState {
  const view = createStoryViewModel(source.payload);
  const demoPathIndex = Math.max(0, source.payload.path.length - 2);
  const initialFocus = source.demo
    ? Math.max(0, rowIndexForPathIndex(view, demoPathIndex))
    : lastPartRowIndex(view);
  return {
    payload: source.payload,
    focusIndex: initialFocus,
    mode: source.payload.path.length === 0 ? "COMPOSE" : "NAV",
    showInstructions: true,
    expandedPromptIds: new Set(),
    composer: createComposer(),
    editor: null,
    retakePrompt: null,
    toast: null,
    unknownOutcomes: [],
    unknownOutcomeAcknowledgementArmed: null,
    stream: renderMode && source.demo ? leafStreamView(source.payload) : null,
    freshLandedAt: new Map(),
    now: 1_667_000_000_000,
    ...deriveGenerationRuntime(source.settings, source.demo),
    map: null,
    contextMeterExpanded: false,
    prune: null,
    bookmark: null,
    expandedChapterSummaryIds: new Set(),
    chapterDeleteArmedId: null,
    typewriter: false,
    actions: null,
    hitRows: [],
    viewScroll: null,
    viewScrollDelta: 0,
    lastViewportStart: 0,
    composerScrollTop: 0,
    editorScrollTop: 0,
    composerSelectionProjection: null,
    storySelectionProjection: null,
    demo: source.demo,
    config: source.config,
    storyFolder: source.storyFolder,
    library: null,
    facts: null,
    commands: null,
    chapters: null,
    settings: null,
    summary: null,
    connection: source.connection?.state() ?? { down: false, attempt: 0, nextRetryAt: null, error: null },
    undo: [],
    history: [],
    historyIndex: 0,
    historyDraft: null,
    abort: null,
    pendingGenerationDraft: null,
    composerClaimEpoch: 0,
    quitArmed: false,
    interactionVersion: 0,
    backendTask: null
  };
}

/** The render-once mockup shows the leaf mid-stream, matching the design grids. */
function leafStreamView(payload: StoryPayload): StreamView | null {
  const leaf = payload.path.at(-1);
  if (leaf === undefined) return null;
  return {
    targetId: leaf.id,
    parentId: leaf.parentId,
    append: true,
    startedAt: payload.updatedAt,
    instruction: "",
    ...emptyStreamText()
  };
}

function keyFromCharacter(character: string): KeyEvent {
  const name = character === "\u001b" ? "escape"
    : character === "\r" || character === "\n" ? "return"
      : character === " " ? "space"
        : character;
  return {
    name,
    sequence: character,
    raw: character,
    ctrl: false,
    meta: false,
    shift: character.toUpperCase() === character && character.toLowerCase() !== character,
    option: false,
    number: false,
    eventType: "press",
    source: "raw",
    preventDefault() {},
    stopPropagation() {},
    defaultPrevented: false,
    propagationStopped: false
  } as unknown as KeyEvent;
}

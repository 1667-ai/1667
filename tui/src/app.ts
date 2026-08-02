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
  actionConflictsWithGeneration,
  isPlainNavigation,
  overlayTextInputActive,
  pasteInto,
  resolveKey,
  sanitizePastedText,
  type ResolvedKey
} from "./keys.js";
import { captureMouseActionState } from "./mouse-actions.js";
import { createInteractiveInputAdmission } from "./interactive-input-admission.js";
import { createStoryViewModel, lastPartRowIndex, rowIndexForPathIndex } from "./model.js";
import { openingFocusIndex, readingPartIdFor, type ReadingPositions } from "./reading-position.js";
import { bindLiveReadingPositionState } from "./reading-position-persist.js";
import { handleOverlayAction } from "./overlay-actions.js";
import { createNoticeLog, recordSessionNotices } from "./notice-log.js";
import { openSettingsPasteTarget } from "./editor-open.js";
import { createPalette } from "./palette.js";
import {
  createPresentedInputQueue,
  observeInputAdmission
} from "./presented-input-queue.js";
import {
  reconcilePresentedMouseAction,
  type PresentedInteraction
} from "./presented-mouse-action.js";
import { renderStoryScreen } from "./screens/story.js";
import { frameStyledText } from "./screens/story/frame.js";
import type { RuntimeState, StreamView } from "./state.js";
import { createStorySurface } from "./story-surface.js";
import { createComposer } from "./composer-model.js";
import { mapAction } from "./map-actions.js";
import { searchAction } from "./search-actions.js";
import { abortPendingSearch } from "./search-request.js";
import { actionsMenuAction, armPrune, tagAction, composeAction, generate, generationBusy, navAction, openTag, pruneAction, requestGenerationStop, rerouteFromMap, type ActionContext } from "./story-actions.js";
import { createWrapCache, type ProseStyle } from "./wrap.js";
import { deriveContinuationRuntime } from "./runtime-settings.js";
import {
  ActionRuntime,
  beginInteraction,
  withActionAdmission,
  type ActionRunner
} from "./action-runtime.js";
import { startRecoveryOrchestration } from "./recovery-orchestration.js";
import { inlineEditorAction } from "./editor-action.js";
import { requestRewriteStop } from "./rewrite-action.js";
import { emptyStreamText } from "./stream-text.js";
import { selectionAwarePartMenuAction } from "./selection-menu.js";
import {
  EMPTY_NATIVE_SELECTION,
  clearNativeSelectionIfMatches,
  consumesEmptyCopyShortcut,
  handleMainCopyShortcut,
  mouseComposerSelectionMessage,
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
  /** Where `/export` writes. The project root, or the working
   * directory when this client attached to a server instead of a project. */
  exportDirectory: string;
  connection: ConnectionMonitor | null;
  backendRecovery?: RecoveryWarningFeed;
  backendFailure?: Promise<Error>;
  startUpdateCheck?: BackgroundUpdateStarter;
  config: UserConfig;
  /** Local changing store: last focused part per story. Not settings. */
  readingPositions: ReadingPositions;
  /** How long typing pauses before a search scan starts. Tests and fixtures
   *  that answer from memory set 0; production leaves it unset. */
  searchDebounceMs?: number;
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
  // A frame is captured the moment the keys land, so a scan still waiting out
  // a pause has nothing left to draw to. This path is not demo-only — an
  // embedded or HTTP source reaches it too, and its transport closes next.
  if (state.search !== null) abortPendingSearch(state.search);
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
  const inputAdmission = createInteractiveInputAdmission();
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
      if (!interactive) {
        inputAdmission.reset();
      }
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
        inputAdmission.reset();
      }
      presentedInteraction = builtInteraction;
      queueMicrotask(onPresented);
    },
    onPresentationFailure() {
      queueMicrotask(onPresentationFailure);
    },
    onError(error) {
      inputAdmission.reset();
      const message = `frame failed · ${error instanceof Error ? error.message : String(error)}`;
      state.toast = message;
      console.error(message);
      renderer.console.show();
    },
    profile: profileEnabled
  });
  const repaint = () => {
    // A backend task can raise a notice long after the key that started it, so
    // the log is filled here as well as at the end of `dispatch`.
    recordSessionNotices(state);
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
    // A scan waiting out a pause must not outlive the app and reach for a
    // transport that is closing.
    if (state.search !== null) abortPendingSearch(state.search);
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
  // The generation or rewrite task owns partial-save/reload reconciliation.
  // Escape only restores responsive UI and signals it; ownership remains
  // until settlement.
  const cancelStream = async () => {
    if (state.abort?.kind === "rewrite") requestRewriteStop(state, repaint);
    else requestGenerationStop(state, repaint);
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
    // Keyboard admission clears pending mouse click gestures at one site.
    inputAdmission.enqueueText(inputs, () => {
      const selection = reconcilePresentedSelection(queuedSelection, frames.version, state);
      if (selection.kind === "stale") {
        retirePresentedSelection(renderer, queuedSelection);
        return;
      }
      const native = selection.kind === "captured"
        ? selection.native ?? EMPTY_NATIVE_SELECTION
        : EMPTY_NATIVE_SELECTION;
      if (controlCopy) {
        const copied = handleMainCopyShortcut(
          native,
          state,
          repaint,
          requestQuit,
          selection.kind === "captured" ? selection : undefined
        );
        if (copied) {
          if (selection.kind === "captured"
            && selection.native !== null
            && syncMouseComposerSelection(
              selection.native,
              state,
              selection.composer
            ) === "uneditable") {
            clearNativeSelectionIfMatches(renderer, selection.native);
            consumePresentedSelection(queuedSelection);
          }
          return;
        }
      }
      if (selection.kind === "captured" && selection.native !== null) {
        const synced = syncMouseComposerSelection(
          selection.native,
          state,
          selection.composer
        );
        if ((synced === "mixed" || synced === "uneditable")) {
          clearNativeSelectionIfMatches(renderer, selection.native);
        }
        if (synced === "mixed" && queuedKey.name.toLowerCase() !== "escape") {
          consumePresentedSelection(queuedSelection);
          state.toast = mouseComposerSelectionMessage(state, synced);
          repaint();
          return;
        }
        if (synced === "uneditable" && queuedKey.name.toLowerCase() !== "escape") {
          consumePresentedSelection(queuedSelection);
          state.toast = mouseComposerSelectionMessage(state, synced);
          repaint();
          return;
        }
        if (synced !== "mixed" && synced !== "uneditable") {
          clearNativeSelectionIfMatches(renderer, selection.native);
        }
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
    // Paste admission clears pending mouse click gestures at the same site.
    inputAdmission.enqueueText(inputs, () => {
      const selection = reconcilePresentedSelection(queuedSelection, frames.version, state);
      if (selection.kind === "stale") {
        retirePresentedSelection(renderer, queuedSelection);
        return;
      }
      if (selection.kind === "captured" && selection.native !== null) {
        const synced = syncMouseComposerSelection(
          selection.native,
          state,
          selection.composer
        );
        if (synced === "mixed" || synced === "uneditable") {
          clearNativeSelectionIfMatches(renderer, selection.native);
        }
        if (synced === "mixed") {
          consumePresentedSelection(queuedSelection);
          state.toast = mouseComposerSelectionMessage(state, synced);
          repaint();
          return;
        }
        if (synced === "uneditable") {
          consumePresentedSelection(queuedSelection);
          state.toast = mouseComposerSelectionMessage(state, synced);
          repaint();
          return;
        }
        clearNativeSelectionIfMatches(renderer, selection.native);
      }
      consumePresentedSelection(queuedSelection);
      if (sanitizePastedText(text).length > 0
        && state.mode === "SETTINGS"
        && state.settings !== null) {
        openSettingsPasteTarget(state);
      }
      if (state.mode === "SEARCH" && state.search !== null) {
        const clean = sanitizePastedText(text);
        if (clean.length > 0) {
          const line = clean.replace(/\n+/g, " ");
          void dispatch(
            { action: "input", text: line },
            state,
            source,
            wrapCache,
            repaint,
            cancelStream,
            requestQuit,
            renderer,
            applyTheme,
            previewTheme,
            backend
          );
        }
      } else if (pasteInto(state, text)) {
        beginInteraction(state);
        repaint();
      }
    }, () => retirePresentedSelection(renderer, queuedSelection));
  });
  surface.onMouse((event) => {
    // Coordinates belong to the frame visible when OpenTUI emitted them.
    // A queued repaint does not supersede that frame until it is presented.
    // Capture against the visible frame, then keep FIFO order. Keyboard/paste
    // interrupt incomplete multi-event gates at enqueue time; already-queued
    // mouse actions still run before later keys (select-then-Enter, etc.).
    inputAdmission.enqueueMouse(inputs, event, {
      presented: presentedInteraction,
      frameFailed: frames.failed,
      requestInputRecovery: () => frames.requestInputRecovery(),
      stillPresented: (captured) => captured === presentedInteraction,
      decorate: (resolved, gesture, presented) => selectionAwarePartMenuAction(
        gesture as never,
        resolved,
        renderer,
        (presented as InteractivePresentedInteraction).storySelectionProjection
      ),
      run: (action, queuedEvent, captured) => {
        const reconciled = reconcilePresentedMouseAction({
          action, event: queuedEvent, captured,
          presented: presentedInteraction, state
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
      }
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
  if (key.ctrl && key.name === "c"
    && state.mode !== "EDITOR") {
    return requestQuit();
  }
  const resolved = resolveKey(key, state.mode, {
    confirmingPrune: state.prune !== null,
    tagChoosingStatus: state.tag?.choosingStatus ?? false,
    connectionDown: state.connection.down,
    overlayTyping: overlayTextInputActive(state),
    settingsSampling: state.settings !== null && state.settings.sampling !== null,
    commandsTags: state.commands?.view === "tags",
    settingsPicker: state.settings?.modelPicker != null,
    factEditor: state.editor?.kind === "fact",
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
  if (generationBusy(state) && state.actions === null
    && actionConflictsWithGeneration(resolved.action, state)) {
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
    openTag
  });
  else if (state.mode === "SEARCH") await searchAction(resolved, state, source, context);
  else if (state.mode === "TAG") await tagAction(resolved, state, source, context);
  else if (state.mode === "COMPOSE") await composeAction(resolved, state, source, context);
  else if (state.mode === "EDITOR") await inlineEditorAction(resolved, state, source, context);
  else if (state.mode === "NAV" && await directChapterRowAction(resolved, state, source, context)) { /* handled */ }
  else await navAction(resolved, state, source, context, requestQuit);
  // Native buffer offsets must not leak between the story, Direct, and the
  // full-screen editor when their rendered document changes.
  const previousTextSurface = previousMode === "COMPOSE"
    || previousMode === "EDITOR";
  const currentTextSurface = state.mode === "COMPOSE"
    || state.mode === "EDITOR";
  if (state.mode !== previousMode && (previousTextSurface || currentTextSurface)) {
    renderer?.clearSelection();
  }
  recordSessionNotices(state);
  repaint();
}

export function initialState(source: AppSource, renderMode: boolean): RuntimeState {
  const view = createStoryViewModel(source.payload);
  const demoPathIndex = Math.max(0, source.payload.path.length - 2);
  const initialFocus = source.demo
    ? Math.max(0, rowIndexForPathIndex(view, demoPathIndex))
    : openingFocusIndex(
      source.payload,
      readingPartIdFor(source.readingPositions, source.payload.id)
    );
  const state: RuntimeState = {
    payload: source.payload,
    focusIndex: initialFocus,
    readingPositions: source.readingPositions,
    mode: source.payload.path.length === 0 ? "COMPOSE" : "NAV",
    showInstructions: true,
    expandedPromptIds: new Set(),
    composer: createComposer(),
    editor: null,
    retakePrompt: null,
    request: null,
    toast: null,
    notices: createNoticeLog(),
    stream: renderMode && source.demo ? leafStreamView(source.payload) : null,
    freshLandedAt: new Map(),
    now: 1_667_000_000_000,
    ...deriveContinuationRuntime(source.settingsView, source.demo),
    map: null,
    search: null,
    contextMeterExpanded: false,
    prune: null,
    tag: null,
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
    keysScrollTop: 0,
    composerSelectionProjection: null,
    storySelectionProjection: null,
    demo: source.demo,
    config: source.config,
    storyFolder: source.storyFolder,
    library: null,
    facts: null,
    commands: null,
    card: null,
    archive: null,
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
  bindLiveReadingPositionState(state);
  return state;
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

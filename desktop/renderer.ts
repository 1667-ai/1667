import { apiErrorCode } from "../client/api-error.js";
import { textHash, type StoryApi } from "../client/api.js";
import {
  MAX_SOURCE_IMAGE_BYTES,
  imageMediaTypeLabel,
  isSourceImageMediaType,
  type DraftImageReference,
  type SourceImageMediaType
} from "../shared/image-attachment.js";
import type { StoryFact, StoryPathNode, StoryPayload } from "../shared/types.js";
import type { SearchHit } from "../shared/story-search.js";
import { pathTo, subtreeCount } from "../shared/story-tree.js";
import { rememberedLeafId } from "../shared/story-model.js";
import {
  INITIAL_STATE,
  makeMutationId,
  persistDesktopDirections,
  persistDesktopInspectorHidden,
  persistDesktopTheme,
  storyHasUnsavedDrafts,
  type RendererActions,
  type RendererDialogField,
  type RendererDialog,
  type RendererState,
  type RendererTab,
  type RendererRecoveryWarning,
  type DesktopTheme,
  type LogEntry,
  type StreamMode,
  type TextSelection
} from "./renderer-model.js";
import { renderApp } from "./renderer-view.js";
import { createFeedbackClearHandler, updateFeedbackDom } from "./renderer-shell-view.js";
import { RendererContextController, shouldAppendRendererContinuation } from "./renderer-context.js";
import { createRendererApi, desktopShell, messageOf } from "./renderer-runtime.js";
import type { DesktopShellRequest, DesktopShellResponse } from "./renderer-shell-contract.js";
import { RendererShellController } from "./renderer-shell-controller.js";
import { RendererKeysController } from "./renderer-keys-controller.js";
import type { RendererCommandContext } from "./renderer-command-context.js";
import {
  createChapter,
  createFact,
  deleteFact,
  deleteFactState,
  editBannedStrings,
  editFact,
  editPhraseBias,
  editFactState,
  exportMarkdown,
  importMarkdown,
  importCard,
  importLorebook,
  runFactConsistency,
  showFactConsistency,
  moveFact,
  pasteLine,
  pruneUnused,
  removeChapter,
  removeTag,
  renameChapter,
  restoreChapter,
  editChapterSummary,
  summarizeChapter,
  tagLine,
  takeFromCut,
  copyLine
} from "./renderer-story-commands.js";
import {
  addFactStateAt,
  dismissFinding,
  revertFactEditor,
  saveFactEditor,
  selectFact,
  setFactDraft,
  startNewFactDraft
} from "./renderer-facts-commands.js";
import { factEditorDirty } from "./renderer-facts-model.js";
import { manageTags } from "./renderer-tag-commands.js";
import {
  askAside,
  clearAside,
  clearAsideSession,
  deleteAsideTurn,
  emptyAsideState,
  loadAside,
  resetAside,
  retakeAside,
  selectAsideAnchor,
  selectAsideSession,
  stopAside
} from "./renderer-aside-commands.js";
import { retakeLine, rewriteLine, summarizeLine } from "./renderer-generation-commands.js";
import { eyebrowFor, submitLabel } from "./renderer-composer-view.js";
import { createSettingsEditorState, RendererSettingsController } from "./renderer-settings-controller.js";
import { settingsDraftDirty } from "./renderer-settings-diff.js";

const root = document.querySelector<HTMLElement>("#app");
if (root === null) throw new Error("Desktop renderer root is missing.");
const renderRoot: HTMLElement = root;

class RendererApp {
  private state: RendererState = INITIAL_STATE;
  private api: StoryApi | null = null;
  private asideController: AbortController | null = null;
  private dialogResolver: ((value: string | null) => void) | null = null;
  private shellController: RendererShellController | null = null;
  private keysController: RendererKeysController | null = null;
  private connectInFlight: Promise<void> | null = null;
  private connectedProjectRoot: string | null = null;
  private searchSequence = 0;
  private createStorySequence = 0;
  private loadStorySequence = 0;
  private generationStartInFlight = false;
  private compositionActive = false;
  private compositionRenderPending = false;
  private dialogReturnFocus: { readonly containerKey?: string; readonly className?: string } | null = null;
  private readonly contextController = new RendererContextController((context) => this.setState({ requestContext: context }));
  private readonly settingsController = new RendererSettingsController({
    state: () => this.state,
    setState: (update) => this.setState(update),
    api: () => this.requireApi(),
    run: (status, work) => this.run(status, work),
    textDialog: (title, value, message, multiline) => this.textDialog(title, value, message, multiline),
    confirmDialog: (title, message) => this.confirmDialog(title, message)
  });

  private readonly actions: RendererActions = {
    setTab: (tab) => this.setTab(tab),
    setSettingsSection: (section) => this.setState({ settingsSection: section }),
    focusPart: (id) => this.setState({ focusedPartId: id }),
    editPart: (id) => this.setState(id === null ? { editingPartId: null } : { editingPartId: id, focusedPartId: id }),
    acknowledgeFactConsistencySeen: () => this.setState({ factConsistencySeen: true }),
    setSearch: (value) => { this.setState({ search: value }); void this.searchStories(value); },
    openSearchHit: (hit) => { void this.openSearchHit(hit); },
    setComposerMode: (mode) => this.setState({ composerMode: mode }),
    setComposerWriteTarget: (target) => this.setState({ composerWriteTarget: target }),
    setDirections: (show) => this.setDirections(show),
    setTheme: (theme) => this.setTheme(theme),
    setInspectorHidden: (hidden) => this.setInspectorHidden(hidden),
    setMapCursor: (id) => this.setState({ mapCursorId: id }),
    openKeys: () => this.setState({ popover: { kind: "keys" } }),
    openPalette: (group) => this.setState({ popover: { kind: "palette", query: "", group: group ?? null } }),
    openPartMenu: (partId) => this.setState({ popover: { kind: "part-menu", partId } }),
    openAsidePopover: () => this.setState({ popover: { kind: "aside" } }),
    openLog: () => this.setState({ popover: { kind: "log" } }),
    setPaletteQuery: (value) => {
      if (this.state.popover?.kind === "palette") this.setState({ popover: { ...this.state.popover, query: value } });
    },
    closePopover: () => this.setState({ popover: null }),
    toast: (text) => this.setState({ status: text, error: null }),
    saveCurrentEdit: () => this.keysController?.saveCurrentEdit(),
    setDraft: (key, value) => this.setDraft(key, value),
    setAuthPromptValue: (value) => this.setState({ authPromptValue: value }),
    submitDialog: (value) => this.resolveDialog(value),
    setDialogValue: (value) => {
      if (this.state.dialog !== null) this.setState({ dialog: { ...this.state.dialog, value } });
    },
    setDialogField: (id, value) => {
      const dialog = this.state.dialog;
      if (dialog?.kind !== "form" || dialog.fields === undefined) return;
      this.setState({
        dialog: {
          ...dialog,
          fields: dialog.fields.map((field) => field.id === id ? { ...field, value } : field)
        }
      });
    },
    cancelDialog: () => this.resolveDialog(null),
    selectStory: (id) => { void this.selectStory(id); },
    createStory: () => { void this.createStory(); },
    renameStory: () => { void this.renameStory(); },
    autonameStory: () => { void this.autonameStory(); },
    deleteStory: () => { void this.deleteStory(); },
    sealProject: () => { void this.sealProject(); },
    unsealProject: () => { void this.unsealProject(); },
    revealProject: () => { void this.revealProject(); },
    showProjects: (show) => this.setState({ showProjects: show }),
    continueStory: (mode, instruction, target) => { void this.continueStory(mode, instruction, target); },
    retakeLine: (node, options) => { void this.retakeLine(node, options); },
    rewriteLine: (node, selection) => { void this.rewriteLine(node, selection); },
    summarizeLine: () => { void this.summarizeLine(); },
    writeManual: (text, parentId) => { void this.writeManual(text, true, parentId); },
    attachImage: (file) => { void this.attachImage(file); },
    removeImage: (index) => this.removeImage(index),
    stopStream: () => this.stopStream(),
    saveStoppedGeneration: () => { void this.saveStoppedGeneration(); },
    copyStoppedGeneration: () => { void this.copyStoppedGeneration(); },
    discardStoppedGeneration: () => this.discardStoppedGeneration(),
    editNode: (node, text) => { void this.editNode(node, text); },
    saveEditedTake: (node, text) => { void this.saveEditedTake(node, text); },
    editNodeDirection: (node) => { void this.editNodeDirection(node); },
    deleteNode: (node) => { void this.deleteNode(node); },
    switchLine: (node) => { void this.switchLine(node); },
    switchNode: (nodeId) => { void this.switchNode(nodeId); },
    switchToTaggedLine: (tagName, nodeId) => { void this.switchToTaggedLine(tagName, nodeId); },
    copyLine: (node) => this.copyLine(node),
    pasteLine: (node) => { void this.pasteLine(node); },
    takeFromCut: (node, selection) => { void this.takeFromCut(node, selection); },
    pruneUnused: () => { void this.pruneUnused(); },
    tagLine: (node) => { void this.tagLine(node); },
    removeTag: (node) => { void this.removeTag(node); },
    manageTags: () => { void this.manageTags(); },
    exportMarkdown: () => { void this.exportMarkdown(); },
    importMarkdown: () => this.importMarkdown(),
    importCard: () => importCard(this.commandContext()),
    importLorebook: () => importLorebook(this.commandContext()),
    setAuthorsNote: (note, depth) => { void this.setAuthorsNote(note, depth); },
    setAuthorBrief: (brief) => { void this.setAuthorBrief(brief); },
    useAsideAnswer: () => { void this.useAsideAnswer(); },
    selectAsideAnchor: (key) => { void this.selectAsideAnchor(key); },
    editPhraseBias: () => { void this.editPhraseBias(); },
    editBannedStrings: () => { void this.editBannedStrings(); },
    setFactsBudget: (budget) => { void this.setFactsBudget(budget); },
    runFactConsistency: (scope) => { void this.runFactConsistency(scope); },
    showFactConsistency: () => { void this.showFactConsistency(); },
    dismissFinding: (key) => dismissFinding(this.commandContext(), key),
    createFact: (node, selection) => { void this.createFact(node, selection); },
    editFact: (fact) => { void this.editFact(fact.id); },
    deleteFact: (fact) => { void this.deleteFact(fact.id); },
    moveFact: (fact, direction) => { void this.moveFact(fact.id, direction); },
    editFactState: (fact, state) => { void this.editFactState(fact, state); },
    deleteFactState: (fact, state) => { void this.deleteFactState(fact, state); },
    addFactStateAnchored: (fact) => { void this.addFactStateAt(fact, "anchored"); },
    addFactStateStoryWide: (fact) => { void this.addFactStateAt(fact, "story-wide"); },
    addFactStateEnd: (fact) => { void this.addFactStateAt(fact, "end"); },
    setFactsScope: (scope) => this.setState({ factsScope: scope }),
    setFactsFilter: (value) => this.setState({ factsFilter: value }),
    selectFact: (id) => { void selectFact(this.commandContext(), id); },
    setFactDraft: (patch) => setFactDraft(this.commandContext(), patch),
    saveFactEditor: () => this.saveFactEditorDraft(),
    revertFactEditor: () => revertFactEditor(this.commandContext()),
    createChapter: (partId) => { void this.createChapter(partId); },
    renameChapter: (chapter) => { void this.renameChapter(chapter.id, chapter.title); },
    removeChapter: (chapter) => { void this.removeChapter(chapter.id, chapter.title); },
    summarizeChapter: (chapter) => { void this.summarizeChapter(chapter.id, chapter.title); },
    restoreChapter: () => { void this.restoreChapter(); },
    editChapterSummary: (chapter, node) => { void this.editChapterSummary(chapter, node); },
    askAside: (question) => { void this.askAside(question); },
    stopAside: () => this.stopAside(),
    clearAside: () => { void this.clearAside(); },
    selectAsideSession: (sessionId) => this.selectAsideSession(sessionId),
    clearAsideSession: () => { void this.clearAsideSession(); },
    resetAside: (turnIndex) => { void this.resetAside(turnIndex); },
    deleteAsideTurn: (turnIndex) => { void this.deleteAsideTurn(turnIndex); },
    retakeAside: (turnIndex) => { void this.retakeAside(turnIndex); },
    settingsEditor: {
      editField: (field, value) => this.settingsController.editField(field, value),
      editSamplingScalar: (knob, value) => this.settingsController.editSamplingScalar(knob, value),
      editSamplingList: (list, value) => this.settingsController.editSamplingList(list, value),
      editHeader: (index, name, env) => this.settingsController.editHeader(index, name, env),
      addHeader: () => this.settingsController.addHeader(),
      removeHeader: (index) => this.settingsController.removeHeader(index),
      selectProfile: (id) => this.settingsController.selectProfile(id),
      createProfile: () => this.settingsController.createProfile(),
      createConnection: () => this.settingsController.createConnection(),
      duplicateProfile: () => this.settingsController.duplicateProfile(),
      renameProfile: () => { void this.settingsController.renameProfile(); },
      deleteProfile: () => { void this.settingsController.deleteProfile(); },
      setSecret: (value) => this.settingsController.setSecret(value),
      clearSecret: () => this.settingsController.clearSecret(),
      useDiscoveredModel: (remoteId) => this.settingsController.useDiscoveredModel(remoteId),
      discoverModels: () => { void this.settingsController.discoverModels(); },
      probeContext: () => { void this.settingsController.probeContext(); },
      checkConnection: () => { void this.settingsController.checkConnection(); },
      save: () => { void this.settingsController.save(); },
      reload: () => { void this.settingsController.load(); },
      discardPending: () => { void this.settingsController.discardPending(); },
      discardDraft: () => this.settingsController.discardDraft()
    },
    refresh: () => { void this.refresh(); },
    acknowledgeRecovery: (warning) => { void this.acknowledgeRecovery(warning); },
    inspect: (kind, node) => { void this.inspect(kind, node); },
    shellRequest: (request) => this.shellRequest(request)
  };

  private commandContext(): RendererCommandContext {
    return {
      state: () => this.state,
      api: () => this.requireApi(),
      story: () => this.requireStory(),
      setState: (update) => this.setState(update),
      replaceStory: (story) => this.replaceStory(story),
      continueStory: (mode, instruction, target) => this.continueStory(mode, instruction, target),
      refresh: () => this.refresh(),
      setDraft: (key, value) => this.setDraft(key, value),
      run: (status, work) => this.run(status, work),
      textDialog: (title, value, message, multiline) => this.textDialog(title, value, message, multiline),
      choiceDialog: (title, options, value) => this.choiceDialog(title, options, value),
      formDialog: (title, fields, message) => this.formDialog(title, fields, message),
      confirmDialog: (title, message) => this.confirmDialog(title, message),
      confirmDiscardDrafts: () => this.confirmDiscardDrafts(),
      discardDrafts: () => this.discardDrafts(),
      getAsideController: () => this.asideController,
      setAsideController: (controller) => { this.asideController = controller; }
    };
  }

  start(): void {
    window.addEventListener("beforeunload", (event) => {
      if (!this.hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    });
    this.shellController = new RendererShellController({
      state: () => this.state,
      setState: (update) => this.setState(update),
      connectAndLoad: () => { void this.connectAndLoad(); },
      clearProject: () => this.clearProject(),
      api: () => this.api,
      refresh: () => this.refresh(),
      prepareProfileImport: () => this.prepareProfileImport(),
      reloadSettings: () => this.loadSettings(),
      confirmDiscardDrafts: () => this.confirmDiscardDrafts(),
      discardDrafts: () => this.discardDrafts()
    });
    this.shellController.start();
    if (desktopShell() === undefined) {
      this.setState({ project: { root: "", directory: "Demo", source: "explicit", exists: true, vault: "unsealed", open: true } });
    }
    const clearFeedbackOnNextInput = createFeedbackClearHandler(() => this.state, (status, error) => this.clearStaleFeedback(status, error));
    document.addEventListener("keydown", clearFeedbackOnNextInput, true);
    document.addEventListener("click", clearFeedbackOnNextInput, true);
    this.keysController = new RendererKeysController({
      state: () => this.state,
      actions: () => this.actions,
      setTab: (tab) => this.setTab(tab),
      closeDialog: () => this.resolveDialog(null),
      saveDirtyPart: (node, text) => { void this.editNode(node, text); },
      hasDirtySettings: () => this.hasDirtySettings(),
      saveSettingsDraft: () => { void this.settingsController.save(); },
      hasDirtyFactEditor: () => this.hasDirtyFactEditor(),
      saveFactEditorDraft: () => this.saveFactEditorDraft()
    });
    this.keysController.start();
    document.addEventListener("compositionstart", () => {
      this.compositionActive = true;
    });
    document.addEventListener("compositionend", () => {
      this.compositionActive = false;
      if (!this.compositionRenderPending) return;
      queueMicrotask(() => {
        if (this.compositionActive || !this.compositionRenderPending) return;
        this.compositionRenderPending = false;
        this.render();
      });
    });
    this.render();
    void this.connectAndLoad();
  }

  private shellRequest(request: DesktopShellRequest, discardConfirmed = false): Promise<DesktopShellResponse> {
    if (this.shellController !== null) return this.shellController.request(request, discardConfirmed);
    const response: DesktopShellResponse = { ok: false, error: { code: "unavailable", message: "The desktop shell is unavailable." } };
    this.setState({ launcherError: response.error.message });
    return Promise.resolve(response);
  }

  private clearProject(): void {
    this.state.stream?.controller.abort();
    this.asideController?.abort();
    this.asideController = null;
    this.api = null;
    this.contextController.dispose();
    this.setState({
      story: null,
      stories: [],
      settings: null,
      settingsEditor: null,
      requestContext: null,
      stream: null,
      stoppedGeneration: null,
      drafts: {},
      draftImages: [],
      aside: emptyAsideState(),
      lineClipboard: null,
      recoveryWarnings: [],
      factConsistency: null,
      factConsistencyBusy: false,
      chapterUndo: null,
      searchHits: [],
      searchBusy: false,
      inspector: null,
      loading: false,
      connection: "offline",
      status: "Choose a project",
      authPrompt: null,
      authPromptValue: "",
      authMessage: null,
      authLinks: []
    });
  }

  private openDialog(dialog: RendererDialog): Promise<string | null> {
    this.dialogResolver?.(null);
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && !focused.closest(".modal-card")) {
      const container = focused.closest<HTMLElement>("[data-preserve]");
      const className = focused.dataset.preserve === undefined
        ? [...focused.classList].find((name) => name !== "button") ?? undefined
        : undefined;
      this.dialogReturnFocus = {
        ...(focused.dataset.preserve ?? container?.dataset.preserve) === undefined
          ? {}
          : { containerKey: focused.dataset.preserve ?? container?.dataset.preserve },
        ...(className === undefined ? {} : { className })
      };
    } else {
      this.dialogReturnFocus = null;
    }
    return new Promise<string | null>((resolve) => {
      this.dialogResolver = resolve;
      this.setState({ dialog });
    });
  }

  private resolveDialog(value: string | null): void {
    const resolve = this.dialogResolver;
    const returnFocus = this.dialogReturnFocus;
    this.dialogResolver = null;
    this.dialogReturnFocus = null;
    this.setState({ dialog: null });
    if (returnFocus !== null) {
      const target = returnFocus.containerKey === undefined
        ? undefined
        : [...renderRoot.querySelectorAll<HTMLElement>("[data-preserve]")]
          .find((candidate) => candidate.dataset.preserve === returnFocus.containerKey);
      const candidate = target === undefined || returnFocus.className === undefined
        ? target
        : target.querySelector<HTMLElement>(`.${returnFocus.className}`);
      (candidate ?? (returnFocus.className === undefined ? undefined : renderRoot.querySelector<HTMLElement>(`.${returnFocus.className}`)))?.focus({ preventScroll: true });
    }
    resolve?.(value);
  }

  private async textDialog(title: string, value = "", message?: string, multiline = false, secret = false): Promise<string | null> {
    return await this.openDialog({ title, value, kind: "text", ...(message === undefined ? {} : { message }), ...(multiline ? { multiline: true } : {}), ...(secret ? { secret: true } : {}) });
  }

  private async choiceDialog(title: string, options: readonly string[], value: string): Promise<string | null> {
    return await this.openDialog({ title, value, kind: "choice", options });
  }

  private async formDialog(title: string, fields: readonly RendererDialogField[], message?: string, secret = false): Promise<Record<string, string> | null> {
    const value = await this.openDialog({ title, value: "", kind: "form", fields, ...(message === undefined ? {} : { message }), ...(secret ? { secret: true } : {}) });
    if (value === null) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      return null;
    }
  }

  private async confirmDialog(title: string, message: string): Promise<boolean> {
    return (await this.openDialog({ title, message, value: "", kind: "confirm" })) === "confirm";
  }

  private async connectAndLoad(): Promise<void> {
    if (desktopShell() !== undefined && this.state.project?.open !== true) return;
    if (this.connectInFlight !== null) return await this.connectInFlight;
    this.connectInFlight = this.openConnection();
    try {
      await this.connectInFlight;
    } finally {
      this.connectInFlight = null;
    }
  }

  private async openConnection(): Promise<void> {
    if (desktopShell() !== undefined && this.state.project?.open !== true) return;
    const projectRoot = this.state.project?.root ?? null;
    const projectChanged = this.connectedProjectRoot !== null && this.connectedProjectRoot !== projectRoot;
    if (projectChanged) this.setState({ settingsEditor: null });
    try {
      this.api = await createRendererApi((warnings: readonly {
        readonly mutationId: string;
        readonly method: string;
        readonly storyId: string | null;
        readonly providerRecovery?: RendererRecoveryWarning["providerRecovery"];
        readonly resolution: "archived" | "cleared";
        readonly error: { readonly message: string };
      }[]) => {
        this.setState({
          recoveryWarnings: warnings.map((warning) => ({
            mutationId: warning.mutationId,
            method: warning.method,
            storyId: warning.storyId,
            ...(warning.providerRecovery === undefined ? {} : { providerRecovery: warning.providerRecovery }),
            resolution: warning.resolution,
            message: warning.error.message
          }))
        });
      });
      const api = this.api;
      if (api === null) throw new Error("The desktop Host is not connected.");
      const settings = await api.getSettings();
      this.setState({ settings,
        ...(projectChanged ? { settingsEditor: null } : {}),
        loading: false,
        connection: "live",
        status: "Project ready",
        error: null
      });
      this.connectedProjectRoot = projectRoot;
      await this.refresh();
      if (this.state.tab === "settings" && this.state.settingsEditor === null) await this.loadSettings();
    } catch (error) {
      this.setState({ loading: false, connection: "offline", status: "Project unavailable", error: messageOf(error) });
    }
  }

  private setTab(tab: RendererTab): void {
    this.setState({ tab });
    if (tab === "settings" && (this.state.settings === null || this.state.settingsEditor === null)) void this.loadSettings();
  }

  private setDirections(show: boolean): void {
    persistDesktopDirections(show);
    this.setState({ showDirections: show });
  }

  private setInspectorHidden(hidden: boolean): void {
    persistDesktopInspectorHidden(hidden);
    this.setState({ inspectorHidden: hidden });
  }

  private setTheme(theme: DesktopTheme): void {
    persistDesktopTheme(theme);
    this.setState({ theme });
  }

  private async refresh(): Promise<void> {
    const api = this.requireApi();
    await this.run("Refreshing library", async () => {
      const stories = await api.listStories();
      const selectedId = this.state.story?.id;
      const selected = selectedId !== undefined && stories.some((story) => story.id === selectedId)
        ? selectedId : stories[0]?.id;
      this.setState({ stories, status: `${stories.length} stor${stories.length === 1 ? "y" : "ies"}`, error: null });
      if (selected !== undefined && selected !== selectedId) await this.loadStory(selected);
      else if (selected !== undefined && selected === selectedId) await this.reloadStoryPreservingDrafts(selected);
      if (selected === undefined && await this.confirmDiscardDrafts()) {
        await this.discardDrafts();
        this.setState({ story: null });
      }
    });
  }

  private async acknowledgeRecovery(warning: RendererRecoveryWarning): Promise<void> {
    if (warning.storyId === null) {
      this.setState({ status: "Recovery needs the owning story", error: warning.message });
      return;
    }
    await this.run("Resolving recovery", async () => {
      const payload = await this.requireApi().acknowledgeUnknownOutcomes(
        warning.storyId!,
        warning.mutationId,
        warning.providerRecovery
      );
      if (payload !== null) await this.replaceStory(payload);
      this.setState({
        recoveryWarnings: this.state.recoveryWarnings.filter((candidate) => candidate.mutationId !== warning.mutationId),
        status: "Recovery resolved",
        error: null
      });
      await this.refresh();
    });
  }

  private async selectStory(id: string): Promise<void> {
    if (await this.loadStory(id)) this.setState({ tab: "write" });
  }

  private async openSearchHit(hit: SearchHit): Promise<void> {
    if (this.state.story?.id !== hit.storyId && !await this.loadStory(hit.storyId)) return;
    if (hit.kind === "fact") {
      this.setTab("facts");
    } else {
      this.setState({ tab: "write" });
      await this.switchNode(hit.targetId);
    }
  }

  private async searchStories(query: string): Promise<void> {
    const sequence = ++this.searchSequence;
    if (query.trim().length < 2 || this.state.story === null || this.api === null) {
      this.setState({ searchHits: [], searchBusy: false });
      return;
    }
    try {
      const result = await this.api.searchStories({ query, scope: "vault", storyId: this.state.story.id, caseSensitive: false });
      if (sequence === this.searchSequence) this.setState({ searchHits: result.hits, searchBusy: false });
    } catch (error) {
      if (sequence === this.searchSequence) this.setState({ searchHits: [], searchBusy: false, error: messageOf(error) });
    }
  }

  private async loadStory(id: string): Promise<boolean> {
    const requestSequence = ++this.loadStorySequence;
    const api = this.requireApi();
    if (!await this.confirmDiscardDrafts()) return false;
    const originStory = this.state.story;
    const settingsDirty = this.hasDirtySettings();
    const originDrafts = JSON.stringify(this.state.drafts);
    const originImages = [...this.state.draftImages];
    const originImageLeases = originImages.map((image) => image.leaseId);
    const originSettings = settingsDirty
      ? JSON.stringify(this.state.settingsEditor?.draft ?? null)
      : null;
    const originFactEditor = JSON.stringify(this.state.factEditor);
    const isActiveRequest = (): boolean => requestSequence === this.loadStorySequence && this.api === api;
    const isOriginRequest = (): boolean => isActiveRequest() && this.state.story === originStory;
    const hasNewEdits = (): boolean => {
      const settingsChanged = settingsDirty
        ? JSON.stringify(this.state.settingsEditor?.draft ?? null) !== originSettings
        : this.hasDirtySettings();
      const imagesChanged = this.state.draftImages.length !== originImageLeases.length
        || this.state.draftImages.some((image, index) => image.leaseId !== originImageLeases[index]);
      const factEditorChanged = JSON.stringify(this.state.factEditor) !== originFactEditor;
      return JSON.stringify(this.state.drafts) !== originDrafts || imagesChanged || settingsChanged || factEditorChanged;
    };
    let loaded = false;
    await this.run("Loading story", async () => {
      const story = await api.loadStory(id);
      if (!isOriginRequest()) return;
      if (hasNewEdits()) {
        this.setState({
          status: "Story load paused; newer edits kept",
          error: "The story did not change. Save or discard the newer edits, then retry."
        });
        return;
      }
      if (!this.canNavigateAway()) return;
      this.setState({ story, error: null, status: "Story loaded", drafts: {}, lineClipboard: null, draftImages: [], searchHits: [], searchBusy: false, aside: emptyAsideState(), factConsistency: null, factConsistencyBusy: false, factConsistencySeen: false, factConsistencyDismissed: [], factEditor: null, focusedPartId: null, editingPartId: null, chapterUndo: null, mapCursorId: null, composerWriteTarget: null, ...(settingsDirty ? { settingsEditor: this.resetSettingsEditor() } : {}) });
      if (originStory !== null && originImages.length > 0) {
        await this.releaseDraftImages(originStory.id, originImages, api);
      }
      if (!isActiveRequest() || this.state.story !== story) return;
      await this.loadAside(story);
      if (!isActiveRequest() || this.state.story !== story) return;
      loaded = true;
    });
    return loaded;
  }

  private async createStory(): Promise<void> {
    const api = this.requireApi();
    if (!await this.confirmDiscardDrafts()) return;
    const title = (await this.textDialog("Story title", "Untitled"))?.trim();
    if (title === undefined) return;
    await this.discardDrafts();
    const requestSequence = ++this.createStorySequence;
    const originLoadStorySequence = this.loadStorySequence;
    const originStory = this.state.story;
    const originDrafts = JSON.stringify(this.state.drafts);
    const originImageLeases = this.state.draftImages.map((image) => image.leaseId);
    const originSettings = JSON.stringify(this.state.settingsEditor?.draft ?? null);
    const isOriginRequest = (): boolean => requestSequence === this.createStorySequence
      && this.loadStorySequence === originLoadStorySequence
      && this.api === api
      && this.state.story === originStory;
    const hasNewEdits = (): boolean => {
      const imagesChanged = this.state.draftImages.length !== originImageLeases.length
        || this.state.draftImages.some((image, index) => image.leaseId !== originImageLeases[index]);
      return JSON.stringify(this.state.drafts) !== originDrafts
        || imagesChanged
        || (this.hasDirtySettings() && JSON.stringify(this.state.settingsEditor?.draft ?? null) !== originSettings);
    };
    const preserveCurrentStory = async (): Promise<void> => {
      if (this.api !== api || this.state.story === null) return;
      const currentStory = this.state.story;
      const stories = await api.listStories();
      if (requestSequence !== this.createStorySequence || this.api !== api || this.state.story !== currentStory) return;
      this.setState({ stories, status: "Story created; current story kept", error: null });
    };
    await this.run("Creating story", async () => {
      const story = await api.createStory(title.length === 0 ? undefined : title);
      if (!isOriginRequest() || hasNewEdits()) {
        await preserveCurrentStory();
        return;
      }
      const isCurrentStory = (): boolean => requestSequence === this.createStorySequence
        && this.loadStorySequence === originLoadStorySequence
        && this.api === api
        && this.state.story?.id === story.id;
      await this.replaceStory(story);
      if (!isCurrentStory()) return;
      this.setState({ aside: emptyAsideState(), tab: "write", focusedPartId: null });
      await this.loadAside(story);
      if (!isCurrentStory()) return;
      await this.refresh();
      if (!isCurrentStory()) return;
      this.setState({ status: "New manuscript" });
    });
  }

  private async renameStory(): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    const title = (await this.textDialog("Rename story", story.title))?.trim();
    if (title === undefined || title === story.title || title.length === 0) return;
    await this.run("Renaming story", async () => {
      const next = await api.renameStory(story.id, title);
      if (this.api !== api || this.state.story?.id !== story.id) return;
      await this.replaceStory(next);
    });
  }

  private async autonameStory(): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    await this.run("Naming story", async () => {
      const next = await api.autonameStory(story.id);
      if (this.api !== api || this.state.story?.id !== story.id) return;
      await this.replaceStory(next);
    });
  }

  private async deleteStory(): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    if (!await this.confirmDialog("Delete story", `Delete “${story.title}”? This cannot be undone.`)) return;
    if (!await this.confirmDiscardDrafts()) return;
    await this.discardDrafts();
    await this.run("Deleting story", async () => {
      await api.deleteStory(story.id);
      this.setState({ story: null, drafts: {}, draftImages: [], stream: null, stoppedGeneration: null, aside: emptyAsideState(), lineClipboard: null });
      await this.refresh();
    });
  }

  private async sealProject(): Promise<void> {
    if (!await this.confirmDiscardDrafts()) return;
    const fields: readonly RendererDialogField[] = [
      { id: "password", label: "Password", kind: "text", value: "" },
      { id: "repeatPassword", label: "Repeat password", kind: "text", value: "" }
    ];
    let password: string | null = null;
    while (password === null) {
      const values = await this.formDialog(
        "Choose a password to seal this project",
        fields,
        "Enter a password and repeat it to confirm. Sealing encrypts and locks the project. Unlock it with this password to continue writing.",
        true
      );
      if (values === null) return;
      const candidate = values.password ?? "";
      if (candidate.length === 0 || (values.repeatPassword ?? "").length === 0) {
        await this.openDialog({
          title: "Password required",
          message: "Enter a non-empty password in both fields.",
          value: "",
          kind: "notice"
        });
        continue;
      }
      if (candidate !== values.repeatPassword) {
        await this.openDialog({
          title: "Passwords do not match",
          message: "Enter the same password in both fields.",
          value: "",
          kind: "notice"
        });
        continue;
      }
      password = candidate;
    }
    await this.shellRequest({ type: "vault.seal", password }, true);
  }

  private async unsealProject(): Promise<void> {
    const password = await this.textDialog("Unseal project", "", "Enter the vault password to remove encryption permanently.", false, true);
    if (password === null) return;
    await this.shellRequest({ type: "vault.unseal", password });
  }

  private async revealProject(): Promise<void> {
    const project = this.state.project;
    if (project === null) return;
    await this.shellRequest({ type: "project.reveal", path: project.root });
  }

  private async continueStory(
    mode: StreamMode,
    instruction: string,
    target?: { readonly parentId: string | null }
  ): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    // Advancing focus to the landed take (below) must not clobber a focus
    // move the writer made *during* the stream (review-fixes-3 #6) — compare
    // against this snapshot from before the request started, not whatever
    // `state.focusedPartId` is by the time the response lands.
    const focusedPartIdAtStart = this.state.focusedPartId;
    if (this.state.stream !== null || this.generationStartInFlight) return;
    if (this.state.stoppedGeneration !== null) {
      const summary = this.state.stoppedGeneration.mode === "summary";
      this.setState({
        status: summary ? "Discard interrupted summary first" : "Review interrupted text first",
        error: summary
          ? "Discard the interrupted summary before starting another generation."
          : "Save or discard the interrupted generation before starting another one."
      });
      return;
    }
    const leaf = story.path.at(-1);
    if (leaf !== undefined && this.state.drafts[`part:${leaf.id}`] !== undefined
      && this.state.drafts[`part:${leaf.id}`] !== leaf.text) {
      this.setState({ status: "Save the active part first", error: "The active part has unsaved text. Save it before generating so the provider appends to the text you can see." });
      return;
    }
    const submittedInstruction = instruction.trim();
    const initialComposerDraft = mode === "retake" ? undefined : this.state.drafts.composer;
    const draftImages = mode === "retake" ? [] : this.state.draftImages;
    // `continue`/`direct` pass an explicit seam target when the focused part
    // is not the leaf (review-fixes-2 #1); retake's own target is unrelated
    // to the seam and never appends regardless (`mode !== "continue"`).
    const fromSeam = target !== undefined && mode !== "retake";
    const append = shouldAppendRendererContinuation(
      story, mode, submittedInstruction, draftImages.length > 0, fromSeam
    );
    this.generationStartInFlight = true;
    let appendBaseHash: string | undefined;
    try {
      appendBaseHash = append && leaf !== undefined ? await textHash(leaf.text) : undefined;
    } catch (error) {
      this.generationStartInFlight = false;
      this.setState({ status: "Generation unavailable", error: messageOf(error) });
      return;
    }
    const generationId = makeMutationId("generation");
    const targetNodeId = append ? leaf?.id : undefined;
    const parentId = target !== undefined ? target.parentId
      : append ? leaf?.parentId ?? null : leaf?.id ?? null;
    const controller = new AbortController();
    const stream = {
      id: makeMutationId("stream"),
      mode,
      instruction: submittedInstruction,
      text: "",
      reasoning: "",
      stoppedText: "",
      controller,
      ...(targetNodeId === undefined ? {} : { targetNodeId }),
      ...(append ? { parentId: leaf?.parentId ?? null } : { parentId }),
      ...(appendBaseHash === undefined ? {} : { appendBaseHash }),
      generationId
    } as const;
    const streamId = stream.id;
    this.setState({ stream, status: mode === "continue" ? "Continuing…" : "Writing a direct take", error: null });
    this.generationStartInFlight = false;
    try {
      const requestTarget = append && leaf !== undefined
        ? { appendTo: leaf.id, expectedTextHash: appendBaseHash! }
        : { parentId };
      const result = await api.continueStory(
        story.id,
        instruction,
        generationId,
        requestTarget,
        (text) => this.updateStream((current) => ({ text: current.text + text }), streamId),
        controller.signal,
        {
          onStopped: (text) => this.updateStream((current) => ({ stoppedText: current.stoppedText + text }), streamId),
          onReasoning: (delta) => this.updateStream((current) => ({ reasoning: current.reasoning + delta.text }), streamId),
          onReasoningStopped: (text) => this.updateStream((current) => ({ reasoning: current.reasoning + text }), streamId)
        },
        draftImages.length === 0 ? undefined : draftImages.map<DraftImageReference>((image) => ({
          leaseId: image.leaseId,
          objectId: image.attachment.objectId
        }))
      );
      const current = this.currentStream();
      if (current === null || current.id !== streamId) return;
      if (result === null) {
        await this.settleStoppedGeneration(story.id, current);
        return;
      }
      await this.replaceStory(result.payload);
      if (draftImages.length > 0) await this.releaseDraftImages(story.id, draftImages);
      const composerDraft = this.state.drafts.composer ?? "";
      if (mode !== "retake"
        && initialComposerDraft !== undefined
        && composerDraft === initialComposerDraft
        && initialComposerDraft.trim() === submittedInstruction) this.setDraft("composer", undefined);
      const submittedImageLeases = new Set(draftImages.map((image) => image.leaseId));
      const remainingImages = this.state.draftImages.filter((image) => !submittedImageLeases.has(image.leaseId));
      // Continue/direct advance focus to the take that just landed — the
      // TUI's own settlement rule — so the next Space or `w` targets it
      // instead of re-using this same seam (review-fixes-3 #6). Retake
      // already keeps focus on the part it retook. Skipped when the writer
      // moved focus while this streamed.
      const newLeafId = result.payload.path.at(-1)?.id ?? null;
      const focusSettlement = mode !== "retake" && newLeafId !== null && this.state.focusedPartId === focusedPartIdAtStart
        ? { focusedPartId: newLeafId }
        : {};
      this.setState({ stream: null, stoppedGeneration: null, draftImages: remainingImages, status: result.droppedFacts.length === 0 ? "Saved" : `${result.droppedFacts.length} Fact${result.droppedFacts.length === 1 ? "" : "s"} dropped to fit context`, ...focusSettlement });
    } catch (error) {
      const current = this.currentStream();
      if (current === null || current.id !== streamId) return;
      if (controller.signal.aborted) {
        await this.settleStoppedGeneration(story.id, current);
      } else {
        const partial = current.text + current.stoppedText;
        this.setState({ stream: null, stoppedGeneration: partial.trim().length === 0 ? null : {
          mode: current.mode,
          instruction: current.instruction,
          text: partial,
          ...(current.targetNodeId === undefined ? {} : { targetNodeId: current.targetNodeId }),
          ...(current.parentId === undefined ? {} : { parentId: current.parentId }),
          ...(current.appendBaseHash === undefined ? {} : { appendBaseHash: current.appendBaseHash }),
          ...(current.generationId === undefined ? {} : { generationId: current.generationId })
        }, status: partial.trim().length === 0 ? "Generation failed" : "Generation failed; save the streamed text when ready", error: messageOf(error) });
      }
    }
  }

  private async retakeLine(node: StoryPathNode, options?: { readonly editDirection?: boolean }): Promise<void> {
    if (this.hasDirtyPart(node)) {
      this.setState({ status: "Save the part first", error: "Save the active text before creating a take." });
      return;
    }
    // Existing branch drafts stay editable through Map after a retake.
    await retakeLine(this.commandContext(), node, options);
  }

  private async rewriteLine(node: StoryPathNode, selection?: TextSelection): Promise<void> {
    if (this.hasDirtyPart(node)) {
      this.setState({ status: "Save the part first", error: "Save the active text before rewriting it." });
      return;
    }
    await rewriteLine(this.commandContext(), node, selection);
  }

  private hasDirtyPart(node: StoryPathNode): boolean {
    const draft = this.state.drafts[`part:${node.id}`];
    return draft !== undefined && draft !== node.text;
  }

  private async confirmDiscardDrafts(): Promise<boolean> {
    if (!this.canNavigateAway()) return false;
    const story = this.state.story;
    const storyDirty = story !== null && storyHasUnsavedDrafts(story, this.state);
    const settingsDirty = this.hasDirtySettings();
    const factDirty = this.hasDirtyFactEditor();
    if (!storyDirty && !settingsDirty && !factDirty) return true;
    return await this.confirmDialog(
      "Discard unsaved edits?",
      "This action will discard unsaved part text, notes, brief, direction, staged images, a Fact draft, or settings."
    );
  }

  private async prepareProfileImport(): Promise<boolean> {
    if (!this.settingsController.hasDraftChanges()) return true;
    if (!await this.confirmDialog(
      "Discard Settings edits?",
      "Importing a profile will reload Settings and discard its unsaved edits. Story, composer, and note drafts stay unchanged."
    )) return false;
    return true;
  }

  private hasDirtySettings(): boolean {
    const settings = this.state.settings;
    const editor = this.state.settingsEditor;
    return settings !== null && settings.document !== null && editor !== null
      && settingsDraftDirty(settings.document, editor.draft);
  }

  private canNavigateAway(): boolean {
    if (this.state.stream !== null || this.generationStartInFlight) {
      this.setState({ status: "Stop generation first", error: "Stop the active generation before leaving this story or project." });
      return false;
    }
    if (this.state.aside.busy || this.asideController !== null) {
      this.setState({ status: "Stop Aside first", error: "Stop the active Aside response before leaving this story or project." });
      return false;
    }
    if (this.state.stoppedGeneration !== null) {
      const summary = this.state.stoppedGeneration.mode === "summary";
      this.setState({
        status: summary ? "Discard interrupted summary first" : "Review interrupted text first",
        error: summary
          ? "Discard the interrupted summary before leaving this story or project."
          : "Save or discard the interrupted text before leaving this story or project."
      });
      return false;
    }
    return true;
  }

  private hasUnsavedWork(): boolean {
    const story = this.state.story;
    if (this.state.stream !== null
      || this.generationStartInFlight
      || this.state.stoppedGeneration !== null
      || this.state.aside.busy
      || this.asideController !== null) return true;
    if (story !== null && storyHasUnsavedDrafts(story, this.state)) return true;
    if (this.hasDirtyFactEditor()) return true;
    return this.hasDirtySettings();
  }

  private async discardDrafts(): Promise<void> {
    const story = this.state.story;
    const settingsDirty = this.hasDirtySettings();
    if (story !== null && this.state.draftImages.length > 0) {
      await this.releaseDraftImages(story.id, this.state.draftImages);
    }
    this.setState({ drafts: {}, draftImages: [], factEditor: null, ...(settingsDirty ? { settingsEditor: this.resetSettingsEditor() } : {}) });
  }

  private resetSettingsEditor(): RendererState["settingsEditor"] {
    const settings = this.state.settings;
    if (settings === null || settings.document === null) return null;
    return createSettingsEditorState(settings, this.state.settingsEditor?.draft.selectedProfileId);
  }

  private async settleStoppedGeneration(storyId: string, source: NonNullable<RendererState["stream"]> | NonNullable<RendererState["stoppedGeneration"]>): Promise<void> {
    const text = source.text + ("stoppedText" in source ? source.stoppedText : "");
    if (text.trim().length === 0) {
      this.setState({ stream: null, stoppedGeneration: null, status: "Stopped; no text was produced", error: null });
      return;
    }
    this.setState({ status: "Saving interrupted text", error: null });
    let rewriteUnavailable = "saveable" in source && source.saveable === false;
    try {
      const api = this.requireApi();
      let payload: StoryPayload;
      if (source.attemptId !== undefined && source.targetNodeId !== undefined) {
        const digest = await rewriteStreamDigest(text);
        const committed = await api.commitPartialRewrite(storyId, source.targetNodeId, digest, source.attemptId);
        if (committed === null) {
          rewriteUnavailable = true;
          throw new Error("The stopped rewrite is no longer available. Keep the text below and review it before saving.");
        }
        payload = committed.payload;
      } else {
        const base = { text, instruction: source.instruction };
        const request = source.targetNodeId !== undefined && source.appendBaseHash !== undefined && source.generationId !== undefined
          ? { ...base, appendTo: source.targetNodeId, expectedTextHash: source.appendBaseHash, genId: source.generationId }
          : { ...base, parentId: source.parentId ?? null, ...(source.generationId === undefined ? {} : { genId: source.generationId }) };
        payload = await api.createNode(storyId, request);
      }
      await this.replaceStory(payload);
      const draftImages = source.mode === "retake" ? [] : this.state.draftImages;
      if (draftImages.length > 0) await this.releaseDraftImages(storyId, draftImages);
      this.setState({ stream: null, stoppedGeneration: null, draftImages: source.mode === "retake" ? this.state.draftImages : [], status: "Interrupted text saved", error: null });
    } catch (error) {
      const refreshed = apiErrorCode(error) === "revision_conflict"
        && await this.reloadStoryPreservingDrafts(storyId);
      const latest = refreshed && this.state.story?.id === storyId ? this.state.story : null;
      const retry = latest === null ? source : await this.adoptStoppedGeneration(source, latest);
      const unavailable = rewriteUnavailable || ("saveable" in retry && retry.saveable === false);
      this.setState({ stream: null, stoppedGeneration: {
        mode: retry.mode,
        instruction: retry.instruction,
        text,
        ...(unavailable ? { saveable: false } : {}),
        ...(retry.targetNodeId === undefined ? {} : { targetNodeId: retry.targetNodeId }),
        ...(retry.parentId === undefined ? {} : { parentId: retry.parentId }),
        ...(retry.appendBaseHash === undefined ? {} : { appendBaseHash: retry.appendBaseHash }),
        ...(retry.generationId === undefined ? {} : { generationId: retry.generationId }),
        ...(unavailable || retry.attemptId === undefined ? {} : { attemptId: retry.attemptId })
      }, status: unavailable ? "Stopped rewrite kept for review" : refreshed ? "Story refreshed; retry interrupted text save" : "Interrupted text kept for review", error: unavailable
        ? "The Host no longer has this rewrite. Copy the retained text before you discard it."
        : refreshed
          ? "The story changed. The latest story is loaded and the interrupted text is retained. Retry Save."
          : messageOf(error) });
    }
  }

  private async adoptStoppedGeneration(
    source: NonNullable<RendererState["stream"]> | NonNullable<RendererState["stoppedGeneration"]>,
    story: StoryPayload
  ): Promise<NonNullable<RendererState["stoppedGeneration"]>> {
    if (source.targetNodeId !== undefined) {
      const target = story.path.find((node) => node.id === source.targetNodeId);
      if (target !== undefined && source.attemptId === undefined) {
        return { ...source, appendBaseHash: await textHash(target.text ?? "") };
      }
      return source;
    }
    return source;
  }

  private async saveStoppedGeneration(): Promise<void> {
    const stopped = this.state.stoppedGeneration;
    const story = this.state.story;
    if (stopped === null || story === null || this.state.stream !== null) return;
    if (stopped.saveable === false) {
      this.setState({ status: "Copy interrupted text first", error: "This stopped rewrite is no longer available. Copy the retained text, then discard it." });
      return;
    }
    if (stopped.mode === "summary") {
      this.setState({ status: "Discard interrupted summary", error: "Interrupted summaries cannot be saved as prose. Discard the stopped summary and try again." });
      return;
    }
    await this.settleStoppedGeneration(story.id, stopped);
  }

  private async copyStoppedGeneration(): Promise<void> {
    const stopped = this.state.stoppedGeneration;
    if (stopped === null) return;
    try {
      if (navigator.clipboard?.writeText !== undefined) await navigator.clipboard.writeText(stopped.text);
      else {
        const control = document.createElement("textarea");
        control.value = stopped.text;
        control.style.position = "fixed";
        control.style.opacity = "0";
        renderRoot.append(control);
        control.focus();
        control.select();
        const copied = document.execCommand("copy");
        control.remove();
        if (!copied) throw new Error("The text could not be copied.");
      }
      this.setState({ status: "Interrupted text copied", error: null });
    } catch (error) {
      this.setState({ status: "Copy failed", error: messageOf(error) });
    }
  }

  private discardStoppedGeneration(): void {
    if (this.state.stoppedGeneration === null) return;
    const summary = this.state.stoppedGeneration.mode === "summary";
    this.setState({ stoppedGeneration: null, status: summary ? "Interrupted summary discarded" : "Interrupted text discarded", error: null });
  }

  private async summarizeLine(): Promise<void> {
    await summarizeLine(this.commandContext());
  }

  private stopStream(): void {
    const stream = this.state.stream;
    if (stream === null || stream.controller.signal.aborted) return;
    stream.controller.abort();
    this.setState({ status: "Stopping…" });
  }

  private async writeManual(text: string, clearComposer = true, parentId?: string | null): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    const value = text;
    if (value.trim().length === 0) return;
    await this.run("Saving line", async () => {
      const next = await api.createNode(story.id, {
        parentId: parentId !== undefined ? parentId : story.path.at(-1)?.id ?? null,
        text: value
      });
      if (this.api !== api || this.state.story?.id !== story.id) return;
      await this.replaceStory(next);
      if (clearComposer && this.state.drafts.composer === value) this.setDraft("composer", undefined);
      if (this.state.composerWriteTarget !== null) this.setState({ composerWriteTarget: null });
    });
  }

  private async attachImage(file: File): Promise<void> {
    const story = this.requireStory();
    if (!isSourceImageMediaType(file.type)) {
      this.setState({ status: "Image type not supported", error: "Use a PNG, JPEG, or WebP image." });
      return;
    }
    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      this.setState({ status: "Image is too large", error: `Images must be smaller than ${Math.round(MAX_SOURCE_IMAGE_BYTES / 1_000_000)} MB.` });
      return;
    }
    const mediaType: SourceImageMediaType = file.type;
    await this.run("Staging image", async () => {
      const result = await this.requireApi().stageStoryImage(story.id, mediaType, new Uint8Array(await file.arrayBuffer()));
      this.setState({
        draftImages: [...this.state.draftImages, { leaseId: result.leaseId, attachment: result.attachment }],
        status: `${imageMediaTypeLabel(result.attachment.mediaType)} image attached`,
        error: null
      });
    });
  }

  private removeImage(index: number): void {
    const image = this.state.draftImages[index];
    const story = this.state.story;
    if (image === undefined || story === null) return;
    this.setState({ draftImages: this.state.draftImages.filter((_, candidate) => candidate !== index), status: "Image removed", error: null });
    void this.requireApi().releaseStoryImage(story.id, image.leaseId).catch(() => undefined);
  }

  private async releaseDraftImages(storyId: string, images: readonly { readonly leaseId: string }[], api: StoryApi = this.requireApi()): Promise<void> {
    await Promise.all(images.map(async (image) => {
      try {
        await api.releaseStoryImage(storyId, image.leaseId);
      } catch {
        // Lease cleanup is idempotent. Do not mask the story action.
      }
    }));
  }

  private async editNode(node: StoryPathNode, text: string): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    if (text === node.text) {
      this.setDraft(`part:${node.id}`, undefined);
      return;
    }
    await this.run("Saving edit", async () => {
      const next = await api.editNode(story.id, node, { text });
      if (this.api !== api || this.state.story?.id !== story.id) return;
      await this.replaceStory(next);
      if (this.state.drafts[`part:${node.id}`] === text) this.setDraft(`part:${node.id}`, undefined);
      const editingPartId = this.state.editingPartId === node.id ? null : this.state.editingPartId;
      this.setState({ status: "Saved", editingPartId });
    });
  }

  private async saveEditedTake(node: StoryPathNode, text: string): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    if (text === node.text) return;
    await this.run("Saving as take", async () => {
      const next = await api.createNode(story.id, {
        sourceNodeId: node.id,
        expectedTextHash: await textHash(node.text),
        instruction: node.instruction,
        text
      });
      if (this.api !== api || this.state.story?.id !== story.id) return;
      await this.replaceStory(next);
      if (this.state.drafts[`part:${node.id}`] === text) this.setDraft(`part:${node.id}`, undefined);
      const editingPartId = this.state.editingPartId === node.id ? null : this.state.editingPartId;
      this.setState({ status: "Saved as take", editingPartId });
    });
  }

  private async editNodeDirection(node: StoryPathNode): Promise<void> {
    const instruction = await this.textDialog("Edit direction", node.instruction, "Change the direction saved with this part.");
    if (instruction === null || instruction === node.instruction) return;
    const api = this.requireApi();
    const story = this.requireStory();
    await this.run("Saving direction", async () => {
      const next = await api.editNode(story.id, node, { instruction });
      if (this.api !== api || this.state.story?.id !== story.id) return;
      await this.replaceStory(next);
      this.setState({ status: "Direction saved" });
    });
  }

  private async deleteNode(node: StoryPathNode): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    const count = subtreeCount(story, node.id);
    if (count < 1) return;
    const detail = count === 1 ? "Delete this part?" : `Delete this part and its ${count - 1} descendant parts?`;
    if (!await this.confirmDialog("Delete part", detail)) return;
    await this.run("Deleting part", async () => {
      const next = await api.deleteNode(story.id, node.id, count);
      if (this.api !== api || this.state.story?.id !== story.id) return;
      const remainingIds = new Set(next.nodes.map((part) => part.id));
      const drafts = Object.fromEntries(Object.entries(this.state.drafts).filter(([key]) =>
        !key.startsWith("part:") || remainingIds.has(key.slice("part:".length))
      ));
      const editingPartId = this.state.editingPartId !== null && remainingIds.has(this.state.editingPartId)
        ? this.state.editingPartId : null;
      this.setState({ drafts, editingPartId, status: "Part deleted" });
      await this.replaceStory(next);
    });
  }

  private async switchLine(node: StoryPathNode): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    if (!this.canNavigateAway()) return;
    const drafts = await this.confirmLineDrafts(story, node.id);
    if (drafts === null) return;
    await this.run("Focusing line", async () => {
      const next = await api.switchLine(story.id, node.id, { stopAtNode: true });
      for (const key of drafts) this.setDraft(key, undefined);
      await this.replaceStory(next);
      // "Write from here" (review-fixes-3 #7) must move focus to the part it
      // just switched to, matching `switchToNode`'s own take-switch — without
      // it the next continuation still branches from wherever focus was.
      this.setState({ focusedPartId: node.id });
    });
  }

  private async switchNode(nodeId: string): Promise<void> {
    await this.switchToNode(nodeId, takeSwitchStatus);
  }

  /** Switching a tagged line from the Library (§7) names the tag, not the
   * take position, in the toast. */
  private async switchToTaggedLine(tagName: string, nodeId: string): Promise<void> {
    await this.switchToNode(nodeId, (story, id) => {
      const index = story.path.findIndex((node) => node.id === id);
      return index === -1 ? `Switched to ${tagName}` : `Switched to ${tagName} · ¶ ${index + 1}`;
    });
  }

  private async switchToNode(nodeId: string, status: (story: StoryPayload, nodeId: string) => string): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    if (!story.nodes.some((node) => node.id === nodeId)) return;
    if (!this.canNavigateAway()) return;
    const drafts = await this.confirmLineDrafts(story, rememberedLeafId(story, nodeId));
    if (drafts === null) return;
    await this.run("Focusing line", async () => {
      const next = await api.switchLine(story.id, nodeId);
      for (const key of drafts) this.setDraft(key, undefined);
      await this.replaceStory(next);
      // The switch target may not be the new path's leaf (it can carry its
      // own remembered continuation) — focus the node the writer actually
      // asked for, not wherever `effectiveFocusedPartId`'s leaf fallback
      // would otherwise land now that the old focus is off the path.
      const onNewPath = next.path.some((node) => node.id === nodeId);
      this.setState({ status: status(next, nodeId), ...(onNewPath ? { focusedPartId: nodeId } : {}) });
    });
  }

  private async confirmLineDrafts(story: StoryPayload, leafId: string): Promise<readonly string[] | null> {
    const visibleIds = new Set(pathTo(story, leafId).map((node) => node.id));
    const hiddenDrafts = Object.entries(this.state.drafts).filter(([key, value]) => {
      if (!key.startsWith("part:") || value === undefined) return false;
      const id = key.slice("part:".length);
      const original = story.path.find((node) => node.id === id);
      return !visibleIds.has(id) && value !== original?.text;
    }).map(([key]) => key);
    if (hiddenDrafts.length === 0) return hiddenDrafts;
    return await this.confirmDialog("Discard part edits?", "The selected line does not show these edited parts. Discard their unsaved text to change lines?")
      ? hiddenDrafts : null;
  }

  private copyLine(node: StoryPathNode): void {
    copyLine(this.commandContext(), node);
  }

  private async pasteLine(target: StoryPathNode): Promise<void> {
    await pasteLine(this.commandContext(), target);
  }

  private async takeFromCut(node: StoryPathNode, selection?: TextSelection): Promise<void> {
    await takeFromCut(this.commandContext(), node, selection);
  }

  private async pruneUnused(): Promise<void> {
    await pruneUnused(this.commandContext());
  }

  private async tagLine(node: StoryPathNode): Promise<void> {
    await tagLine(this.commandContext(), node);
  }

  private async removeTag(node: StoryPathNode): Promise<void> {
    await removeTag(this.commandContext(), node);
  }

  private async manageTags(): Promise<void> {
    await manageTags(this.commandContext());
  }

  private async exportMarkdown(): Promise<void> {
    await exportMarkdown(this.commandContext());
  }

  private importMarkdown(): void {
    importMarkdown(this.commandContext());
  }

  private async setAuthorsNote(note: string, depth: number | undefined): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    await this.run("Saving Author’s Note", async () => {
      const next = await api.setAuthorsNote(story.id, note, depth);
      if (this.api !== api || this.state.story?.id !== story.id) return;
      await this.replaceStory(next);
      if (this.state.drafts["authors-note"] === note) this.setDraft("authors-note", undefined);
      if (depth !== undefined && this.state.drafts["authors-note-depth"] === String(depth)) this.setDraft("authors-note-depth", undefined);
    });
  }

  private async setAuthorBrief(brief: string): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    await this.run("Saving Author Brief", async () => {
      const next = await api.setAuthorBrief(story.id, brief);
      if (this.api !== api || this.state.story?.id !== story.id) return;
      await this.replaceStory(next);
      if (this.state.drafts["author-brief"] === brief) this.setDraft("author-brief", undefined);
    });
  }

  private async useAsideAnswer(): Promise<void> {
    const answer = this.state.aside.answer;
    if (answer.trim().length === 0) return;
    await this.writeManual(answer, false);
  }

  private async editPhraseBias(): Promise<void> {
    await editPhraseBias(this.commandContext());
  }

  private async editBannedStrings(): Promise<void> {
    await editBannedStrings(this.commandContext());
  }

  private async setFactsBudget(budget: number | null): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0)) {
      this.setState({ status: "Invalid Facts budget", error: "Facts budget must be a positive whole number." });
      return;
    }
    await this.run("Saving Facts budget", async () => { await this.replaceStory(await api.setFactsBudget(story.id, budget)); });
  }

  private async runFactConsistency(scope: "chapter" | "story-line"): Promise<void> {
    await runFactConsistency(this.commandContext(), scope);
  }

  private async showFactConsistency(): Promise<void> {
    await showFactConsistency(this.commandContext());
  }

  private async createFact(node?: StoryPathNode, selection?: TextSelection): Promise<void> {
    if (node === undefined && selection === undefined) {
      await startNewFactDraft(this.commandContext());
      return;
    }
    await createFact(this.commandContext(), node, selection);
  }

  private async editFact(factId: string): Promise<void> {
    const fact = this.requireStory().facts.find((candidate) => candidate.id === factId);
    if (fact !== undefined) await editFact(this.commandContext(), fact);
  }

  private async deleteFact(factId: string): Promise<void> {
    await deleteFact(this.commandContext(), factId);
  }

  private async moveFact(factId: string, direction: -1 | 1): Promise<void> {
    await moveFact(this.commandContext(), factId, direction);
  }

  private async editFactState(
    fact: Parameters<RendererActions["editFactState"]>[0],
    state: Parameters<RendererActions["editFactState"]>[1]
  ): Promise<void> {
    await editFactState(this.commandContext(), fact, state);
  }

  private async deleteFactState(
    fact: Parameters<RendererActions["deleteFactState"]>[0],
    state: Parameters<RendererActions["deleteFactState"]>[1]
  ): Promise<void> {
    await deleteFactState(this.commandContext(), fact, state);
  }

  private async addFactStateAt(fact: StoryFact, mode: "anchored" | "story-wide" | "end"): Promise<void> {
    await addFactStateAt(this.commandContext(), fact, mode);
  }

  private hasDirtyFactEditor(): boolean {
    const editor = this.state.factEditor;
    const story = this.state.story;
    if (editor === null || story === null) return false;
    const fact = editor.factId === null ? null : story.facts.find((candidate) => candidate.id === editor.factId) ?? null;
    return factEditorDirty(fact, editor.draft);
  }

  private saveFactEditorDraft(): void {
    void saveFactEditor(this.commandContext());
  }

  private async createChapter(partId?: string): Promise<void> {
    await createChapter(this.commandContext(), partId);
  }

  private async renameChapter(id: string, current: string): Promise<void> {
    await renameChapter(this.commandContext(), id, current);
  }

  private async removeChapter(id: string, title: string): Promise<void> {
    await removeChapter(this.commandContext(), id, title);
  }

  private async summarizeChapter(id: string, title: string): Promise<void> {
    await summarizeChapter(this.commandContext(), id, title);
  }

  private async restoreChapter(): Promise<void> {
    await restoreChapter(this.commandContext());
  }

  private async editChapterSummary(chapter: { id: string; title: string }, node: Pick<StoryPathNode, "id" | "text">): Promise<void> {
    await editChapterSummary(this.commandContext(), chapter, node);
  }

  private async loadAside(story: StoryPayload): Promise<void> {
    await loadAside(this.commandContext(), story);
  }

  private async askAside(question: string): Promise<void> {
    await askAside(this.commandContext(), question);
  }

  private stopAside(): void {
    stopAside(this.commandContext());
  }

  private selectAsideSession(sessionId: string): void {
    selectAsideSession(this.commandContext(), sessionId);
  }

  private async selectAsideAnchor(key: string): Promise<void> {
    await selectAsideAnchor(this.commandContext(), key);
  }

  private async clearAside(): Promise<void> {
    await clearAside(this.commandContext());
  }

  private async clearAsideSession(): Promise<void> {
    await clearAsideSession(this.commandContext());
  }

  private async resetAside(turnIndex: number): Promise<void> {
    await resetAside(this.commandContext(), turnIndex);
  }

  private async deleteAsideTurn(turnIndex: number): Promise<void> {
    await deleteAsideTurn(this.commandContext(), turnIndex);
  }

  private async retakeAside(turnIndex: number): Promise<void> {
    await retakeAside(this.commandContext(), turnIndex);
  }

  private async loadSettings(): Promise<void> {
    await this.settingsController.load();
  }

  private async inspect(kind: "reasoning" | "probabilities" | "records", node: StoryPathNode): Promise<void> {
    const api = this.requireApi();
    const story = this.requireStory();
    const titles = { reasoning: "Thought", probabilities: "Token alternatives", records: "Generation records" };
    this.setState({ inspector: { title: titles[kind], body: "", busy: true } });
    try {
      const value = kind === "reasoning"
        ? await api.getReasoning(story.id, node.id)
        : kind === "probabilities"
          ? await api.getTokenProbabilities(story.id, node.id)
          : await api.getGenerationRecords(story.id, node.id);
      this.setState({ inspector: { title: titles[kind], body: JSON.stringify(value, null, 2), busy: false } });
    } catch (error) {
      this.setState({ inspector: { title: titles[kind], body: messageOf(error), busy: false } });
    }
  }

  private async replaceStory(story: StoryPayload): Promise<void> {
    const previousStory = this.state.story;
    const previousLeaf = previousStory?.path.at(-1);
    const nextLeaf = story.path.at(-1);
    const leafChanged = previousStory?.id === story.id
      && previousLeaf?.id !== nextLeaf?.id;
    const shouldFollowCurrentAside = leafChanged
      && (this.state.aside.bucket === "current" || this.state.aside.selectedSessionId === null);
    // A genuinely different story: a part mid-edit in the old one must not
    // reappear in edit mode if its id ever collides with a part here later
    // (or, more immediately, if the writer navigates back to the old story
    // without this having been cleared — `editingPartId` has no fallback
    // like `effectiveFocusedPartId`'s "the id is gone, use the leaf").
    const storyChanged = previousStory !== null && previousStory.id !== story.id;
    // A genuinely different story also invalidates the Facts draft (it names
    // no Fact in the new story), the map cursor, and any pending `w` target.
    this.setState({ story, ...(storyChanged ? { editingPartId: null, factEditor: null, mapCursorId: null, composerWriteTarget: null } : {}) });
    const stories = this.state.stories.map((summary) => summary.id === story.id ? {
      ...summary,
      title: story.title,
      updatedAt: story.updatedAt,
      partCount: story.nodes.length,
      words: story.path.reduce((count, node) => count + node.text.split(/\s+/u).filter(Boolean).length, 0)
    } : summary);
    this.setState({ stories });
    if (shouldFollowCurrentAside) await this.loadAside(story);
  }

  private async reloadStoryPreservingDrafts(storyId: string): Promise<boolean> {
    if (this.state.story?.id !== storyId) return false;
    try {
      const story = await this.requireApi().loadStory(storyId);
      if (this.state.story?.id !== storyId) return false;
      await this.replaceStory(story);
      return true;
    } catch {
      return false;
    }
  }

  private updateStream(update: (current: NonNullable<RendererState["stream"]>) => Partial<NonNullable<RendererState["stream"]>>, expectedId?: string): void {
    const current = this.state.stream;
    if (current === null || (expectedId !== undefined && current.id !== expectedId)) return;
    const next = { ...current, ...update(current) };
    this.state = { ...this.state, stream: next };
    this.updateStreamDom(next);
  }

  private updateStreamDom(stream: NonNullable<RendererState["stream"]>): void {
    const card = renderRoot.querySelector<HTMLElement>(".stream-card");
    if (card === null) return;
    const text = card.querySelector<HTMLElement>(".stream-text");
    if (text !== null) text.textContent = stream.text || "…";
    const reasoning = card.querySelector<HTMLDetailsElement>(".stream-reasoning");
    if (reasoning !== null) {
      const body = reasoning.querySelector<HTMLElement>("p");
      if (body !== null) body.textContent = stream.reasoning;
      reasoning.hidden = stream.reasoning.length === 0;
    }
    const stopped = card.querySelector<HTMLElement>(".stream-stopped");
    if (stopped !== null) {
      stopped.textContent = stream.stoppedText.length === 0
        ? ""
        : `Stopped with ${stream.stoppedText.length.toLocaleString()} characters retained.`;
      stopped.hidden = stream.stoppedText.length === 0;
    }
  }

  private currentStream(): RendererState["stream"] {
    return this.state.stream;
  }

  private setDraft(key: string, value: string | undefined): void {
    const drafts = { ...this.state.drafts };
    if (value === undefined) delete drafts[key];
    else if (key.startsWith("part:") && this.state.story?.path.find((node) => node.id === key.slice("part:".length))?.text === value) {
      delete drafts[key];
    } else drafts[key] = value;
    this.setState({ drafts });
  }

  /** D-44 log entries this update adds, oldest first. A `setState` call that
   * sets both fields (a failure's `status`/`error` pair) logs both — the log
   * is "every notice", not a single deduplicated line. */
  private logEntriesFor(update: Partial<RendererState>): LogEntry[] {
    const entries: LogEntry[] = [];
    const at = new Date().toISOString();
    if (typeof update.error === "string" && update.error.length > 0) entries.push({ at, text: update.error, kind: "error" });
    if (typeof update.status === "string" && update.status.length > 0) entries.push({ at, text: update.status, kind: "status" });
    return entries;
  }

  private setState(update: Partial<RendererState>): void {
    const previousStream = this.state.stream;
    const nextStream = update.stream;
    const streamOnly = previousStream !== null
      && nextStream !== undefined
      && nextStream !== null
      && previousStream.id === nextStream.id
      && Object.keys(update).every((key) => key === "stream");
    const nextAside = update.aside;
    const asideStreamOnly = nextAside !== undefined
      && Object.keys(update).every((key) => key === "aside")
      && this.state.aside.v2
      && nextAside.v2
      && this.state.aside.busy
      && nextAside.busy
      && nextAside.selectedSessionId === this.state.aside.selectedSessionId
      && nextAside.question === this.state.aside.question
      && nextAside.sessions === this.state.aside.sessions;
    const draftOnly = Object.keys(update).length > 0 && Object.keys(update).every((key) => key === "drafts");
    const searchOnly = Object.keys(update).length > 0 && Object.keys(update).every((key) => key === "search");
    const logAdditions = this.logEntriesFor(update);
    this.state = {
      ...this.state,
      ...update,
      ...(logAdditions.length === 0 ? {} : { log: [...this.state.log, ...logAdditions].slice(-200) })
    };
    if (this.compositionActive) {
      this.compositionRenderPending = true;
    } else if (streamOnly) this.updateStreamDom(nextStream);
    else if (asideStreamOnly) this.updateAsideStreamDom(this.state.aside);
    else if (draftOnly) this.updateDraftDom();
    else if (searchOnly) this.updateSearchDom();
    else this.render();
    this.contextController.notify(this.state, this.api);
  }

  /** Used only to clear a stale toast/error left over from before the
   * writer's next click or keydown (D-38). A dedicated path, not the general
   * `setState`, so it never skips the full re-render that every ordinary
   * status/error update still relies on to resync derived DOM (a <select>
   * a failed action leaves at a stale native value, for one). */
  private clearStaleFeedback(previousStatus: string, previousError: string | null): void {
    if (this.state.status !== previousStatus || this.state.error !== previousError) return;
    this.state = { ...this.state, status: "", error: null };
    updateFeedbackDom(renderRoot, this.state);
    this.contextController.notify(this.state, this.api);
  }

  private updateAsideStreamDom(aside: RendererState["aside"]): void {
    // The docked inspector section and the popped-out popover (when open)
    // read the same `state.aside` and each keep their own `.aside-live-answer`
    // paragraph in step with the stream.
    const sessions = renderRoot.querySelector<HTMLElement>(".aside-sessions");
    this.syncAsideLiveAnswer(sessions, aside, () => sessions?.querySelector<HTMLElement>(".aside-session-label") ?? null);
    const popoverTurns = renderRoot.querySelector<HTMLElement>(".aside-popover .aside-turns");
    this.syncAsideLiveAnswer(popoverTurns, aside, () => null);
  }

  private syncAsideLiveAnswer(
    container: HTMLElement | null,
    aside: RendererState["aside"],
    anchorFor: () => HTMLElement | null
  ): void {
    if (container === null) return;
    let live = container.querySelector<HTMLElement>(".aside-live-answer");
    if (aside.answer.length === 0) {
      live?.remove();
      return;
    }
    if (live === null) {
      live = document.createElement("p");
      live.className = "aside-answer aside-live-answer";
      const anchor = anchorFor();
      if (anchor === null) container.prepend(live);
      else anchor.after(live);
    }
    live.textContent = aside.answer;
  }

  private updateSearchDom(): void {
    const search = renderRoot.querySelector<HTMLInputElement>(".library-search");
    if (search !== null && document.activeElement !== search && search.value !== this.state.search) search.value = this.state.search;
  }

  private updateDraftDom(): void {
    const story = this.state.story;
    if (story === null || this.compositionActive) return;
    const updateEditable = (key: string, value: string, force = false): void => {
      const control = [...renderRoot.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[data-preserve], textarea[data-preserve]")]
        .find((candidate) => candidate.dataset.preserve === key);
      if (control !== undefined && (force || document.activeElement !== control) && control.value !== value) control.value = value;
    };
    updateEditable("composer", this.state.drafts.composer ?? "", this.state.drafts.composer === undefined);
    this.updateComposerTypingState();
    updateEditable("authors-note", this.state.drafts["authors-note"] ?? story.authorsNote ?? "");
    updateEditable("authors-note-depth", this.state.drafts["authors-note-depth"] ?? String(story.authorsNoteDepth ?? 1));
    updateEditable("author-brief", this.state.drafts["author-brief"] ?? story.authorBrief ?? "");
    updateEditable("aside-question", this.state.drafts["aside-question"] ?? this.state.aside.question);
    updateEditable("aside-question-popover", this.state.drafts["aside-question"] ?? this.state.aside.question);
    for (const article of renderRoot.querySelectorAll<HTMLElement>(".manuscript-part[data-preserve^=\"part-card:\"]")) {
      const id = article.dataset.preserve?.slice("part-card:".length);
      if (id === undefined) continue;
      const node = story.path.find((candidate) => candidate.id === id);
      if (node === undefined) continue;
      const draft = this.state.drafts[`part:${id}`];
      const dirty = draft !== undefined && draft !== node.text;
      article.classList.toggle("dirty", dirty);
      const dirtyMark = article.querySelector<HTMLElement>(".part-gutter-dirty");
      if (dirtyMark !== null) dirtyMark.hidden = !(node.human === true || dirty);
      const text = article.querySelector<HTMLTextAreaElement>(".part-text");
      if (text !== null && document.activeElement !== text) {
        const value = draft ?? node.text ?? "";
        if (text.value !== value) text.value = value;
        text.style.height = "auto";
        text.style.height = `${Math.max(88, text.scrollHeight)}px`;
      }
      const prose = article.querySelector<HTMLElement>(".part-prose");
      if (prose !== null) {
        const value = draft ?? node.text ?? "";
        if (prose.textContent !== value) prose.textContent = value;
      }
    }
    const saveState = renderRoot.querySelector<HTMLElement>(".story-save-state");
    if (saveState !== null) {
      const dirty = storyHasUnsavedDrafts(story, this.state);
      saveState.className = `story-save-state ${this.state.stream === null ? dirty ? "dirty" : "saved" : "streaming"}`;
      saveState.textContent = this.state.stream === null ? dirty ? "unsaved edits" : "saved" : "writing…";
    }
  }

  /** The composer's grown/typing look (D-12) is a CSS class computed from
   * the draft, but every keystroke takes the fast `draftOnly` path in
   * `setState` — no full render — so nothing else keeps that class, the
   * eyebrow text, or the submit label in step with what the writer typed.
   * Left stale, the row's height only ever changes on the next unrelated
   * full render, which can land mid-click on a footer button (the button
   * shifts under the pointer between mousedown and mouseup, and the browser
   * drops the click). Keeping these in sync on every keystroke is what
   * keeps the row's height stable through a click, not just accurate. */
  private updateComposerTypingState(): void {
    const composer = renderRoot.querySelector<HTMLElement>(".composer");
    if (composer === null) return;
    const empty = (this.state.drafts.composer ?? "").trim().length === 0;
    composer.classList.toggle("composer-typing", !empty);
    const eyebrow = composer.querySelector<HTMLElement>(".composer-eyebrow");
    if (eyebrow !== null && this.state.stream === null && this.state.stoppedGeneration === null) {
      eyebrow.textContent = eyebrowFor(this.state.composerMode);
    }
    const submit = composer.querySelector<HTMLElement>(".composer-submit");
    if (submit !== null && this.state.stream === null) submit.textContent = submitLabel(this.state.composerMode, empty);
  }

  private render(): void {
    const focused = document.activeElement;
    const focusedKey = focused instanceof HTMLElement ? focused.dataset.preserve : undefined;
    const focusedContainerKey = focused instanceof HTMLButtonElement
      ? focused.closest<HTMLElement>("[data-preserve]")?.dataset.preserve
      : undefined;
    const focusedClassName = focused instanceof HTMLButtonElement
      ? [...focused.classList].find((name) => name !== "button")
      : undefined;
    const focusedValue = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? focused.value : undefined;
    const selectionStart = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused.selectionStart : null;
    const selectionEnd = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused.selectionEnd : null;
    const scrollTop = focused instanceof HTMLTextAreaElement ? focused.scrollTop : null;
    const openDetails = new Map<string, boolean>();
    for (const details of renderRoot.querySelectorAll<HTMLDetailsElement>("details[data-preserve]")) {
      const key = details.dataset.preserve;
      if (key !== undefined) openDetails.set(key, details.open);
    }
    renderApp(renderRoot, this.state, this.actions);
    for (const details of renderRoot.querySelectorAll<HTMLDetailsElement>("details[data-preserve]")) {
      const key = details.dataset.preserve;
      if (key !== undefined && openDetails.has(key)) details.open = openDetails.get(key)!;
    }
    if (focusedKey === undefined && focusedClassName === undefined) return;
    const focusedContainer = focusedContainerKey === undefined
      ? renderRoot
      : [...renderRoot.querySelectorAll<HTMLElement>("[data-preserve]")]
        .find((candidate) => candidate.dataset.preserve === focusedContainerKey) ?? renderRoot;
    const replacement = focusedKey === undefined
      ? focusedContainer.querySelector<HTMLElement>(`.${focusedClassName}`)
      : [...renderRoot.querySelectorAll<HTMLElement>("[data-preserve]")]
        .find((candidate) => candidate.dataset.preserve === focusedKey);
    if (replacement === undefined || replacement === null) {
      // The focused control's destination changed underneath it (for example,
      // selecting a story switches Library away for Write). Land keyboard
      // focus on the newly active destination instead of dropping it to body.
      renderRoot.querySelector<HTMLElement>(".rail .active")?.focus({ preventScroll: true });
      return;
    }
    const editable = replacement instanceof HTMLInputElement
      || replacement instanceof HTMLTextAreaElement;
    if (focusedValue !== undefined && editable) replacement.value = focusedValue;
    replacement.focus({ preventScroll: true });
    if ((replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement)
      && selectionStart !== null && selectionEnd !== null) {
      replacement.setSelectionRange(selectionStart, selectionEnd);
    }
    if (replacement instanceof HTMLTextAreaElement && scrollTop !== null) replacement.scrollTop = scrollTop;
  }

  private requireApi(): StoryApi {
    if (this.api === null) throw new Error("The desktop Host is not connected.");
    return this.api;
  }

  private requireStory(): StoryPayload {
    if (this.state.story === null) throw new Error("Open a story first.");
    return this.state.story;
  }

  private async run(status: string, work: () => Promise<void>): Promise<void> {
    const storyId = this.state.story?.id;
    this.setState({ status, error: null });
    try {
      await work();
      if (this.state.status === status) this.setState({ status: "Done" });
    } catch (error) {
      if (storyId !== undefined && apiErrorCode(error) === "revision_conflict"
        && await this.reloadStoryPreservingDrafts(storyId)) {
        this.setState({
          status: "Story refreshed; retry the action",
          error: "The story changed. The latest story is loaded and your unsaved edits remain. Retry the action."
        });
        return;
      }
      this.setState({ status: "Action failed", error: messageOf(error) });
    }
  }
}

new RendererApp().start();

/** The toast for a take switch (D-38, §7): "take j of k · ¶ n". Falls back to
 * naming just the part when the switched-to node has no sibling takes. */
function takeSwitchStatus(story: StoryPayload, nodeId: string): string {
  const index = story.path.findIndex((node) => node.id === nodeId);
  if (index === -1) return "Focused";
  const node = story.path[index]!;
  const siblings = story.nodes.filter((candidate) => candidate.parentId === node.parentId && candidate.role !== "summary");
  const takeIndex = siblings.findIndex((candidate) => candidate.id === node.id);
  if (siblings.length < 2 || takeIndex === -1) return `¶ ${index + 1}`;
  return `take ${takeIndex + 1} of ${siblings.length} · ¶ ${index + 1}`;
}

async function rewriteStreamDigest(text: string): Promise<string> {
  const input = new TextEncoder().encode(`1667-partial-rewrite\0${text}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

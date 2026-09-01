import { type CommandId, type PaletteCommand } from "./command-model.js";
import { connectionFailed, connectionSucceeded } from "./connection.js";
import { createComposer } from "./composer-model.js";
import { writeExportFile, writeStoryExport } from "./export-file.js";
import { exportGenerationProfile } from "../../server/import-profile-export.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import {
  openAuthorBriefEditor,
  openAuthorsNoteEditor,
  openBannedStringsEditor,
  openFactEditor,
  openFactFromSelection,
  openFactsBudgetEditor,
  openPhraseBiasEditor,
  inlineEditorAction
} from "./editor-action.js";
import {
  armPrune,
  generationBusy,
  openTag,
  runPartAction,
  rerouteToNode,
  streamLive
} from "./story-actions.js";
import { openDirectComposer } from "./composer-ownership.js";
import { createUnusedTakesPrunePlan } from "./prune-model.js";
import { openChapters, createBreakAtFocus } from "./chapter-actions.js";
import { createStoryViewModel, lastPartRowIndex } from "./model.js";
import { rememberFocus } from "./reading-position-persist.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { startSummary } from "./summary-action.js";
import { openAside } from "./aside-actions.js";
import { openRewriteComposer, partIdFromTextSelection, resolveRewriteTarget } from "./rewrite-action.js";
import { openLibrary } from "./library-actions.js";
import { openCardImport } from "./card-import-actions.js";
import { openArchiveImport } from "./archive-import-actions.js";
import { openImageAttach } from "./image-attach-actions.js";
import { publishStories } from "./overlay-publication.js";
import {
  openSettingsOverlay
} from "./settings-overlay-actions.js";
import { synchronizeSettingsModelDiscovery } from "./settings-model-discovery.js";
import { recordNotice } from "./notice-log.js";
import { openTokenProbabilities } from "./token-probabilities-actions.js";
import { openGenerationRecordViewer } from "./generation-record-actions.js";
import { openRequestViewer } from "./request-viewer-actions.js";
import { mapAction } from "./map-actions.js";
import { factsOpeningPartId } from "./facts-command-context.js";
import { runPaletteMapRetake } from "./palette-map-retake.js";
import {
  capturePaletteOwner,
  clearPaletteOwnerTransients,
  editorHasUnsavedInput,
  paletteOwnerHasUnsavedInput,
  releasePaletteOwner,
  settingsPaletteHasUnsavedWork
} from "./palette-owner.js";
import type { AppSource } from "./app.js";
import type { ResolvedKey } from "./keys.js";
import type { FactsOverlayState, RuntimeState } from "./state.js";
import type { ActionContext } from "./action-context.js";

export interface PaletteCommandRunnerDeps {
  factsAction: (
    resolved: ResolvedKey,
    state: RuntimeState,
    source: AppSource,
    context: ActionContext
  ) => Promise<boolean>;
  initialFacts: () => FactsOverlayState;
  reconnect: (state: RuntimeState, source: AppSource, context: ActionContext) => Promise<void>;
  rewriteRequestNotProjectedToast: string;
}

const FACT_EDITOR_COMMAND_ACTIONS: Partial<Record<CommandId, ResolvedKey["action"]>> = {
  "fact-editor-toggle-view": "toggle-view-mode",
  "fact-editor-previous-state": "cycle-state",
  "fact-editor-next-state": "cycle-state",
  "fact-editor-new-state": "new-state",
  "fact-editor-open-anchor": "open-state-anchor",
  "fact-editor-reanchor-state": "reanchor-state",
  "fact-editor-convert-state": "convert-state",
  "fact-editor-delete-state": "delete-state"
};

const FACTS_COMMAND_ACTIONS: Partial<Record<CommandId, ResolvedKey["action"]>> = {
  "facts-open-selected": "open-selected",
  "facts-filter": "filter",
  "facts-cycle-tag": "cycle",
  "facts-clear-filter": "clear-filter",
  "facts-cycle-scope": "cycle-fact-scope",
  "facts-delete": "delete-item",
  "facts-move-up": "move-item-up",
  "facts-move-down": "move-item-down",
  "facts-open-anchor": "open-selected",
  "facts-edit-state": "edit",
  "facts-dossier-previous-state": "cycle-state",
  "facts-dossier-next-state": "cycle-state",
  "facts-toggle-diff": "toggle-fact-diff"
};

const MAP_COMMAND_ACTIONS: Partial<Record<CommandId, ResolvedKey["action"]>> = {
  "map-open-fact-lens": "open-fact-lens",
  "map-cycle-fact-lens": "cycle-fact-lens",
  "map-close-fact-lens": "cancel",
  "map-open-fact-lens-anchor": "open-fact-lens-anchor",
  "map-edit-fact-lens": "edit-fact-lens"
};

/** Commands that replace the surface which opened the global palette. */
const PALETTE_DESTINATION_COMMANDS: ReadonlySet<CommandId> = new Set([
  "facts", "new-fact", "new-fact-from-here", "new-fact-from-selection", "edit-fact",
  "new-fact-state", "end-fact-here", "token-probabilities",
  "generation-records", "tag-line", "authors-note", "author-brief", "facts-budget",
  "phrase-bias", "banned-strings", "aside", "switch-story", "rename-story",
  "direct-take", "retake", "rewrite-selection", "summary", "chapters", "chapter",
  "import-card", "import-archive", "attach-image", "settings", "reconnect", "prune"
]);

export async function runPaletteCommand(
  command: PaletteCommand,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  deps: PaletteCommandRunnerDeps
): Promise<void> {
  // Both refusals belong here, ahead of any mode change. A refused command
  // leaves the invoking surface and its draft untouched.
  if ((command.mutating === true && generationBusy(state))
    || (command.blockedByLiveStream === true && streamLive(state))) {
    state.toast = "stream running · esc stops it first";
    return;
  }
  if (command.id === "tags") {
    state.commands!.view = "tags";
    state.commands!.cursor = 0;
    return;
  }
  const paletteSession = state.commands!;
  const returnMode = state.commands!.returnMode;
  const dormantOwner = capturePaletteOwner(state, returnMode);
  if (returnMode === "SETTINGS"
    && settingsPaletteHasUnsavedWork(state)
    && (command.settingsTarget !== undefined || PALETTE_DESTINATION_COMMANDS.has(command.id))) {
    state.commands = null;
    state.mode = "SETTINGS";
    state.toast = "save or cancel Settings changes first";
    return;
  }
  if ((command.settingsTarget !== undefined || PALETTE_DESTINATION_COMMANDS.has(command.id))
    // Direct resumes the retained composer and retires only a suspended
    // retake. It is safe even when that Direct composer has text.
    && !(command.id === "direct-take" && returnMode === "COMPOSE")
    && paletteOwnerHasUnsavedInput(state, returnMode)) {
    state.commands = null;
    state.mode = returnMode;
    state.toast = "finish or cancel current input first";
    return;
  }
  // A dirty editor can target an abandoned leaf; pruning that leaf would
  // invalidate the draft before Escape can restore it.
  if (command.id === "prune"
    && returnMode === "EDITOR"
    && editorHasUnsavedInput(state)) {
    state.commands = null;
    state.mode = "EDITOR";
    state.toast = "finish or cancel current input first";
    return;
  }
  const selection = state.commands!.selection ?? null;
  // MAP has its own cursor in each view. Capture it while the palette still
  // owns the suspended Map; the normal NAV retake path otherwise falls back
  // to the stale story focus index.
  const mapRetakeTarget = command.id === "retake" && returnMode === "MAP"
    ? factsOpeningPartId(state)
    : undefined;
  // PROBS keeps its own displayed take identity. Its Tab cursor does not
  // move NAV's focusIndex, so never let Retake fall back to that stale row.
  const probsRetakeTarget = command.id === "retake" && returnMode === "PROBS"
    ? state.probs?.nodeId ?? null
    : undefined;
  // RECORD keeps its own displayed take identity. Its viewer can be opened
  // from MAP while NAV's focus remains on a different story part.
  const recordRetakeTarget = command.id === "retake" && returnMode === "RECORD"
    ? state.record?.nodeId ?? null
    : undefined;
  // A Record opened from MAP keeps that exact Map parent alive for its close
  // route. Retake exits to NAV, so retain the identity for the final cascade
  // release after the Record owner settles.
  const recordParentMap = command.id === "retake" && returnMode === "RECORD"
    && state.record?.returnMode === "MAP"
    ? capturePaletteOwner(state, "MAP")
    : null;

  // Summary and an in-flight Aside answer own their surface until they settle.
  // Keep the palette escapable, but do not let a destination command strand the
  // live operation or let its completion overwrite the requested destination.
  if (returnMode === "SUMMARY" && state.summary !== null
    || returnMode === "ASIDE" && state.aside?.busy === true) {
    state.commands = null;
    state.mode = returnMode;
    state.toast = returnMode === "SUMMARY"
      ? "summary running · esc cancels"
      : "Aside is answering · esc stops it first";
    return;
  }

  // The palette may suspend a dirty editor, but a second command must not
  // replace its draft. Fact-editor commands use the existing reducer below.
  if (returnMode === "EDITOR"
    && !command.id.startsWith("fact-editor-")
    && (command.settingsTarget !== undefined || PALETTE_DESTINATION_COMMANDS.has(command.id))) {
    state.commands = null;
    state.mode = "EDITOR";
    state.toast = "close the current editor before running this command";
    return;
  }

  const factEditorAction = FACT_EDITOR_COMMAND_ACTIONS[command.id];
  if (factEditorAction !== undefined) {
    state.commands = null;
    if (returnMode !== "EDITOR" || state.editor?.kind !== "fact") {
      state.mode = returnMode;
      state.toast = "Fact editor is no longer open";
      clearPaletteOwnerTransients(state, returnMode, dormantOwner, paletteSession);
      return;
    }
    state.mode = "EDITOR";
    await inlineEditorAction({
      action: factEditorAction,
      ...(command.id === "fact-editor-previous-state" ? { index: -1 } : {}),
      ...(command.id === "fact-editor-next-state" ? { index: 1 } : {})
    }, state, source, context);
    clearPaletteOwnerTransients(state, returnMode, dormantOwner, paletteSession);
    return;
  }

  const factsActionName = FACTS_COMMAND_ACTIONS[command.id]
    ?? (command.id === "new-fact-state" ? "new-state"
      : command.id === "end-fact-here" ? "end-state"
        : command.id === "edit-fact" ? "edit"
          : undefined);
  if (factsActionName !== undefined && returnMode === "FACTS" && state.facts !== null) {
    state.commands = null;
    state.mode = "FACTS";
    await deps.factsAction({
      action: factsActionName,
      ...(command.id === "facts-dossier-previous-state" ? { index: -1 } : {}),
      ...(command.id === "facts-dossier-next-state" ? { index: 1 } : {})
    }, state, source, context);
    clearPaletteOwnerTransients(state, returnMode, dormantOwner, paletteSession);
    return;
  }

  const mapActionName = MAP_COMMAND_ACTIONS[command.id];
  if (mapActionName !== undefined && returnMode === "MAP" && state.map !== null) {
    state.commands = null;
    state.mode = "MAP";
    await mapAction({ action: mapActionName }, state, source, {
      ...context,
      reroute: (currentState, currentSource, currentContext, nodeId) => rerouteToNode(
        currentState,
        currentSource,
        currentContext,
        nodeId,
        {
          owns: (ownedState) => ownedState.mode === "MAP" && ownedState.map === state.map,
          release: (ownedState) => { ownedState.map = null; }
        }
      ),
      armPrune,
      openTag
    });
    clearPaletteOwnerTransients(state, returnMode, dormantOwner, paletteSession);
    return;
  }

  state.commands = null;
  // A command that does not open another surface returns to its exact owner.
  // Surface-changing commands below select their own mode as needed.
  state.mode = returnMode;
  if (command.id === "facts") {
    state.facts ??= deps.initialFacts();
    state.mode = "FACTS";
  }
  else if (command.id === "new-fact") openFactEditor(state, null);
  else if (command.id === "new-fact-from-selection") {
    if (selection === null || selection.text.trim().length === 0) {
      state.toast = "highlight story text before creating a Fact";
    } else {
      openFactFromSelection(
        state,
        selection.text,
        returnMode === "FACTS" ? { returnMode: "FACTS" } : {}
      );
    }
  }
  else if (command.id === "new-fact-from-here") {
    const anchorPartId = factsOpeningPartId(state);
    if (anchorPartId === null) state.toast = "select a story part before creating a Fact";
    else openFactEditor(state, null, { anchorPartId });
  }
  else if (command.id === "edit-fact") {
    state.facts = deps.initialFacts();
    state.facts.pendingFactAction = { kind: "edit", anchorPartId: null };
    state.mode = "FACTS";
  }
  else if (command.id === "new-fact-state" || command.id === "end-fact-here") {
    state.facts = deps.initialFacts();
    state.facts.pendingFactAction = {
      kind: command.id === "new-fact-state" ? "new-state" : "end",
      anchorPartId: factsOpeningPartId(state)
    };
    state.mode = "FACTS";
  }
  else if (command.id === "next-request") {
    if (state.retakePrompt?.intent.kind === "rewrite") {
      state.mode = returnMode;
      state.toast = deps.rewriteRequestNotProjectedToast;
    } else if (!(returnMode === "REQUEST" && state.request !== null)) {
      openRequestViewer(state, returnMode === "COMMANDS" ? "NAV" : returnMode);
    }
  }
  else if (command.id === "token-probabilities") {
    if (state.mode !== "NAV") state.mode = "NAV";
    await openTokenProbabilities(state, source, context);
  }
  else if (command.id === "generation-records") {
    if (state.mode !== "NAV" && state.mode !== "MAP") state.mode = "NAV";
    await openGenerationRecordViewer(state, source, context);
  }
  else if (command.id === "tag-line") {
    const anchorPartId = factsOpeningPartId(state);
    if (anchorPartId === null) state.toast = "select a story part before tagging it";
    else openTag(state, anchorPartId);
  }
  else if (command.id === "authors-note") openAuthorsNoteEditor(state);
  else if (command.id === "author-brief") openAuthorBriefEditor(state);
  else if (command.id === "facts-budget") openFactsBudgetEditor(state);
  else if (command.id === "phrase-bias") openPhraseBiasEditor(state);
  else if (command.id === "banned-strings") openBannedStringsEditor(state);
  else if (command.id === "aside") await openAside(state, source.api, {
    entryPointsOpen: context.asideEntryPointsOpen
  });
  else if (command.id === "switch-story") await openLibrary(state, source, context);
  else if (command.id === "rename-story") {
    const targetId = state.payload.id;
    const title = state.payload.title;
    await openLibrary(state, source, context, {
      selectedStoryId: targetId,
      prompt: { kind: "rename", composer: createComposer(title), targetId }
    });
  }
  else if (command.id === "direct-take") openDirectComposer(state);
  else if (command.id === "retake") {
    if (returnMode === "PROBS" || returnMode === "RECORD") {
      state.mode = "NAV";
      const target = returnMode === "PROBS" ? probsRetakeTarget : recordRetakeTarget;
      if (target === null) {
        state.toast = "select a visible story part before retaking it";
      } else {
        await runPartAction("retake", state, source, context, target);
      }
    } else {
      await runPaletteMapRetake(
        state,
        source,
        context,
        returnMode === "MAP" ? mapRetakeTarget : undefined,
        paletteSession
      );
    }
  }
  else if (command.id === "rewrite-selection") {
    if (selection === null) {
      state.toast = "highlight story text before rewriting it";
    } else if (state.connection.down) {
      state.toast = "offline · reading still works";
    } else {
      const partId = partIdFromTextSelection(selection.spans);
      const resolved = partId === null
        ? { error: "highlight story text before rewriting it" }
        : resolveRewriteTarget(state.payload, partId, selection.spans);
      if ("error" in resolved) state.toast = resolved.error;
      else openRewriteComposer(state, resolved);
    }
  }
  else if (command.id === "export") {
    const title = state.payload.title;
    await context.backend.run("exporting story", async (task) => {
      const exported = await source.api.exportMarkdown(task.storyId);
      if (!task.owns()) return;
      const file = await writeStoryExport({
        directory: source.exportDirectory,
        title,
        markdown: exported.markdown
      });
      if (task.interactionCurrent()) {
        state.toast = exported.fidelity.length === 0
          ? `exported ${file}`
          : `exported ${file} · ${exported.fidelity.join("; ")}`;
      }
    });
  } else if (command.id === "export-profile") {
    if (!source.settingsView.editable) {
      state.toast = "Generation Profiles require settings format 2";
      return;
    }
    const document = source.settingsView.document;
    const profileId = selectSettingsRoute(document, "prose").profileId;
    await context.backend.run("exporting Generation Profile", async (task) => {
      try {
        const archive = exportGenerationProfile(document as never, profileId);
        const file = await writeExportFile({
          directory: source.exportDirectory,
          title: document.profiles[profileId]!.name,
          extension: archive.extension,
          content: archive.text
        });
        if (!task.interactionCurrent()) return;
        state.toast = `exported ${file} · connection data omitted`;
        recordNotice(state.notices, "toast", `exported Generation Profile · ${archive.fidelity.join("; ")}`);
      } catch (error) {
        if (task.interactionCurrent()) {
          state.toast = `could not export Generation Profile · ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });
  } else if (command.id === "summary") await startSummary(state, source, context);
  else if (command.id === "chapters") openChapters(state);
  else if (command.id === "chapter") {
    state.mode = "NAV";
    state.focusIndex = lastPartRowIndex(createStoryViewModel(state.payload));
    rememberFocus(state, source);
    await createBreakAtFocus(state, source, context);
  }
  else if (command.id === "autoname") {
    await context.backend.run("naming story", async (task) => {
      const payload = await source.api.autonameStory(task.storyId);
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload, context.cache);
      if (!task.owns()) return;
      const stories = await source.api.listStories();
      if (!task.owns()) return;
      publishStories(state, source, stories);
      if (task.interactionCurrent()) state.toast = `story named ${payload.title}`;
    });
  } else if (command.id === "prune") {
    const plan = createUnusedTakesPrunePlan(state.payload);
    if (plan === null) state.toast = "nothing to prune · every leaf is protected";
    else {
      state.prune = plan;
      // Only NAV and MAP render the destructive confirmation as their active
      // surface. Keep MAP because its breadcrumb owns the same confirmation;
      // release every other suspended owner before confirmation is accepted.
      if (returnMode !== "MAP") state.mode = "NAV";
    }
  } else if (command.id === "prompts") {
    state.showInstructions = !state.showInstructions;
    state.toast = `directions ${state.showInstructions ? "shown" : "hidden"}`;
  }
  else if (command.settingsTarget !== undefined || command.id === "settings") {
    await openSettingsOverlay(state, source, context, command.settingsTarget);
    await synchronizeSettingsModelDiscovery(state, source, context);
  }
  else if (command.id === "theme" && command.theme !== undefined) {
    context.applyTheme(command.theme);
    state.toast = `theme · ${command.theme}`;
  }
  else if (command.id === "reconnect") await deps.reconnect(state, source, context);
  else if (command.id === "folder") state.toast = source.storyFolder;
  else if (command.id === "import-card") openCardImport(state, returnMode === "COMPOSE" ? "COMPOSE" : "NAV");
  else if (command.id === "import-archive") openArchiveImport(state, returnMode === "COMPOSE" ? "COMPOSE" : "NAV");
  else if (command.id === "attach-image") openImageAttach(state, source, returnMode === "COMPOSE" ? "COMPOSE" : "NAV");
  else if (command.id === "disconnect" && state.demo) {
    state.connection = connectionFailed(connectionSucceeded(), new Error("demo disconnect"), state.now);
    state.toast = "simulated connection loss";
  }
  releasePaletteOwner(state, returnMode, dormantOwner, paletteSession);
  if (recordParentMap !== null && state.mode === "NAV") {
    releasePaletteOwner(state, "MAP", recordParentMap, paletteSession);
  }
}

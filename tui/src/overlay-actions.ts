import {
  commandContext,
  commandMatches,
  commandQueryCursor,
  retainCommandSelection,
  type CommandMatch
} from "./command-model.js";
import { factEditorPaletteContext } from "./facts-command-catalog.js";
import { connectionFailed, connectionSucceeded } from "./connection.js";
import { createComposer, setComposerText } from "./composer-model.js";
import {
  boundedFactCursor,
  boundedFactSelection,
  FACT_SCOPE_FILTERS,
  factRows,
  factTags,
  isSingleUnscopedTextFact
} from "./facts-model.js";
import { canonicalFactStates, isFactStateful } from "../../shared/fact-state.js";
import { applyTextKey, type ResolvedKey } from "./keys.js";
import {
  openAuthorBriefEditor,
  openAuthorsNoteEditor,
  openBannedStringsEditor,
  openFactEditor,
  openFactStateEditor,
  openFactsBudgetEditor,
  openPhraseBiasEditor
} from "./editor-action.js";
import {
  generationBusy,
  landOnNode,
  openTag,
  rerouteToNode,
} from "./story-actions.js";
import { openDirectComposer } from "./composer-ownership.js";
import { chaptersAction, createBreakAtFocus, openChapters } from "./chapter-actions.js";
import { createStoryViewModel, lastPartRowIndex, rowPart } from "./model.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { cancelSummary } from "./summary-action.js";
import { noteAsidePaletteInteraction, openAside } from "./aside-actions.js";
import { openAsideUseMenuFromMouse } from "./aside-use.js";
import {
  cancelPlacement,
  confirmPlacement,
  movePlacementCursor,
  placementInputLocked
} from "./aside-placement.js";
import { composerMotion } from "./composer-motion.js";
import { directComposerWrapWidth } from "./composer-geometry.js";
import { composerPageRows } from "./composer-viewport.js";
import { composerSurfaceAction } from "./composer-surface-action.js";
import { asideCursor } from "./aside-surface.js";
import { asideKeyAction } from "./aside-overlay-actions.js";
import { openRewriteComposer, partIdFromTextSelection, resolveRewriteTarget } from "./rewrite-action.js";
import type { AppSource } from "./app.js";
import { canRewriteSelection, type ProjectedStorySelection } from "./selection-projection.js";
import { storySelectionFromRendererSelection } from "./copy-actions.js";
import { libraryAction, openLibrary } from "./library-actions.js";
import { openSearch } from "./search-actions.js";
import { cardImportAction, openCardImport } from "./card-import-actions.js";
import { archiveImportAction, openArchiveImport } from "./archive-import-actions.js";
import { imageAttachAction, openImageAttach } from "./image-attach-actions.js";
import { factsOpeningPartId, factsPaletteContext } from "./facts-command-context.js";
import { runPaletteCommand } from "./palette-command-runner.js";
import { publishStories } from "./overlay-publication.js";
import { retryBackendState } from "./recovery-orchestration.js";
import {
  openSettingsOverlay,
  settingsOverlayAction
} from "./settings-overlay-actions.js";
import { synchronizeSettingsModelDiscovery } from "./settings-model-discovery.js";
import { panelContentRows } from "./screens/overlay.js";
import { logBodyHeight, maxNoticeScrollOffset } from "./screens/log.js";
import {
  boundedNoticeCursor,
  clearNoticeLog,
  recordNotice,
  setNoticeCursor,
  type NoticeLog
} from "./notice-log.js";
import { copyToClipboard } from "./clipboard.js";
import {
  openRequestViewer,
  requestViewerAction
} from "./request-viewer-actions.js";
import {
  openTokenProbabilities,
  tokenProbabilitiesAction
} from "./token-probabilities-actions.js";
import {
  generationRecordAction,
  openGenerationRecordViewer
} from "./generation-record-actions.js";
import { factConsistencyOverlayAction } from "./fact-consistency-runtime.js";
import { factConsistencyRunAvailable } from "./fact-consistency-guard.js";
import type { FactsOverlayState, RuntimeState } from "./state.js";
import type { ActionContext } from "./action-context.js";

export type OverlayActionContext = ActionContext;

/** A rewrite composer's request has no honest projection yet — see the
 *  comment on `nextRequestContext` (request-context.ts) — so both entry
 *  points to the viewer (the `open-request` action below and the
 *  `next-request` palette command in `runCommand`) refuse to open it while
 *  one owns the composer, rather than show the baseline continuation
 *  request under a "next request" label that implies it describes the
 *  rewrite. */
const REWRITE_REQUEST_NOT_PROJECTED_TOAST = "a highlighted rewrite's request is not projected yet";

export async function handleOverlayAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: OverlayActionContext,
  capturedStorySelection: ProjectedStorySelection | null | undefined = undefined
): Promise<boolean> {
  // Top-level navigation owns quit even while an overlay is open. Let the
  // dispatch tail call `navAction`, which invokes the app's quit callback.
  if (resolved.action === "quit") return false;
  if (resolved.action === "open-commands") {
    // Ctrl-P is a global escape hatch. Do not nest a second palette, and do
    // not clear any transient menu/editor that must be restored on Esc.
    if (state.mode === "COMMANDS" && state.commands !== null) return true;
    // The NAV projection this reads is only built for that one frame, so the
    // selection has to be captured now — a later keystroke cannot rebuild it.
    const factsSelection = state.mode === "FACTS"
      ? state.facts?.storySelection
      : undefined;
    const retainedFactsSelection = factsSelection ?? null;
    const selection = state.mode === "FACTS"
      ? capturedStorySelection !== undefined
        ? capturedStorySelection ?? retainedFactsSelection
        : factsSelection !== undefined
          ? retainedFactsSelection
          : context.renderer === null
            ? null
            : storySelectionFromRendererSelection(context.renderer, state.storySelectionProjection)
      : capturedStorySelection !== undefined
        ? capturedStorySelection
        : context.renderer === null
          ? null
          : storySelectionFromRendererSelection(context.renderer, state.storySelectionProjection);
    state.commands = {
      query: "",
      view: "commands",
      deleteArmedTagNodeId: null,
      returnMode: state.mode === "COMMANDS" ? "NAV" : state.mode,
      selection,
      ...retainCommandSelection(liveCommandMatches(
        state, "", selection, context.asideEntryPointsOpen
      ), null, 0)
    };
    state.mode = "COMMANDS";
    return true;
  }
  if (resolved.action === "retry") { await reconnect(state, source, context); return true; }
  if (resolved.action === "open-aside") {
    await openAside(state, source.api, {
      entryPointsOpen: context.asideEntryPointsOpen
    });
    return true;
  }
  if (resolved.action === "open-authors-note") {
    openAuthorsNoteEditor(state);
    return true;
  }
  if (resolved.action === "open-request") {
    if (state.mode === "REQUEST") requestViewerAction(resolved, state, context.renderer?.height);
    else if (state.mode === "NAV" || state.mode === "COMPOSE") {
      if (state.retakePrompt?.intent.kind === "rewrite") {
        state.toast = REWRITE_REQUEST_NOT_PROJECTED_TOAST;
      } else {
        openRequestViewer(state);
      }
    }
    return true;
  }
  if (resolved.action === "open-aside-use") {
    if (state.mode === "ASIDE" && state.aside !== null) {
      openAsideUseMenuFromMouse(
        state.aside,
        resolved.index ?? asideCursor(state.aside),
        resolved.selectionText,
        resolved.selectionSpans
      );
    }
    return true;
  }
  if (resolved.action === "open-probs") {
    if (state.mode === "NAV") await openTokenProbabilities(state, source, context);
    return true;
  }
  if (state.mode === "PROBS" && state.probs !== null) {
    await tokenProbabilitiesAction(resolved, state, source, context);
    return true;
  }
  if (resolved.action === "open-records") {
    if (state.mode === "NAV" || state.mode === "MAP") {
      await openGenerationRecordViewer(state, source, context);
    }
    return true;
  }
  if (state.mode === "RECORD" && state.record !== null) {
    await generationRecordAction(resolved, state, source, context);
    return true;
  }
  if (state.mode === "ASIDE" && state.aside !== null) {
    await asideKeyAction(resolved, state, source, context);
    return true;
  }
  if (state.mode === "PLACE" && state.placement !== null) {
    await placementKeyAction(resolved, state, source, context);
    return true;
  }
  if (resolved.action === "open-log") {
    // The notice the writer came from is the newest one, and `recordNotices`
    // already put the cursor on it. The map is a place, so closing the log
    // has to put the writer back in it rather than on the page.
    setNoticeCursor(state.notices, state.notices.cursor);
    state.notices.returnMode = state.mode === "MAP" ? "MAP" : "NAV";
    state.mode = "LOG";
    return true;
  }
  if (state.mode === "LOG") {
    await logAction(resolved, state, context.renderer?.height, context.renderer?.width);
    return true;
  }
  if (resolved.action === "open-library") { await openLibrary(state, source, context); return true; }
  if (resolved.action === "open-facts") {
    const factConsistencyReturn = state.mode === "FACT-CONSISTENCY"
      && state.factConsistency?.surface.phase === "results"
      ? "FACT-CONSISTENCY" as const
      : undefined;
    let factIndex = resolved.index;
    if (state.mode === "FACT-CONSISTENCY") {
      const surface = state.factConsistency?.surface;
      if (surface?.phase !== "results") return true;
      const finding = surface.run.findings[surface.cursor];
      if (finding === undefined) {
        state.toast = "select a finding first";
        return true;
      }
      factIndex = state.payload.facts.findIndex(({ id }) => id === finding.factId);
      if (factIndex < 0) {
        state.toast = "the finding's Fact is no longer available";
        return true;
      }
    }
    state.facts = {
      ...initialFacts(),
      storySelection: capturedStorySelection === undefined ? null : capturedStorySelection,
      ...(factConsistencyReturn === undefined ? {} : { returnMode: factConsistencyReturn })
    };
    if (factIndex !== undefined) {
      const cursor = Math.max(0, Math.min(state.payload.facts.length - 1, factIndex));
      state.facts.cursor = cursor;
    }
    state.mode = "FACTS";
    return true;
  }
  if (state.mode === "FACT-CONSISTENCY" && state.factConsistency !== null
    && state.factConsistency !== undefined) {
    return await factConsistencyOverlayAction(resolved, state, source, context);
  }
  if (resolved.action === "open-settings") {
    await openSettingsOverlay(
      state,
      source,
      context,
      resolved.settingsRow,
      resolved.settingsProfilePurpose
    );
    await synchronizeSettingsModelDiscovery(state, source, context);
    return true;
  }
  if (resolved.action === "open-chapters") { openChapters(state); return true; }
  if (resolved.action === "open-search") { openSearch(state, source); return true; }
  if (state.mode === "REQUEST" && state.request !== null) {
    requestViewerAction(resolved, state, context.renderer?.height);
    return true;
  }
  if (state.mode === "LIBRARY" && state.library !== null) {
    const prompt = state.library.prompt;
    const needsBackend = resolved.action === "new-item"
      || (resolved.action === "open-selected" && (prompt === null || prompt.kind !== "filter"));
    if (needsBackend && generationBusy(state)) {
      state.toast = "stream running · esc stops it first";
      return true;
    }
    return await libraryAction(resolved, state, source, context);
  }
  if (state.mode === "FACTS" && state.facts !== null) return await factsAction(resolved, state, source, context);
  if (state.mode === "COMMANDS" && state.commands !== null) return await commandsAction(resolved, state, source, context);
  if (state.mode === "CARD" && state.card !== null) return await cardImportAction(resolved, state, source, context);
  if (state.mode === "ARCHIVE" && state.archive !== null) return await archiveImportAction(resolved, state, source, context);
  if (state.mode === "IMAGE" && state.image != null) return await imageAttachAction(resolved, state, source, context);
  if (state.mode === "SETTINGS" && state.settings !== null) {
    const handled = await settingsOverlayAction(resolved, state, source, context);
    await synchronizeSettingsModelDiscovery(state, source, context);
    return handled;
  }
  if (state.mode === "CHAPTERS" && state.chapters !== null) {
    await chaptersAction(resolved, state, source, context);
    return true;
  }
  if (state.mode === "SUMMARY" && state.summary !== null) {
    if (resolved.action === "cancel") {
      cancelSummary(state);
    }
    return true;
  }
  if (state.mode === "KEYS") {
    scrollKeysReference(resolved, state, context.renderer?.height);
    return true;
  }
  return false;
}

/** C-37's keys: `↑↓` move · `⇧↑↓` scrolls a line and `pgup`/`pgdn` a page
 *  within the focused notice · `↵` copies · `x` clears · `!` or `esc`
 *  closes. Clearing is unceremonious — the log holds nothing the story needs.
 *  `terminalHeight` sizes a scroll page exactly to what `renderLogScreen`
 *  paints, the same way `scrollKeysReference` sizes its own page below.
 *  `terminalWidth` joins it to clamp the stored offset itself (not just the
 *  rendered window): without a width, `noticeRows` cannot say how tall the
 *  focused notice actually is, so an unclamped offset could grow past the
 *  notice's last row and leave `pageup` seemingly frozen while it unwinds. */
async function logAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  terminalHeight?: number,
  terminalWidth?: number
): Promise<void> {
  const log = state.notices;
  if (resolved.action === "cancel") {
    state.mode = log.returnMode;
    return;
  }
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    setNoticeCursor(log, log.cursor + (resolved.action === "focus-next" ? 1 : -1));
    return;
  }
  if (resolved.action === "focus-index" && resolved.index !== undefined) {
    setNoticeCursor(log, resolved.index);
    return;
  }
  if (resolved.action === "scroll-line-down" || resolved.action === "scroll-line-up") {
    const delta = resolved.action === "scroll-line-down" ? 1 : -1;
    log.scrollOffset = scrolledNoticeOffset(log, delta, terminalWidth, terminalHeight);
    return;
  }
  if (resolved.action === "scroll-down" || resolved.action === "scroll-up") {
    const page = terminalHeight === undefined ? 1 : logBodyHeight(terminalHeight);
    const delta = resolved.action === "scroll-down" ? page : -page;
    log.scrollOffset = scrolledNoticeOffset(log, delta, terminalWidth, terminalHeight);
    return;
  }
  if (resolved.action === "clear-log") {
    clearNoticeLog(log);
    return;
  }
  if (resolved.action === "copy-part") {
    const notice = log.entries[boundedNoticeCursor(log, log.cursor)];
    if (notice === undefined) return;
    // The toast the copy raises would itself land in the log and push the
    // notice the writer just copied off the top, so the log stays quiet here.
    await copyToClipboard(notice.text);
  }
}

/** Bound a requested scroll offset to the focused notice's actual last row.
 *  Without a live renderer (an early input before the first frame, or a
 *  test harness), a conservative 80x24 stands in — the same fallback size
 *  `context.renderer?.width ?? 80` and `?? 24` already use elsewhere (see
 *  story-actions.ts's composeAction and editor-action.ts) — so the offset
 *  still cannot grow without bound; it is just bounded by an assumed size
 *  instead of the real one until a frame reports it. */
function clampedNoticeScrollOffset(
  log: NoticeLog,
  requested: number,
  terminalWidth: number | undefined,
  terminalHeight: number | undefined
): number {
  const maxOffset = maxNoticeScrollOffset(log, terminalWidth ?? 80, terminalHeight ?? 24);
  return Math.max(0, Math.min(maxOffset, requested));
}

/** Apply a scroll delta to the *currently valid* clamped offset, not to the
 *  raw stored one. A terminal resize since the last scroll leaves
 *  `log.scrollOffset` stale — `windowStart` clamps it for display but never
 *  writes the clamped value back — so growing the terminal can leave it well
 *  past the new maximum. Basing the delta on the stale value there would
 *  produce a keypress that visibly does nothing, or jumps the wrong
 *  distance, until enough presses absorb the gap: the same symptom
 *  `clampedNoticeScrollOffset` exists to prevent, reached by a different
 *  route. No resize hook and no new state: the very next scroll keypress
 *  after a resize is what re-grounds the offset. */
function scrolledNoticeOffset(
  log: NoticeLog,
  delta: number,
  terminalWidth: number | undefined,
  terminalHeight: number | undefined
): number {
  const current = clampedNoticeScrollOffset(log, log.scrollOffset, terminalWidth, terminalHeight);
  return clampedNoticeScrollOffset(log, current + delta, terminalWidth, terminalHeight);
}

/** The reference only reads and scrolls; `open-keys` owns the reset. Page
 * actions advance by exactly the rows the panel paints at the current height.
 * The renderer still owns and applies the upper bound. */
function scrollKeysReference(
  resolved: ResolvedKey,
  state: RuntimeState,
  terminalHeight?: number
): void {
  if (resolved.action === "cancel") {
    state.mode = "NAV";
    return;
  }
  const page = terminalHeight === undefined ? 1 : panelContentRows(terminalHeight);
  const step: Partial<Record<ResolvedKey["action"], number>> = {
    "focus-next": 1,
    "focus-previous": -1,
    "scroll-down": page,
    "scroll-up": -page
  };
  state.keysScrollTop = Math.max(0, state.keysScrollTop + (step[resolved.action] ?? 0));
}

function initialFacts() {
  return {
    cursor: 0,
    query: "",
    chip: 0,
    selectedTag: null,
    filtering: false,
    deleteArmedId: null,
    scopeFilter: "everywhere" as const,
    dossier: null
  };
}

async function factsAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: OverlayActionContext
): Promise<boolean> {
  const overlay = state.facts!;
  if (overlay.dossier !== null && overlay.dossier !== undefined) {
    return factsDossierAction(resolved, state, source, context);
  }
  const pathIds = state.payload.path.map(({ id }) => id);
  const scopeFilter = overlay.scopeFilter ?? "everywhere";
  Object.assign(
    overlay,
    boundedFactSelection(state.payload.facts, overlay, overlay.query, pathIds, scopeFilter)
  );
  const tags = factTags(state.payload.facts);
  const rows = factRows(state.payload.facts, overlay.selectedTag, overlay.query, pathIds, scopeFilter);
  const selectedIndex = resolved.action === "edit" && resolved.index !== undefined
    ? boundedFactCursor(resolved.index, rows.length)
    : overlay.cursor;
  const selected = rows[selectedIndex];
  if (overlay.deleteArmedId !== null
    && resolved.action !== "delete-item"
    && resolved.action !== "cancel") {
    overlay.deleteArmedId = null;
    state.toast = null;
  }
  if (resolved.action === "cancel") {
    if (overlay.deleteArmedId !== null) overlay.deleteArmedId = null;
    else if (overlay.filtering) overlay.filtering = false;
    else {
      const returnMode = overlay.returnMode === "FACT-CONSISTENCY"
        && state.factConsistency !== null
        && state.factConsistency !== undefined
        ? "FACT-CONSISTENCY"
        : "NAV";
      state.facts = null;
      state.mode = returnMode;
    }
  } else if (resolved.action === "focus-next") overlay.cursor = boundedFactCursor(overlay.cursor + 1, rows.length);
  else if (resolved.action === "focus-index") overlay.cursor = boundedFactCursor(resolved.index ?? overlay.cursor, rows.length);
  else if (resolved.action === "focus-previous") overlay.cursor = boundedFactCursor(overlay.cursor - 1, rows.length);
  else if (resolved.action === "filter") overlay.filtering = true;
  else if (resolved.action === "clear-filter") {
    overlay.query = "";
    overlay.selectedTag = null;
    overlay.filtering = false;
    overlay.chip = 0;
    overlay.selectedStateId = undefined;
    Object.assign(
      overlay,
      boundedFactSelection(state.payload.facts, overlay, "", pathIds, scopeFilter)
    );
  }
  else if (resolved.action === "cycle") {
    overlay.chip = resolved.index === undefined
      ? (overlay.chip + 1) % tags.length
      : Math.max(0, Math.min(tags.length - 1, resolved.index));
    overlay.selectedTag = tags[overlay.chip] ?? null;
    overlay.cursor = 0;
  }
  else if (resolved.action === "cycle-fact-scope") {
    const index = resolved.index === undefined
      ? (FACT_SCOPE_FILTERS.indexOf(scopeFilter) + 1) % FACT_SCOPE_FILTERS.length
      : Math.max(0, Math.min(FACT_SCOPE_FILTERS.length - 1, resolved.index));
    overlay.scopeFilter = FACT_SCOPE_FILTERS[index]!;
    overlay.cursor = 0;
    Object.assign(
      overlay,
      boundedFactSelection(state.payload.facts, overlay, overlay.query, pathIds, overlay.scopeFilter)
    );
  }
  else if ((resolved.action === "backspace" || resolved.action === "input") && overlay.filtering) {
    overlay.query = applyTextKey(overlay.query, resolved) ?? overlay.query;
    Object.assign(
      overlay,
      boundedFactSelection(
        state.payload.facts,
        overlay,
        overlay.query,
        pathIds,
        overlay.scopeFilter ?? "everywhere"
      )
    );
  }
  else if (resolved.action === "end-state") {
    overlay.pendingFactAction = {
      kind: "end",
      anchorPartId: factsOpeningPartId(state)
    };
    overlay.filtering = false;
    state.toast = "select a Fact · enter opens an end state";
  }
  else if (resolved.action === "new-state" && overlay.filtering) {
    overlay.pendingFactAction = {
      kind: "new-state",
      anchorPartId: factsOpeningPartId(state)
    };
    overlay.filtering = false;
    state.toast = "select a Fact · enter opens a new state";
  }
  else if ((resolved.action === "new-state"
    || resolved.action === "open-selected" && overlay.pendingFactAction !== null
      && overlay.pendingFactAction !== undefined)
    && !overlay.filtering && selected !== undefined) {
    const pending = overlay.pendingFactAction;
    if (pending?.kind === "edit") {
      if (isFactStateful(selected) && source.api.patchFactState === undefined) {
        state.toast = "state editing requires a newer backend";
        return true;
      }
      openFactEditor(state, selected);
    } else {
      if (source.api.createFactState === undefined) {
        state.toast = "state creation requires a newer backend";
        return true;
      }
      const anchorPartId = pending?.anchorPartId
        ?? factsOpeningPartId(state);
      if (anchorPartId === null) {
        state.toast = "select a story part before adding a state";
        return true;
      }
      openFactStateEditor(state, selected, anchorPartId);
      if (pending?.kind === "end" && state.editor?.kind === "fact") {
        state.editor.stateIsEnd = true;
        setComposerText(state.editor.composer, "");
      }
    }
    overlay.pendingFactAction = null;
  }
  else if (resolved.action === "open-selected" && overlay.filtering) overlay.filtering = false;
  else if (resolved.action === "open-selected" && !overlay.filtering && selected !== undefined) {
    const states = canonicalFactStates(selected);
    const selectedStateIndex = overlay.selectedStateId === undefined || overlay.selectedStateId === null
      ? 0
      : Math.max(0, states.findIndex(({ id }) => id === overlay.selectedStateId));
    const stateIndex = selectedStateIndex < 0 ? 0 : selectedStateIndex;
    const selectedState = states[stateIndex];
    if (isSingleUnscopedTextFact(selected)) {
      openFactEditor(state, selected, selectedState?.id === selected.id
        ? { stateId: selectedState.id }
        : {});
    } else {
      overlay.dossier = {
        factId: selected.id,
        stateIndex,
        diff: false
      };
    }
    overlay.selectedStateId = undefined;
  }
  else if (resolved.action === "delete-item" && selected !== undefined) {
    if (overlay.deleteArmedId !== selected.id) { overlay.deleteArmedId = selected.id; state.toast = "delete this fact? · x confirms · esc keeps"; }
    else {
      await context.backend.run("deleting fact", async (task) => {
        const payload = await source.api.deleteFact(task.storyId, selected.id);
        if (!task.storyCurrent()) return;
        adoptSameStoryPayload(state, payload, context.cache);
        if (state.facts === overlay) {
          if (overlay.deleteArmedId === selected.id) overlay.deleteArmedId = null;
          Object.assign(
            overlay,
            boundedFactSelection(
              payload.facts,
              overlay,
              overlay.query,
              payload.path.map(({ id }) => id),
              overlay.scopeFilter ?? "everywhere"
            )
          );
          state.toast = "fact deleted";
        }
      });
    }
  } else if ((resolved.action === "edit" && selected !== undefined) || resolved.action === "new-item") {
    if (resolved.action === "edit"
      && selected !== undefined
      && isFactStateful(selected)
      && source.api.patchFactState === undefined) {
      state.toast = "state editing requires a newer backend";
      return true;
    }
    if (resolved.action === "edit") overlay.cursor = selectedIndex;
    const selectedStateId = resolved.action === "edit"
      && selected !== undefined
      && overlay.selectedStateId !== undefined
      && selected.states.some(({ id }) => id === overlay.selectedStateId)
      ? overlay.selectedStateId
      : undefined;
    openFactEditor(
      state,
      resolved.action === "new-item" ? null : selected!,
      selectedStateId === undefined ? {} : { stateId: selectedStateId }
    );
    overlay.selectedStateId = undefined;
    if (state.facts === overlay) {
      Object.assign(
        overlay,
        boundedFactSelection(
          state.payload.facts,
          overlay,
          overlay.query,
          state.payload.path.map(({ id }) => id),
          overlay.scopeFilter ?? "everywhere"
        )
      );
    }
  } else if (
    (resolved.action === "move-item-up" || resolved.action === "move-item-down")
    && selected !== undefined
  ) {
    await moveFact(resolved, state, overlay, selected.id, source, context);
  }
  return true;
}

async function factsDossierAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: OverlayActionContext
): Promise<boolean> {
  const overlay = state.facts!;
  const dossier = overlay.dossier;
  if (dossier === null || dossier === undefined) return true;
  const fact = state.payload.facts.find(({ id }) => id === dossier.factId);
  if (fact === undefined) {
    overlay.dossier = null;
    return true;
  }
  const states = [...canonicalFactStates(fact)];
  if (states.length === 0) {
    overlay.dossier = null;
    return true;
  }
  const current = Math.max(0, Math.min(states.length - 1, dossier.stateIndex));
  if (resolved.action === "cancel") {
    overlay.dossier = null;
    overlay.selectedStateId = undefined;
  } else if (resolved.action === "focus-next") {
    dossier.stateIndex = Math.min(states.length - 1, current + 1);
  } else if (resolved.action === "focus-previous") {
    dossier.stateIndex = Math.max(0, current - 1);
  } else if (resolved.action === "focus-index") {
    dossier.stateIndex = Math.max(0, Math.min(states.length - 1, resolved.index ?? current));
  } else if (resolved.action === "cycle-state") {
    dossier.stateIndex = Math.max(
      0,
      Math.min(states.length - 1, current + (resolved.index === -1 ? -1 : 1))
    );
  } else if (resolved.action === "toggle-fact-diff") {
    dossier.diff = !dossier.diff;
  } else if (resolved.action === "open-selected") {
    const targetId = states[current]!.anchorPartId ?? state.payload.path[0]?.id ?? null;
    if (targetId === null || !state.payload.nodes.some(({ id }) => id === targetId)) {
      state.toast = "that Fact State Anchor is no longer in this story";
      return true;
    }
    if (state.payload.path.some(({ id }) => id === targetId)) {
      state.facts = null;
      landOnNode(state, source, targetId);
      return true;
    }
    // Ctrl-P can suspend the dossier while its switchLine request is in
    // flight. Keep that exact palette session visible after landing, with
    // Escape returning to the settled story instead of the stale dossier.
    let palette: RuntimeState["commands"] = null;
    await rerouteToNode(state, source, context, targetId, {
      owns: (currentState) => {
        if (palette !== null) {
          return currentState.mode === "COMMANDS" && currentState.commands === palette;
        }
        if (currentState.mode === "COMMANDS"
          && currentState.commands?.returnMode === "FACTS"
          && currentState.facts === overlay) {
          palette = currentState.commands;
          return true;
        }
        return currentState.mode === "FACTS"
          && currentState.facts === overlay
          && currentState.facts.dossier === dossier;
      },
      release: (currentState) => {
        if (currentState.facts === overlay) currentState.facts = null;
        if (palette !== null && currentState.commands === palette) {
          palette.returnMode = "NAV";
        }
      }
    });
    if (palette !== null && state.commands === palette) state.mode = "COMMANDS";
  } else if (resolved.action === "edit") {
    if (isFactStateful(fact) && source.api.patchFactState === undefined) {
      state.toast = "state editing requires a newer backend";
      return true;
    }
    openFactEditor(state, fact, { stateId: states[current]!.id });
  } else if (resolved.action === "new-state" || resolved.action === "end-state") {
    if (source.api.createFactState === undefined) {
      state.toast = "state creation requires a newer backend";
      return true;
    }
    const anchorPartId = factsOpeningPartId(state);
    if (anchorPartId === null) {
      state.toast = "select a story part before adding a state";
      return true;
    }
    openFactStateEditor(state, fact, anchorPartId);
    if (resolved.action === "end-state" && state.editor?.kind === "fact") {
      state.editor.stateIsEnd = true;
      setComposerText(state.editor.composer, "");
    }
  }
  return true;
}

/** Array order is emit order (see shared/story-facts.ts), so reordering only
 * makes sense against the real, unfiltered list — a tag chip or a live query
 * reshuffles `rows`, and "up" in that view would not mean "earlier" here. */
async function moveFact(
  resolved: ResolvedKey,
  state: RuntimeState,
  overlay: FactsOverlayState,
  factId: string,
  source: AppSource,
  context: OverlayActionContext
): Promise<void> {
  if (overlay.selectedTag !== null || overlay.query.length > 0) {
    state.toast = "clear the tag and filter to reorder facts";
    return;
  }
  const from = state.payload.facts.findIndex((fact) => fact.id === factId);
  if (from === -1) return;
  const toIndex = resolved.action === "move-item-up" ? from - 1 : from + 1;
  if (toIndex < 0 || toIndex >= state.payload.facts.length) return;
  await context.backend.run("reordering fact", async (task) => {
    const payload = await source.api.reorderFact(task.storyId, factId, toIndex);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload, context.cache);
    if (state.facts === overlay) {
      overlay.cursor = boundedFactCursor(toIndex, payload.facts.length);
    }
  });
}

async function commandsAction(resolved: ResolvedKey, state: RuntimeState, source: AppSource, context: OverlayActionContext): Promise<boolean> {
  const overlay = state.commands!;
  noteAsidePaletteInteraction(state);
  if (overlay.view === "tags") {
    if (resolved.action === "cancel") {
      if (overlay.deleteArmedTagNodeId != null) {
        overlay.deleteArmedTagNodeId = null;
        state.toast = "tag kept";
        return true;
      }
      overlay.view = "commands";
      Object.assign(overlay, retainCommandSelection(
        liveCommandMatches(
          state, overlay.query, undefined, context.asideEntryPointsOpen
        ), overlay.selectedId, overlay.cursor
      ));
      return true;
    }
    if (resolved.action !== "delete-item" && overlay.deleteArmedTagNodeId != null) {
      overlay.deleteArmedTagNodeId = null;
      state.toast = null;
    }
    if (resolved.action === "focus-next") overlay.cursor = Math.max(
      0,
      Math.min(state.payload.tags.length - 1, overlay.cursor + 1)
    );
    else if (resolved.action === "focus-index") {
      overlay.cursor = Math.max(
        0,
        Math.min(state.payload.tags.length - 1, resolved.index ?? overlay.cursor)
      );
    } else if (resolved.action === "focus-previous") {
      overlay.cursor = Math.max(0, overlay.cursor - 1);
    } else if (resolved.action === "delete-item") {
      const tag = state.payload.tags[overlay.cursor];
      if (tag === undefined) return true;
      if (overlay.deleteArmedTagNodeId !== tag.nodeId) {
        overlay.deleteArmedTagNodeId = tag.nodeId;
        state.toast = "delete this tag? · D confirms · esc keeps";
        return true;
      }
      await context.backend.run("deleting tag", async (task) => {
        const payload = await source.api.deleteBookmark(task.storyId, tag.nodeId);
        if (!task.storyCurrent()) return;
        adoptSameStoryPayload(state, payload, context.cache);
        if (state.commands === overlay && overlay.view === "tags") {
          overlay.deleteArmedTagNodeId = null;
          state.toast = "tag deleted";
        }
      });
    }
    return true;
  }
  let matches = liveCommandMatches(
    state, overlay.query, undefined, context.asideEntryPointsOpen
  );
  Object.assign(overlay, retainCommandSelection(matches, overlay.selectedId, overlay.cursor));
  if (resolved.action === "cancel") {
    state.commands = null;
    state.mode = overlay.returnMode;
  }
  else if (resolved.action === "focus-next") selectCommand(overlay, matches, overlay.cursor + 1);
  else if (resolved.action === "focus-index") selectCommand(overlay, matches, resolved.index ?? overlay.cursor);
  else if (resolved.action === "focus-previous") selectCommand(overlay, matches, overlay.cursor - 1);
  else if (resolved.action === "backspace" || resolved.action === "input") {
    overlay.query = applyTextKey(overlay.query, resolved) ?? overlay.query;
    matches = liveCommandMatches(
      state, overlay.query, undefined, context.asideEntryPointsOpen
    );
    selectCommand(overlay, matches, commandQueryCursor(matches, overlay.query));
  }
  else if (resolved.action === "open-selected") {
    const command = matches[overlay.cursor]?.command;
    if (command !== undefined) await runPaletteCommand(command, state, source, context, {
      factsAction,
      initialFacts,
      reconnect,
      rewriteRequestNotProjectedToast: REWRITE_REQUEST_NOT_PROJECTED_TOAST
    });
  }
  // Live theme preview: highlighting a theme command shows it immediately;
  // leaving the highlight (or the palette) reverts to the saved theme.
  if (state.commands !== null && state.commands.view === "commands") {
    const liveMatches = liveCommandMatches(
      state, state.commands.query, undefined, context.asideEntryPointsOpen
    );
    Object.assign(state.commands, retainCommandSelection(
      liveMatches, state.commands.selectedId, state.commands.cursor
    ));
    const highlighted = liveMatches[state.commands.cursor]?.command;
    context.previewTheme(highlighted?.id === "theme" ? highlighted.theme ?? null : null);
  } else {
    context.previewTheme(null);
  }
  return true;
}



function liveCommandMatches(
  state: RuntimeState,
  query: string,
  selection: ProjectedStorySelection | null = state.commands?.selection ?? null,
  asideOpen: boolean | undefined = undefined
): CommandMatch[] {
  return commandMatches(
    query,
    state.demo,
    commandContext(state.payload, {
      connectionDown: state.connection.down,
      requestActive: generationBusy(state) || state.summary !== null || state.chapterSummary != null,
      canRewriteSelection: canRewriteSelection(selection?.spans ?? []),
      asideEntryPointsOpen: asideOpen,
      hasStoryPart: factsOpeningPartId(state) !== null,
      hasFactConsistencyRun: state.payload.hasFactConsistencyRun === true
        || factConsistencyRunAvailable(state),
      hasStorySelection: selection !== null && selection.text.trim().length > 0,
      ...factEditorPaletteContext(state.editor?.kind === "fact" ? state.editor : null),
      ...factsPaletteContext(state)
    })
  );
}

function selectCommand(
  overlay: NonNullable<RuntimeState["commands"]>,
  matches: readonly CommandMatch[],
  cursor: number
): void {
  Object.assign(overlay, retainCommandSelection(matches, null, cursor));
}

async function reconnect(state: RuntimeState, source: AppSource, context: OverlayActionContext): Promise<void> {
  const connection = source.connection;
  if (connection === null) {
    state.connection = connectionSucceeded();
    state.toast = "reconnected · demo fixture";
    return;
  }
  await retryBackendState({
    state,
    source,
    backend: context.backend,
    cache: context.cache,
    repaint: context.repaint
  });
}

async function placementKeyAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: OverlayActionContext
): Promise<void> {
  if (state.placement === null) return;
  // Lock only while this Placement owns createNode — not reconnect/recovery.
  if (placementInputLocked(state)) return;
  if (resolved.action === "cancel") {
    cancelPlacement(state);
    return;
  }
  if (resolved.action === "focus-next") {
    movePlacementCursor(state, 1);
    return;
  }
  if (resolved.action === "focus-previous") {
    movePlacementCursor(state, -1);
    return;
  }
  if (resolved.action === "apply" || resolved.action === "open-selected") {
    await confirmPlacement(state, source, context);
  }
}

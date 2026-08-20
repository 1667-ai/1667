import {
  commandContext,
  commandMatches,
  retainCommandSelection,
  type CommandMatch,
  type PaletteCommand
} from "./command-model.js";
import { connectionFailed, connectionSucceeded } from "./connection.js";
import { createComposer } from "./composer-model.js";
import { writeExportFile, writeStoryExport } from "./export-file.js";
import { exportGenerationProfile } from "../../server/import-profile-export.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import { boundedFactCursor, boundedFactSelection, factRows, factTags } from "./facts-model.js";
import { applyTextKey, type ResolvedKey } from "./keys.js";
import {
  openAuthorBriefEditor,
  openAuthorsNoteEditor,
  openBannedStringsEditor,
  openFactEditor,
  openFactsBudgetEditor,
  openPhraseBiasEditor
} from "./editor-action.js";
import { generationBusy, openTag, runPartAction, streamLive } from "./story-actions.js";
import { openDirectComposer } from "./composer-ownership.js";
import { createUnusedTakesPrunePlan } from "./prune-model.js";
import { chaptersAction, createBreakAtFocus, openChapters } from "./chapter-actions.js";
import { createStoryViewModel, lastPartRowIndex } from "./model.js";
import { rememberFocus } from "./reading-position-persist.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { cancelSummary, startSummary } from "./summary-action.js";
import {
  asideBodyHeight,
  asideComposerRows,
  clearAsideSurface,
  closeAside,
  openAside,
  revealAsideFocusedNote,
  scrollAside,
  sendAsideQuestion,
  stopAsideAsk
} from "./aside-actions.js";
import {
  applyAsideUseMenu,
  cycleAsideFocus,
  focusAsideUseMenuIndex,
  moveAsideNoteFocus,
  moveAsideUseMenuCursor,
  openAsideUseMenu,
  closeAsideUseMenu
} from "./aside-use.js";
import {
  cancelPlacement,
  confirmPlacement,
  movePlacementCursor,
  placementInputLocked
} from "./aside-placement.js";
import { insertComposerText, setComposerText } from "./composer-model.js";
import { composerMotion } from "./composer-motion.js";
import { directComposerWrapWidth } from "./composer-geometry.js";
import { composerPageRows } from "./composer-viewport.js";
import { composerSurfaceAction } from "./composer-surface-action.js";
import { disarmAsideClear } from "./aside-surface.js";
import { openRewriteComposer, partIdFromTextSelection, resolveRewriteTarget } from "./rewrite-action.js";
import type { AppSource } from "./app.js";
import { canRewriteSelection, type ProjectedStorySelection } from "./selection-projection.js";
import { storySelectionFromRendererSelection } from "./copy-actions.js";
import { libraryAction, openLibrary } from "./library-actions.js";
import { openSearch } from "./search-actions.js";
import { cardImportAction, openCardImport } from "./card-import-actions.js";
import { archiveImportAction, openArchiveImport } from "./archive-import-actions.js";
import { imageAttachAction, openImageAttach } from "./image-attach-actions.js";
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
import type { FactsOverlayState, RuntimeState } from "./state.js";
import {
  INERT_ACTION_LIFECYCLE,
  type ActionContext,
  type ActionLifecycle
} from "./action-context.js";

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
  lifecycle: ActionLifecycle = INERT_ACTION_LIFECYCLE
): Promise<boolean> {
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
    state.facts = initialFacts();
    if (resolved.index !== undefined) {
      const cursor = Math.max(0, Math.min(state.payload.facts.length - 1, resolved.index));
      state.facts.cursor = cursor;
    }
    state.mode = "FACTS";
    return true;
  }
  if (resolved.action === "open-commands") {
    // The NAV projection this reads is only built for that one frame, so the
    // selection has to be captured now — a later keystroke cannot rebuild it.
    const selection = context.renderer === null
      ? null
      : storySelectionFromRendererSelection(context.renderer, state.storySelectionProjection);
    state.commands = {
      query: "",
      view: "commands",
      returnMode: state.mode === "COMPOSE" ? "COMPOSE" : "NAV",
      selection,
      ...retainCommandSelection(liveCommandMatches(
        state, "", selection, context.asideEntryPointsOpen
      ), null, 0)
    };
    state.mode = "COMMANDS";
    return true;
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
    const handled = await settingsOverlayAction(
      resolved,
      state,
      source,
      context,
      lifecycle
    );
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
  return { cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null };
}

async function factsAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: OverlayActionContext
): Promise<boolean> {
  const overlay = state.facts!;
  Object.assign(overlay, boundedFactSelection(state.payload.facts, overlay, overlay.query));
  const tags = factTags(state.payload.facts);
  const rows = factRows(state.payload.facts, overlay.selectedTag, overlay.query);
  const selectedIndex = resolved.action === "edit" && resolved.index !== undefined
    ? boundedFactCursor(resolved.index, rows.length)
    : overlay.cursor;
  const selected = rows[selectedIndex];
  if (resolved.action === "cancel") {
    if (overlay.deleteArmedId !== null) overlay.deleteArmedId = null;
    else if (overlay.filtering) overlay.filtering = false;
    else { state.facts = null; state.mode = "NAV"; }
  } else if (resolved.action === "focus-next") overlay.cursor = boundedFactCursor(overlay.cursor + 1, rows.length);
  else if (resolved.action === "focus-index") overlay.cursor = boundedFactCursor(resolved.index ?? overlay.cursor, rows.length);
  else if (resolved.action === "focus-previous") overlay.cursor = boundedFactCursor(overlay.cursor - 1, rows.length);
  else if (resolved.action === "filter") overlay.filtering = true;
  else if (resolved.action === "cycle") {
    overlay.chip = resolved.index === undefined
      ? (overlay.chip + 1) % tags.length
      : Math.max(0, Math.min(tags.length - 1, resolved.index));
    overlay.selectedTag = tags[overlay.chip] ?? null;
    overlay.cursor = 0;
  }
  else if ((resolved.action === "backspace" || resolved.action === "input") && overlay.filtering) {
    overlay.query = applyTextKey(overlay.query, resolved) ?? overlay.query;
    Object.assign(overlay, boundedFactSelection(state.payload.facts, overlay, overlay.query));
  }
  else if (resolved.action === "open-selected" && overlay.filtering) overlay.filtering = false;
  else if (resolved.action === "delete-item" && selected !== undefined) {
    if (overlay.deleteArmedId !== selected.id) { overlay.deleteArmedId = selected.id; state.toast = "delete this fact? · d confirms · esc keeps"; }
    else {
      await context.backend.run("deleting fact", async (task) => {
        const payload = await source.api.deleteFact(task.storyId, selected.id);
        if (!task.storyCurrent()) return;
        adoptSameStoryPayload(state, payload, context.cache);
        if (state.facts === overlay) {
          if (overlay.deleteArmedId === selected.id) overlay.deleteArmedId = null;
          Object.assign(overlay, boundedFactSelection(payload.facts, overlay, overlay.query));
          state.toast = "fact deleted";
        }
      });
    }
  } else if ((resolved.action === "edit" && selected !== undefined) || resolved.action === "new-item") {
    if (resolved.action === "edit") overlay.cursor = selectedIndex;
    openFactEditor(state, resolved.action === "new-item" ? null : selected!);
    if (state.facts === overlay) {
      Object.assign(overlay, boundedFactSelection(state.payload.facts, overlay, overlay.query));
    }
  } else if (
    (resolved.action === "move-item-up" || resolved.action === "move-item-down")
    && selected !== undefined
  ) {
    await moveFact(resolved, state, overlay, selected.id, source, context);
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
  if (overlay.view === "tags") {
    if (resolved.action === "cancel") {
      overlay.view = "commands";
      Object.assign(overlay, retainCommandSelection(
        liveCommandMatches(
          state, overlay.query, undefined, context.asideEntryPointsOpen
        ), overlay.selectedId, overlay.cursor
      ));
    }
    else if (resolved.action === "focus-next") overlay.cursor = Math.max(0,
      Math.min(state.payload.tags.length - 1, overlay.cursor + 1));
    else if (resolved.action === "focus-index") overlay.cursor = Math.max(0, Math.min(state.payload.tags.length - 1, resolved.index ?? overlay.cursor));
    else if (resolved.action === "focus-previous") overlay.cursor = Math.max(0, overlay.cursor - 1);
    else if (resolved.action === "delete-item") {
      const tag = state.payload.tags[overlay.cursor];
      if (tag !== undefined) {
        await context.backend.run("deleting tag", async (task) => {
          const payload = await source.api.deleteBookmark(task.storyId, tag.nodeId);
          if (!task.storyCurrent()) return;
          adoptSameStoryPayload(state, payload, context.cache);
          if (state.commands === overlay && overlay.view === "tags") {
            state.toast = "tag deleted";
          }
        });
      }
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
    selectCommand(overlay, matches, 0);
  }
  else if (resolved.action === "open-selected") {
    const command = matches[overlay.cursor]?.command;
    if (command !== undefined) await runCommand(command, state, source, context);
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

async function runCommand(command: PaletteCommand, state: RuntimeState, source: AppSource, context: OverlayActionContext): Promise<void> {
  // Both refusals belong here, ahead of the `state.mode = "NAV"` below: a
  // command that refuses after that commit strands whatever surface the
  // palette was opened from, the trap the next-request branch documents.
  if ((command.mutating === true && generationBusy(state))
    || (command.blockedByLiveStream === true && streamLive(state))) {
    state.toast = "stream running · esc stops it first";
    return;
  }
  if (command.id === "tags") { state.commands!.view = "tags"; state.commands!.cursor = 0; return; }
  const returnMode = state.commands!.returnMode;
  const selection = state.commands!.selection ?? null;
  state.commands = null;
  state.mode = "NAV";
  if (command.id === "next-request") {
    if (state.retakePrompt?.intent.kind === "rewrite") {
      // The unconditional `state.mode = "NAV"` above assumed every command
      // either runs or falls through to a toast in NAV; this one refuses
      // instead, so it has to put the writer back where the palette found
      // them — otherwise the rewrite composer is still open in `retakePrompt`
      // but no longer visible, stranded behind a NAV screen.
      state.mode = returnMode;
      state.toast = REWRITE_REQUEST_NOT_PROJECTED_TOAST;
    } else {
      openRequestViewer(state, returnMode);
    }
  }
  else if (command.id === "token-probabilities") await openTokenProbabilities(state, source, context);
  else if (command.id === "generation-records") await openGenerationRecordViewer(state, source, context);
  else if (command.id === "tag-line") openTag(state);
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
  else if (command.id === "retake") await runPartAction("retake", state, source, context);
  else if (command.id === "rewrite-selection") {
    // The palette's own filtering already requires a captured selection, but
    // that only means one existed at open time — re-resolve it against the
    // live story exactly as the part-actions menu does.
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
        const archive = exportGenerationProfile(document, profileId);
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
    else state.prune = plan;
  } else if (command.id === "prompts") { state.showInstructions = !state.showInstructions; state.toast = `directions ${state.showInstructions ? "shown" : "hidden"}`; }
  else if (command.id === "settings") await openSettingsOverlay(state, source, context);
  else if (command.id === "theme" && command.theme !== undefined) {
    context.applyTheme(command.theme);
    state.toast = `theme · ${command.theme}`;
  }
  else if (command.id === "reconnect") await reconnect(state, source, context);
  else if (command.id === "folder") state.toast = source.storyFolder;
  else if (command.id === "import-card") openCardImport(state, returnMode);
  else if (command.id === "import-archive") openArchiveImport(state, returnMode);
  else if (command.id === "attach-image") openImageAttach(state, source, returnMode);
  else if (command.id === "disconnect" && state.demo) {
    state.connection = connectionFailed(connectionSucceeded(), new Error("demo disconnect"), state.now);
    state.toast = "simulated connection loss";
  }
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
      asideEntryPointsOpen: asideOpen
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

function asideViewportBodyRows(
  surface: NonNullable<RuntimeState["aside"]>,
  context: OverlayActionContext
): { width: number; bodyRows: number } {
  const width = context.renderer?.width ?? 80;
  const height = context.renderer?.height ?? 24;
  const composerRows = asideComposerRows(height);
  return {
    width,
    bodyRows: asideBodyHeight(surface, width, height, composerRows)
  };
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

async function asideKeyAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: OverlayActionContext
): Promise<void> {
  const surface = state.aside;
  if (surface === null) return;
  if (resolved.action === "cancel") {
    if (surface.useMenu !== null) {
      closeAsideUseMenu(surface);
      surface.focus = "notes";
      return;
    }
    if (surface.focus === "notes") {
      surface.focus = "composer";
      return;
    }
    if (surface.confirmClear) {
      surface.confirmClear = false;
      return;
    }
    // Esc stops the request. It keeps received answer text as a Side Note, or
    // restores the question if no answer text arrived.
    // Esc when idle returns to Write.
    if (surface.busy) {
      // Clear has no abort path. Its missing in-flight question is the
      // existing distinction from an Ask, so Esc remains a no-op while it
      // commits instead of pretending to stop anything.
      if (surface.inflightQuestion !== null) stopAsideAsk(state);
      return;
    }
    closeAside(state);
    return;
  }
  if (surface.useMenu !== null) {
    if (resolved.action === "focus-next") {
      moveAsideUseMenuCursor(surface, 1);
      return;
    }
    if (resolved.action === "focus-previous") {
      moveAsideUseMenuCursor(surface, -1);
      return;
    }
    if (resolved.action === "focus-index") {
      focusAsideUseMenuIndex(surface, resolved.index ?? surface.useMenu.cursor);
      return;
    }
    if (resolved.action === "apply" || resolved.action === "open-selected") {
      applyAsideUseMenu(state);
      return;
    }
    // Use menu owns the surface: scrim/cancel stay authoritative; compose does
    // not steal focus from under the modal.
    return;
  }

  if (resolved.action === "cycle") {
    if (cycleAsideFocus(surface) && surface.focus === "notes") {
      const { width, bodyRows } = asideViewportBodyRows(surface, context);
      revealAsideFocusedNote(surface, width, bodyRows);
    }
    return;
  }
  if (resolved.action === "scroll-line-down" || resolved.action === "scroll-line-up"
    || resolved.action === "scroll-down" || resolved.action === "scroll-up") {
    const width = context.renderer?.width ?? 80;
    const height = context.renderer?.height ?? 24;
    const composerRows = asideComposerRows(height);
    const page = asideBodyHeight(surface, width, height, composerRows);
    const delta = resolved.action === "scroll-line-down" || resolved.action === "scroll-down"
      ? resolved.action === "scroll-down" ? page : 1
      : resolved.action === "scroll-up" ? -page : -1;
    scrollAside(surface, delta, width, height, composerRows);
    return;
  }
  if (surface.focus === "notes") {
    // Left-click on the visible prompt claims composer focus so paste/text
    // target it. Use menu already returned above.
    if (resolved.action === "compose") {
      surface.focus = "composer";
      return;
    }
    if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
      moveAsideNoteFocus(surface, resolved.action === "focus-next" ? 1 : -1);
      const { width, bodyRows } = asideViewportBodyRows(surface, context);
      revealAsideFocusedNote(surface, width, bodyRows);
      return;
    }
    if (resolved.action === "open-selected" || resolved.action === "apply") {
      // Re-anchor under the current terminal size: a stale scrollTop from a
      // prior width/header layout can hide noteCursor while Enter still uses it.
      const { width, bodyRows } = asideViewportBodyRows(surface, context);
      revealAsideFocusedNote(surface, width, bodyRows);
      openAsideUseMenu(surface, surface.noteCursor);
      return;
    }
    return;
  }
  const width = context.renderer?.width ?? 80;
  const height = context.renderer?.height ?? 24;
  const motion = composerMotion(true, () => directComposerWrapWidth(width, state.config, true));
  if (resolved.action === "cursor-up" || resolved.action === "cursor-down") {
    motion.vertical(
      surface.composer,
      resolved.action === "cursor-up" ? -1 : 1,
      resolved.extendSelection
    );
    return;
  }
  if (resolved.action === "send") {
    if (surface.busy) return;
    if (surface.confirmClear) {
      context.backend.observe(context.backend.run("clearing Aside", (task) =>
        clearAsideSurface(state, source.api, context.cache, { task })
      ));
      return;
    }
    const text = surface.composer.text;
    if (text.trim() === "/clear") {
      setComposerText(surface.composer, "");
      surface.confirmClear = true;
      return;
    }
    context.backend.observe(context.backend.run("asking Aside", (task) =>
      sendAsideQuestion(state, source.api, text, {
        task,
        repaint: context.repaint,
        cache: context.cache
      })
    ));
    return;
  }
  if (resolved.action === "newline") {
    disarmAsideClear(surface);
    insertComposerText(surface.composer, "\n");
    return;
  }
  if (resolved.action === "input" && resolved.text !== undefined) {
    disarmAsideClear(surface);
    insertComposerText(surface.composer, resolved.text);
    return;
  }
  if (await composerSurfaceAction(resolved, state, surface.composer, {
    isCurrent: () => state.mode === "ASIDE" && state.aside === surface,
    pageRows: composerPageRows(height, true),
    motion,
    onEdit: (kind) => {
      if (kind !== "move") disarmAsideClear(surface);
    }
  })) return;
  // Keep the fallback for plain text actions that do not belong to the shared
  // composer reducer. All structural edits above preserve cursor state.
  const next = applyTextKey(surface.composer.text, resolved);
  if (next !== null) {
    disarmAsideClear(surface);
    setComposerText(surface.composer, next);
  }
}

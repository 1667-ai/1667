import { formatTokensEstimate } from "./rail.js";
import { applyTextKey, type ResolvedKey } from "./keys.js";
import { chapterListModel, chapterWord } from "./chapter-model.js";
import {
  chapterForRow,
  createStoryViewModel,
  rowIndexForNode,
  rowPart,
  type ChapterDividerRow,
  type ChapterSummaryRow,
  type StoryChapter
} from "./model.js";
import { openChapterSummaryEditor } from "./editor-action.js";
import type { AppSource } from "./app.js";
import type { RuntimeState } from "./state.js";
import { nextRequestContext } from "./request-context.js";
import { nextRequestEstimate } from "./request-projection.js";
import type { ActionContext, BackendActionContext } from "./action-context.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { followStoryViewport } from "./viewport-intent.js";

type ChapterActionContext = Pick<ActionContext, "backend" | "cache" | "renderer">;

export function openChapters(state: RuntimeState, chapterNumber?: number): void {
  const view = createStoryViewModel(state.payload, state.stream);
  const current = chapterNumber ?? chapterForRow(view, state.focusIndex)?.number ?? view.chapters.at(-1)?.number ?? 1;
  state.chapters = {
    cursor: Math.max(0, view.chapters.findIndex((chapter) => chapter.number === current)),
    rename: null,
    deleteArmedId: null
  };
  state.mode = "CHAPTERS";
  state.chapterDeleteArmedId = null;
}

export async function chaptersAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ChapterActionContext
): Promise<void> {
  const overlay = state.chapters;
  if (overlay === null) return;
  const estimate = nextRequestEstimate(state.payload, nextRequestContext(state));
  const model = chapterListModel(state.payload, state.contextWindow, estimate);
  const selected = model.rows[Math.max(0, Math.min(model.rows.length - 1, overlay.cursor))]?.chapter ?? null;
  if (resolved.action === "cancel") {
    if (overlay.rename !== null) overlay.rename = null;
    else if (overlay.deleteArmedId !== null) overlay.deleteArmedId = null;
    else { state.chapters = null; state.mode = "NAV"; }
    return;
  }
  if (overlay.rename !== null) {
    if (resolved.action === "open-selected") {
      const rename = overlay.rename;
      const submittedTitle = rename.value.trim();
      await context.backend.run("renaming chapter", async (task) => {
        const payload = await source.api.renameChapterBreak(task.storyId, rename.breakId, submittedTitle);
        if (!task.storyCurrent()) return;
        adoptSameStoryPayload(state, payload);
        if (state.chapters === overlay && overlay.rename === rename && rename.value.trim() === submittedTitle) {
          overlay.rename = null;
          state.toast = "chapter title saved";
        }
        context.cache.invalidate();
      });
    } else {
      const value = applyTextKey(overlay.rename.value, resolved);
      if (value !== null) overlay.rename.value = value;
    }
    return;
  }
  if (resolved.action === "focus-next") overlay.cursor = Math.min(model.rows.length - 1, overlay.cursor + 1);
  else if (resolved.action === "focus-previous") overlay.cursor = Math.max(0, overlay.cursor - 1);
  else if (resolved.action === "focus-index") overlay.cursor = Math.max(0, Math.min(model.rows.length - 1, resolved.index ?? overlay.cursor));
  else if (resolved.action === "open-selected" && selected !== null) jumpToChapter(state, selected);
  else if (resolved.action === "summarize-chapter" && selected?.closedBy !== null && selected !== null) {
    await summarizeChapter(state, source, selected, context);
  } else if (resolved.action === "rename-item" && selected !== null) {
    beginRename(state, selected);
  } else if (resolved.action === "delete-item" && selected !== null) {
    const breakId = selected.openingBreakId;
    if (breakId === null) state.toast = "Chapter One has no opening break to remove";
    else if (overlay.deleteArmedId !== breakId) {
      overlay.deleteArmedId = breakId;
      state.toast = "remove this break? · d confirms · esc keeps";
    } else {
      await removeBreak(state, source, breakId, context);
    }
  } else if (resolved.action === "new-item") {
    await createBreakAtFocus(state, source, context);
  }
}

export async function createBreakAtFocus(
  state: RuntimeState,
  source: AppSource,
  context: BackendActionContext
): Promise<void> {
  const view = createStoryViewModel(state.payload, state.stream);
  const part = rowPart(view, state.focusIndex);
  if (part === null) return void (state.toast = "focus a prose part before ending a chapter");
  if (state.payload.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === part.id)) {
    return void (state.toast = `Chapter ${chapterWord(part.chapterNumber)} already ends here`);
  }
  const fromLeaf = part.pathIndex === state.payload.path.length - 1;
  await context.backend.run("creating chapter break", async (task) => {
    const { payload, breakId } = await source.api.createChapterBreak(task.storyId, part.id);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload);
    state.undo.push({ kind: "create-break", breakId });
    if (task.interactionCurrent()) {
      state.focusIndex = Math.max(0, rowIndexForNode(createStoryViewModel(payload), part.id));
      followStoryViewport(state);
      state.chapterDeleteArmedId = null;
      state.toast = fromLeaf
        ? `Chapter ${chapterWord(part.chapterNumber)} ends here · next part opens Chapter ${chapterWord(part.chapterNumber + 1)} · u undoes`
        : "chapter break added · chapters renumbered · u undoes";
    }
    context.cache.invalidate();
  });
}

export async function directChapterRowAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ChapterActionContext
): Promise<boolean> {
  const view = createStoryViewModel(state.payload, state.stream);
  const row = view.rows[state.focusIndex];
  if (row?.kind === "chapter-summary") return await summaryRowAction(resolved, row, state, source, context);
  if (row?.kind === "chapter-divider") return await dividerRowAction(resolved, row, state, source, context);
  return false;
}

async function summaryRowAction(
  resolved: ResolvedKey,
  row: ChapterSummaryRow,
  state: RuntimeState,
  source: AppSource,
  context: ChapterActionContext
): Promise<boolean> {
  if (resolved.action === "compose") {
    if (state.expandedChapterSummaryIds.has(row.summary.id)) state.expandedChapterSummaryIds.delete(row.summary.id);
    else state.expandedChapterSummaryIds.add(row.summary.id);
    return true;
  }
  if (resolved.action === "regenerate") {
    await summarizeChapter(state, source, row.chapter, context);
    return true;
  }
  if (resolved.action === "edit") {
    editSummary(state, row);
    return true;
  }
  if (["write", "prune", "tag", "take-next", "take-previous", "open-actions"].includes(resolved.action)) return true;
  return false;
}

async function dividerRowAction(
  resolved: ResolvedKey,
  row: ChapterDividerRow,
  state: RuntimeState,
  source: AppSource,
  context: ChapterActionContext
): Promise<boolean> {
  if (resolved.action === "edit") {
    openChapters(state, row.openingChapter.number);
    beginRename(state, row.openingChapter);
    return true;
  }
  if (resolved.action === "regenerate") {
    await summarizeChapter(state, source, row.closingChapter, context);
    return true;
  }
  if (resolved.action === "prune") {
    if (state.chapterDeleteArmedId !== row.break.id) {
      state.chapterDeleteArmedId = row.break.id;
      state.toast = "remove this chapter break? · d confirms · esc keeps";
    } else {
      await removeBreak(state, source, row.break.id, context);
    }
    return true;
  }
  if (resolved.action === "cancel" && state.chapterDeleteArmedId !== null) {
    state.chapterDeleteArmedId = null;
    state.toast = "chapter break kept";
    return true;
  }
  if (["compose", "write", "tag", "take-next", "take-previous", "open-actions"].includes(resolved.action)) return true;
  return false;
}

export function jumpAdjacentChapter(state: RuntimeState, direction: -1 | 1): void {
  const view = createStoryViewModel(state.payload, state.stream);
  const current = chapterForRow(view, state.focusIndex)?.number ?? 1;
  const target = Math.max(1, Math.min(view.chapters.length, current + direction));
  const chapter = view.chapters.find((candidate) => candidate.number === target);
  if (chapter !== undefined) jumpToChapter(state, chapter);
}

function jumpToChapter(state: RuntimeState, chapter: StoryChapter): void {
  const view = createStoryViewModel(state.payload, state.stream);
  const target = chapter.openingBreakId === null
    ? view.rows.findIndex((row) => row.kind === "part" && row.chapterNumber === chapter.number)
    : view.rows.findIndex((row) => row.kind === "chapter-divider" && row.break.id === chapter.openingBreakId);
  if (target >= 0) state.focusIndex = target;
  followStoryViewport(state);
  state.chapters = null;
  state.mode = "NAV";
}

function beginRename(state: RuntimeState, chapter: StoryChapter): void {
  const breakId = chapter.openingBreakId;
  if (breakId === null) return void (state.toast = "Chapter One uses the story title");
  const chapterBreak = state.payload.chapterBreaks.find((candidate) => candidate.id === breakId);
  if (chapterBreak === undefined || state.chapters === null) return;
  state.chapters.rename = { breakId, value: chapterBreak.title };
  state.chapters.deleteArmedId = null;
}

async function removeBreak(
  state: RuntimeState,
  source: AppSource,
  breakId: string,
  context: BackendActionContext
): Promise<void> {
  await context.backend.run("removing chapter break", async (task) => {
    const result = await source.api.removeChapterBreak(task.storyId, breakId);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, result.payload);
    state.undo.push({ kind: "remove-break", breakId, removed: result.removed });
    if (state.chapterDeleteArmedId === breakId) state.chapterDeleteArmedId = null;
    if (state.chapters?.deleteArmedId === breakId) state.chapters.deleteArmedId = null;
    if (task.interactionCurrent()) {
      state.focusIndex = Math.min(state.focusIndex, Math.max(0, createStoryViewModel(result.payload).rows.length - 1));
      followStoryViewport(state);
      if (state.chapters !== null) {
        const estimate = nextRequestEstimate(result.payload, nextRequestContext(state));
        state.chapters.cursor = Math.min(
          state.chapters.cursor,
          Math.max(0, chapterListModel(result.payload, state.contextWindow, estimate).rows.length - 1)
        );
      }
      state.toast = "chapter break removed · summary removed · chapters renumbered · u undoes";
    }
    context.cache.invalidate();
  });
}

async function summarizeChapter(
  state: RuntimeState,
  source: AppSource,
  chapter: StoryChapter,
  context: BackendActionContext
): Promise<void> {
  const breakId = chapter.closedBy?.id;
  if (breakId === undefined) return void (state.toast = "current chapter stays raw until it ends");
  const refreshed = chapter.summary !== null;
  await context.backend.run("summarizing chapter", async (task) => {
    const payload = await source.api.summarizeChapter(task.storyId, breakId);
    if (!task.storyCurrent()) return;
    adoptSameStoryPayload(state, payload);
    if (task.interactionCurrent()) {
      const view = createStoryViewModel(payload);
      const summaryIndex = view.rows.findIndex((row) => row.kind === "chapter-summary" && row.chapter.closedBy?.id === breakId);
      if (summaryIndex >= 0) state.focusIndex = summaryIndex;
      state.toast = refreshed
        ? `Chapter ${chapterWord(chapter.number)} summary refreshed`
        : `Chapter ${chapterWord(chapter.number)} summarized · ${formatTokensEstimate(chapter.rawTokens)} raw · prose untouched`;
    }
    context.cache.invalidate();
  });
}

function editSummary(
  state: RuntimeState,
  row: ChapterSummaryRow
): void {
  openChapterSummaryEditor(
    state,
    row.summary.id,
    row.summary.text ?? "",
    row.chapter.number
  );
}

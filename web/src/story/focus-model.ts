import { chapterForRow, rowIndexForNode, type ManuscriptModel } from "../../../shared/manuscript-model.js";

/**
 * The manuscript's pure focus-move arithmetic, factored out of
 * `story/actions.ts`'s action closures. Web-local rather than
 * `shared/manuscript-model.ts`: the TUI moves a *row* index over
 * `view.rows` (chapter dividers and summaries included), while the web
 * moves a *part id* over `model.parts` only (chapter chrome is never a
 * focus target here) — different enough representations that sharing one
 * implementation would not actually save the TUI anything.
 */

export function nextPartId(model: ManuscriptModel, currentId: string | null, direction: -1 | 1): string | null {
  const currentIndex = currentId === null ? -1 : model.parts.findIndex((part) => part.id === currentId);
  const nextIndex = Math.max(0, Math.min(model.parts.length - 1, currentIndex + direction));
  return model.parts[nextIndex]?.id ?? null;
}

export function firstPartId(model: ManuscriptModel): string | null {
  return model.parts[0]?.id ?? null;
}

export function lastPartId(model: ManuscriptModel): string | null {
  return model.parts.at(-1)?.id ?? null;
}

export function chapterJumpPartId(model: ManuscriptModel, currentId: string | null, direction: -1 | 1): string | null {
  const currentRow = currentId === null ? -1 : rowIndexForNode(model, currentId);
  const currentChapter = chapterForRow(model, currentRow)?.number ?? 1;
  const targetNumber = Math.max(1, Math.min(model.chapters.length, currentChapter + direction));
  const chapter = model.chapters.find((candidate) => candidate.number === targetNumber);
  return chapter?.parts[0]?.id ?? null;
}

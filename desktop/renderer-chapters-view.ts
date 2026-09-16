/** Chapters destination (⌘4, 2b): the story line drawn as a ruler, plus a
 * table of chapters (DESIGN_SPEC.md §3; phase spec §4). New file — the old
 * card list used to live in `renderer-view.ts`.
 *
 * The client has no "move break" call (only create, remove, restore), so
 * the ruler's break marks are not draggable in this pass. Clicking a
 * part-cell focuses that part on Write, which is the one interaction the
 * existing API supports. */
import { rememberedLeafId } from "../shared/story-model.js";
import type { ChapterPartLike, DerivedChapter } from "../shared/chapters.js";
import type { ChapterBreak, StoryPayload } from "../shared/types.js";
import { actionButton, el } from "./renderer-dom.js";
import { button } from "./renderer-controls.js";
import {
  activeLeaf,
  effectiveFocusedPartId,
  storyChapters,
  type RendererActions,
  type RendererState
} from "./renderer-model.js";

type Chapter = DerivedChapter<ChapterPartLike>;

export function renderChapters(story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement {
  const panel = el("div", "panel chapters-panel");
  const chapters = storyChapters(story);
  const focusedId = effectiveFocusedPartId(state, story);
  const focusedIndex = focusedId === null ? -1 : story.path.findIndex((node) => node.id === focusedId);
  const leafId = activeLeaf(story)?.id;

  panel.append(renderChaptersHeader(story, state, actions, focusedId, focusedIndex));
  panel.append(renderRuler(chapters, story, focusedIndex, actions));

  const list = el("div", "chapter-list");
  chapters.forEach((chapter, index) => {
    const openingBreak = index === 0 ? null : chapters[index - 1]?.closedBy ?? null;
    const renameTarget: ChapterBreak = {
      id: openingBreak?.id ?? "",
      parentPartId: openingBreak?.parentPartId ?? "",
      title: chapter.title || (index === 0 ? "Opening chapter" : "Untitled chapter"),
      createdAt: openingBreak?.createdAt ?? story.createdAt
    };
    list.append(renderChapterRow(chapter, index, renameTarget, story, state, leafId, actions));
  });
  panel.append(list);
  return panel;
}

function renderChaptersHeader(
  story: StoryPayload,
  state: RendererState,
  actions: RendererActions,
  focusedId: string | null,
  focusedIndex: number
): HTMLElement {
  const leaf = story.path.at(-1);
  const lineTag = leaf === undefined ? undefined : story.tags.find((tag) => tag.nodeId === rememberedLeafId(story, leaf.id));
  const copy = el("div", "panel-heading-copy",
    el("span", "eyebrow", `Chapters · line ${lineTag?.name ?? "current"}`),
    el("p", "", "Breaks belong to the line. A summary stands in for the parts above it in every later request.")
  );
  const controls: HTMLElement[] = [];
  if (state.chapterUndo !== null && state.chapterUndo.kind === "removed") {
    const restore = button("secondary", `Restore removed · "${state.chapterUndo.removed.break.title}"`, undefined, () => actions.restoreChapter());
    restore.classList.add("restore-chapter");
    controls.push(restore);
  }
  const breakButton = button(
    "primary",
    `+ Break at ¶ ${focusedIndex + 1}`,
    undefined,
    () => actions.createChapter(focusedId ?? undefined),
    focusedId === null ? "Focus a part first" : undefined
  );
  breakButton.classList.add("new-chapter");
  breakButton.disabled = focusedId === null;
  controls.push(breakButton);
  return el("div", "panel-heading", copy, el("div", "panel-heading-actions", ...controls));
}

function wordsOf(node: { readonly text?: string }): number {
  return (node.text ?? "").split(/\s+/u).filter(Boolean).length;
}

function chapterRange(chapter: Chapter, story: StoryPayload): { readonly fromIndex: number; readonly toIndex: number } {
  if (chapter.extent === null) return { fromIndex: -1, toIndex: -1 };
  return {
    fromIndex: story.path.findIndex((node) => node.id === chapter.extent!.fromPartId),
    toIndex: story.path.findIndex((node) => node.id === chapter.extent!.toPartId)
  };
}

function chapterWords(chapter: Chapter, story: StoryPayload): number {
  const { fromIndex, toIndex } = chapterRange(chapter, story);
  if (fromIndex === -1 || toIndex === -1) return 0;
  let total = 0;
  for (let index = fromIndex; index <= toIndex; index += 1) total += wordsOf(story.path[index]!);
  return total;
}

/** D-26 ruler: the line to scale (each part-cell's width ∝ its words), a
 * `--graphite` tick between chapters, `▲` under the focused part, and a
 * darker fill for chapters with a fresh summary. Divs, not SVG — the app
 * has no other SVG surface yet.
 *
 * Every part-cell is a direct flex child of the track (not nested one level
 * per chapter): a flex item's `flex-grow` only competes for space among its
 * own siblings, so a per-chapter wrapper div would need its own `flex-grow`
 * (the chapter's word total) before its own children's shares meant
 * anything — one flat row is simpler and gives every ¶ a width proportional
 * to its own words. */
function renderRuler(chapters: readonly Chapter[], story: StoryPayload, focusedIndex: number, actions: RendererActions): HTMLElement {
  const ruler = el("div", "chapter-ruler");
  const track = el("div", "chapter-ruler-track");
  const marks = el("div", "chapter-ruler-marks");
  let cellCount = 0;
  chapters.forEach((chapter, chapterIndex) => {
    const summarized = chapter.summary !== null && !chapter.stale;
    const { fromIndex, toIndex } = chapterRange(chapter, story);
    if (fromIndex !== -1 && toIndex !== -1) {
      for (let index = fromIndex; index <= toIndex; index += 1) {
        const part = story.path[index]!;
        const focused = index === focusedIndex;
        const isChapterEnd = index === toIndex && chapterIndex < chapters.length - 1;
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = `chapter-ruler-part${focused ? " focused" : ""}${summarized ? " summarized" : ""}${isChapterEnd ? " chapter-end" : ""}`;
        cell.style.flexGrow = String(Math.max(1, wordsOf(part)));
        cell.title = `¶ ${index + 1}`;
        cell.setAttribute("aria-label", `Focus ¶ ${index + 1} on Write`);
        cell.addEventListener("click", () => {
          actions.focusPart(part.id);
          actions.setTab("write");
        });
        if (focused) cell.append(el("span", "chapter-ruler-caret", "▲"));
        track.append(cell);
        cellCount += 1;
      }
    }
    const title = chapter.title.trim() || (chapterIndex === 0 ? "Opening chapter" : "Untitled chapter");
    const mark = el("span", "chapter-ruler-mark", `${chapter.number} · ${title}`);
    // Size each label like the cells above it, so a label starts where its chapter starts.
    let chapterWords = 0;
    if (fromIndex !== -1 && toIndex !== -1) {
      for (let index = fromIndex; index <= toIndex; index += 1) chapterWords += Math.max(1, wordsOf(story.path[index]!));
    }
    mark.style.flexGrow = String(Math.max(1, chapterWords));
    mark.title = title;
    marks.append(mark);
  });
  if (cellCount === 0) track.append(el("p", "empty-copy chapter-ruler-empty", "No parts yet."));
  ruler.append(track, marks);
  const totalParts = story.path.length;
  ruler.append(el("div", "chapter-ruler-scale",
    el("span", "", totalParts === 0 ? "¶ —" : "¶ 1"),
    el("span", "", totalParts <= 1 ? "" : `¶ ${totalParts}`)
  ));
  return ruler;
}

function renderChapterRow(
  chapter: Chapter,
  index: number,
  renameTarget: ChapterBreak,
  story: StoryPayload,
  state: RendererState,
  leafId: string | undefined,
  actions: RendererActions
): HTMLElement {
  const item = el("article", "chapter-card");
  item.dataset.preserve = `chapter:${renameTarget.id || "opening"}`;
  const { fromIndex, toIndex } = chapterRange(chapter, story);
  const words = chapterWords(chapter, story);
  const hereNow = fromIndex !== -1 && toIndex !== -1 && leafId !== undefined
    && story.path.slice(fromIndex, toIndex + 1).some((node) => node.id === leafId);

  const metaParts = [
    fromIndex === -1 ? "no parts yet" : `¶ ${fromIndex + 1}–${toIndex + 1}`,
    `${words.toLocaleString()} word${words === 1 ? "" : "s"}`
  ];
  if (chapter.closedBy !== null) {
    const breakIndex = story.path.findIndex((node) => node.id === chapter.closedBy!.parentPartId);
    if (breakIndex !== -1) metaParts.push(`break after ¶ ${breakIndex + 1}`);
  }
  if (hereNow) metaParts.push("● you are here");

  const title = chapter.title.trim() || (index === 0 ? "Opening chapter" : "Untitled chapter");
  const badge = chapter.summary === null
    ? el("span", "badge", "no summary · sent in full")
    : el("span", "badge", `§ ${wordsOf(chapter.summary).toLocaleString()} words${chapter.stale ? " · stale" : ""}`);
  const copy = el("div", "chapter-card-copy",
    el("div", "chapter-card-title-row", el("h3", "", title), badge),
    el("p", "chapter-card-meta", metaParts.join(" · "))
  );
  if (chapter.summary !== null) {
    copy.append(el("p", "chapter-summary-preview", (chapter.summary.text ?? "").slice(0, 180) || "Empty summary"));
  }
  item.append(el("span", "chapter-index", String(chapter.number).padStart(2, "0")), copy);

  const streaming = state.stream !== null && hereNow;
  const controls = el("div", "chapter-controls");
  const rename = button("quiet", "Rename", undefined, () => actions.renameChapter(renameTarget));
  rename.classList.add("chapter-rename");
  controls.append(rename);
  if (chapter.closedBy !== null) {
    const closedBy = chapter.closedBy;
    const summarize = button(
      "quiet",
      chapter.summary === null ? "Summarize" : "Resummarize",
      undefined,
      () => actions.summarizeChapter({ ...renameTarget, id: closedBy.id }),
      streaming ? "A part in this chapter is streaming" : undefined
    );
    summarize.classList.add("chapter-summarize");
    controls.append(summarize);
  }
  if (chapter.summary !== null) {
    const summaryNode = chapter.summary;
    const editSummary = actionButton("chapter-summary-edit", "Edit summary", () =>
      actions.editChapterSummary(renameTarget, { id: summaryNode.id, text: summaryNode.text ?? "" }));
    controls.append(editSummary);
  }
  if (index !== 0) {
    const remove = button("destructive", "Remove", undefined, () => actions.removeChapter(renameTarget));
    remove.classList.add("chapter-remove");
    controls.append(remove);
  }
  item.append(controls);
  return item;
}

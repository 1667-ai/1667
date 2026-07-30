import { createStoryIndex } from "../../../shared/story-model.js";
import type { SearchHit } from "../../../shared/story-search.js";
import {
  previewSearchHit,
  type SearchHitRow,
  type SearchRowModel,
  type SearchState
} from "../search-model.js";
import type { StoryScreenState } from "../state.js";
import { tagGlyph } from "../tag-presentation.js";
import { wrapText } from "../wrap.js";
import {
  fitLine,
  lineWidth,
  segment,
  truncate,
  type FrameLine
} from "./story/frame.js";
import { DIVIDER_COLUMN, PREVIEW_COLUMN } from "./search-row.js";

/** The right pane: where the focused hit lives, then its prose. */
export function renderPreview(
  state: StoryScreenState,
  search: SearchState,
  model: SearchRowModel,
  width: number
): FrameLine[] {
  const row = previewSearchHit(model, search.cursor, state.payload);
  if (row === null || width < 12) return [];
  const hit = row.hit;
  const rule = "─".repeat(Math.min(50, width));
  const body = wrapText(hit.context, [], width).map((line) => {
    const start = line.start;
    const end = start + line.text.length;
    const matchStart = hit.contextMatch;
    const matchEnd = hit.contextMatch + hit.matchLength;
    if (matchEnd <= start || matchStart >= end) {
      return [segment(line.text, "dimmed page")];
    }
    const from = Math.max(0, matchStart - start);
    const to = Math.min(line.text.length, matchEnd - start);
    return [
      segment(line.text.slice(0, from), "dimmed page"),
      segment(line.text.slice(from, to), "prose"),
      segment(line.text.slice(to), "dimmed page")
    ];
  });
  return [
    [],
    [segment(truncate(previewDetail(state, search, row), width), "chrome")],
    [segment(rule, "raised")],
    [],
    ...body
  ];
}

export function previewDetail(
  state: StoryScreenState,
  search: SearchState,
  row: SearchHitRow
): string {
  const hit = row.hit;
  const story = search.scope === "vault" && hit.storyId !== state.payload.id
    ? `${hit.storyTitle} · `
    : "";
  if (hit.kind === "fact") return `${story}fact`;
  const where = `${hit.kind === "prompt" ? "prompt of ¶" : "¶ "}${hit.depth}`;
  if (hit.storyId !== state.payload.id) return `${story}${where}`;
  const index = createStoryIndex(state.payload);
  const position = index.tree.siblingPositionByNodeId.get(hit.targetId);
  const take = position === undefined ? "" : ` · take ${position.index}/${position.count}`;
  const tag = index.tagByNodeId.get(hit.targetId);
  const named = tag === undefined ? "" : ` · ${tagGlyph(tag.status)} ${tag.name}`;
  return `${story}${where}${take}${named}`;
}

/** Every in-pane row draws the divider, blanks included, so the two panes read
 *  as one continuous rule rather than a dashed column. */
export function joinPanes(list: FrameLine, preview: FrameLine, width: number): FrameLine {
  const left = fitLine(list, DIVIDER_COLUMN);
  const line: FrameLine = [
    ...left,
    segment(" ".repeat(Math.max(0, DIVIDER_COLUMN - lineWidth(left)))),
    segment("│", "accent · deep"),
    segment("  ")
  ];
  return [...line, ...fitLine(preview, Math.max(0, width - PREVIEW_COLUMN))];
}

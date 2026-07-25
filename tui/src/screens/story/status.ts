import { lineName } from "../../../../shared/loom-model.js";
import type { Bookmark } from "../../../../shared/types.js";
import { bookmarkGlyph, bookmarkRole } from "../../bookmark-presentation.js";
import { chapterForRow, rowPart, type StoryViewModel } from "../../model.js";
import { pruneConfirmText } from "../../prune-model.js";
import { contextSeverity, formatTokensScaled, formatTokensEstimate, requestWindow } from "../../rail.js";
import type { NextRequestEstimate } from "../../request-projection.js";
import type { StoryScreenState } from "../../state.js";
import {
  fitLine,
  plainLine,
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine,
  type FrameSegment
} from "./frame.js";

export function renderStatus(
  state: StoryScreenState,
  view: StoryViewModel,
  width: number,
  narrow: boolean,
  estimate: NextRequestEstimate
): FrameLine {
  const payload = view.visiblePayload;
  const focused = rowPart(view, state.focusIndex);
  const focusedChapter = chapterForRow(view, state.focusIndex);
  const bookmark = bookmarkForLeaf(payload.bookmarks, payload.path.at(-1)?.id ?? null);
  const title = narrow ? truncate(payload.title, 20) : payload.title;
  const mode = state.mode === "EDITOR" ? "EDIT"
    : state.mode === "COMPOSE" && state.composer.fullscreen
    ? "COMPOSE · fullscreen"
    : state.mode;
  const modeBlock: FrameSegment = {
    text: state.prune === null ? ` ${mode} ` : " PRUNE ",
    role: "background",
    background: state.prune !== null ? "danger"
      : state.mode === "COMPOSE" || state.mode === "EDITOR" ? "compose accent" : "focus / accent",
    bold: true
  };
  if (state.prune !== null) {
    return renderPruneStatus(modeBlock, pruneConfirmText(state.prune), width);
  }
  const left: FrameLine = [modeBlock];
  left.push(segment(`  ${title} · `, "chrome"));
  // The line always has a name (spec: the line chip) — bookmark name when
  // the leaf is bookmarked, the derived working name otherwise.
  const leafId = payload.path.at(-1)?.id;
  let lineIdentity: { text: string; role: DisplayRole } | null = null;
  if (leafId !== undefined) {
    const name = truncate(lineName(payload, leafId), narrow ? 14 : 24);
    lineIdentity = {
      text: `${bookmark !== null ? `${bookmarkGlyph(bookmark.label)} ` : ""}${name}`,
      role: bookmarkRole(bookmark)
    };
    left.push(segment(lineIdentity.text, lineIdentity.role), segment(" · ", "chrome"));
  }
  const location: FrameLine = [];
  if (focused !== null) {
    location.push(segment(narrow ? `¶ ${focused.number}/${view.parts.length}` : `part ${focused.number}/${view.parts.length}`, "chrome"));
    if (focused.siblingCount > 1) location.push(segment(` · ${narrow ? "" : "take "}${focused.takeIndex}/${focused.siblingCount}`, "chrome"));
    left.push(...location);
  }
  if (!narrow) {
    const total = view.totalWords.toLocaleString("en-US");
    left.push(segment(` · ${total} words`, "chrome"));
  }
  const centered = state.typewriter ? " · z centered" : "";
  const usedTokens = estimate.tokens;
  const window = requestWindow(usedTokens, state.contextWindow);
  const requestValue = `${formatTokensEstimate(usedTokens)}${window === null ? "" : `/${formatTokensScaled(window.size)}`}`;
  const requestMeter = `next ${requestValue}`;
  const chapterPrefix = `ch ${focusedChapter?.number ?? view.chapters.at(-1)?.number ?? 1} · `;
  const backendStatus = state.backendTask === null
    ? "local ✓"
    : `working · ${truncate(state.backendTask.label, narrow ? 18 : 28)}`;
  let narrowRight = state.backendTask === null
    ? `${chapterPrefix}${requestMeter}${centered}`
    : `${backendStatus} · ${requestMeter}${centered}`;
  // On the canonical 80-column frame the complete request value outranks the
  // duplicate chapter label and a backend task's descriptive label. Never let
  // generic left-side clipping cut a numeric meter in half.
  const minimumLeftWidth = visibleWidth(modeBlock.text) + 2 + visibleWidth(plainLine(location));
  const priorityLeftWidth = state.backendTask === null
    ? visibleWidth(plainLine(left))
    : minimumLeftWidth;
  if (priorityLeftWidth + visibleWidth(narrowRight) + 2 > width) {
    narrowRight = state.backendTask === null
      ? `${requestMeter}${centered}`
      : `working · ${requestMeter}${centered}`;
  }
  if (minimumLeftWidth + visibleWidth(narrowRight) + 2 > width && centered.length > 0) {
    narrowRight = state.backendTask === null ? requestMeter : `working · ${requestMeter}`;
  }
  if (minimumLeftWidth + visibleWidth(narrowRight) + 2 > width) narrowRight = requestMeter;
  const right: FrameLine = narrow
    ? [segment(` ${narrowRight} `, contextSeverity(window) === "over" ? "danger text" : "chrome")]
    : [
        segment(" ", "chrome"),
        segment(state.model, "chrome", { kind: "settings-row", row: "model" }),
        segment(" · ", "chrome"),
        segment(
          backendStatus,
          "chrome",
          state.backendTask === null
            ? { kind: "settings-row", row: "provider" }
            : undefined
        ),
        segment(`${centered} `, "chrome")
      ];
  const rightWidth = visibleWidth(plainLine(right));
  if (rightWidth >= width) return fitLine(right, width);
  const leftWidth = width - rightWidth;
  const responsiveLeft = visibleWidth(plainLine(left)) <= leftWidth
    ? left
    : compactStatusIdentity(modeBlock, payload.title, lineIdentity, location, leftWidth);
  return [...fitLine(responsiveLeft, leftWidth), ...right];
}

function renderPruneStatus(block: FrameSegment, text: string, width: number): FrameLine {
  const suffix = " · d confirms · esc keeps";
  const available = Math.max(0, width - visibleWidth(block.text) - 2);
  if (visibleWidth(text) <= available || !text.endsWith(suffix)) {
    return fitLine([block, segment(`  ${text}`, "danger text")], width);
  }
  const body = text.slice(0, -suffix.length);
  const bodyWidth = Math.max(1, available - visibleWidth(suffix));
  return fitLine([
    block,
    segment("  ", "danger text"),
    segment(truncate(body, bodyWidth), "danger text"),
    segment(suffix, "danger text")
  ], width);
}

function compactStatusIdentity(
  block: FrameSegment,
  title: string,
  line: { text: string; role: DisplayRole } | null,
  location: FrameLine,
  width: number
): FrameLine {
  const gap = "  ";
  const locationWidth = visibleWidth(plainLine(location));
  const identityWidth = Math.max(0,
    width - visibleWidth(block.text) - visibleWidth(gap) - locationWidth
  );
  const lineSuffix = line !== null && location.length > 0 ? " · " : "";
  const lineBudget = Math.max(0, identityWidth - visibleWidth(lineSuffix));
  const shownLine = line === null ? "" : truncate(line.text, lineBudget);
  const usedByLine = visibleWidth(shownLine) + (shownLine.length === 0 ? 0 : visibleWidth(lineSuffix));
  const titleRoom = identityWidth - usedByLine;
  const titleSuffix = shownLine.length > 0 || location.length > 0 ? " · " : "";
  const titleBudget = titleRoom - visibleWidth(titleSuffix);
  const shownTitle = titleBudget >= 4 ? truncate(title, titleBudget) : "";
  return [
    block,
    segment(gap, "chrome"),
    ...(shownTitle.length === 0
      ? []
      : [segment(shownTitle, "chrome"), segment(titleSuffix, "chrome")]),
    ...(shownLine.length === 0 || line === null
      ? []
      : [segment(shownLine, line.role), segment(lineSuffix, "chrome")]),
    ...location
  ];
}

function bookmarkForLeaf(bookmarks: Bookmark[], leafId: string | null): Bookmark | null {
  return leafId === null ? null : bookmarks.find((bookmark) => bookmark.nodeId === leafId) ?? null;
}

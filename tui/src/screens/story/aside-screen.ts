/**
 * Full-screen Aside surface: header, Side Notes, composer, and use menu.
 */
import type { FrameDeadlineCollector } from "../../animation-deadline.js";
import {
  asideComposerRows,
  asideFooterHint,
  asideHeaderWindow,
  asideHistoryWindow
} from "../../aside-actions.js";
import type { AsideSurfaceState } from "../../aside-surface.js";
import { ASIDE_INPUT_PLACEHOLDER } from "../../aside-surface.js";
import {
  ASIDE_USE_ACTIONS,
  asideUseMenuTitle,
  asideUseRowId
} from "../../aside-use.js";
import type { HitRows, HitTarget } from "../../hit.js";
import {
  buildComposerSelectionProjection
} from "../../selection-projection.js";
import type { StoryScreenState } from "../../state.js";
import { renderConnectionBanner } from "../connection-banner.js";
import { dimPage, panelHorizontalGeometry, placePanel, raisedSegment } from "../overlay.js";
import { cellPad } from "../panel-table-layout.js";
import {
  fitLine,
  segment,
  truncate,
  visibleWidth,
  type FrameLine
} from "./frame.js";
import { renderComposerLayout } from "./composer.js";
import type { StoryScreenFrame } from "../story.js";

function composerHitTarget(line: FrameLine | undefined): HitTarget {
  const sources = new Map<string, boolean>();
  for (const part of line ?? []) {
    if (part.composerHitSource !== undefined) {
      sources.set(part.composerHitSource.id, part.composerHitSource.editable);
    }
  }
  if (sources.size !== 1) return { kind: "composer" };
  const source = sources.entries().next().value;
  if (source === undefined) return { kind: "composer" };
  return {
    kind: "composer",
    composerSourceId: source[0],
    composerEditable: source[1]
  };
}

function renderAsideUseMenu(
  base: FrameLine[],
  surface: AsideSurfaceState,
  width: number,
  height: number,
  hitRows: HitRows
): FrameLine[] {
  const menu = surface.useMenu;
  if (menu === null) return base;
  const note = surface.notes[menu.noteIndex];
  if (note === undefined) return base;
  const actions = ASIDE_USE_ACTIONS;
  const contentWidth = panelHorizontalGeometry(width, 56).contentWidth;
  const leadWidth = Math.min(4, contentWidth);
  const widestName = Math.max(...actions.map((action) => visibleWidth(action.name)));
  const nameWidth = Math.min(widestName + 2, Math.max(0, contentWidth - leadWidth));
  const descriptionWidth = Math.max(0, contentWidth - leadWidth - nameWidth);
  const content: FrameLine[] = actions.map((action, index): FrameLine => [
    raisedSegment(cellPad(index === menu.cursor ? "  ▸ " : "", leadWidth),
      index === menu.cursor ? "focus / accent" : "chrome"),
    raisedSegment(cellPad(truncate(action.name, nameWidth), nameWidth),
      index === menu.cursor ? "prose" : "prose · dim"),
    raisedSegment(truncate(action.description, descriptionWidth), "chrome")
  ]);
  // Keep ↵ and esc complete at 20–21 columns; drop secondary words first.
  const footer = panelHorizontalGeometry(width, 56).footerWidth < visibleWidth("↑↓ · ↵ · esc notes")
    ? "↵ · esc"
    : "↑↓ · ↵ · esc notes";
  return placePanel(
    dimPage(base),
    asideUseMenuTitle(note.answer),
    content,
    footer,
    width,
    height,
    56,
    {
      rows: hitRows,
      targets: actions.map((action, index): HitTarget => ({
        kind: "list",
        index,
        rowId: asideUseRowId(menu.sessionId, action.id),
        selected: index === menu.cursor
      })),
      footerActions: [
        { token: "↵", action: "apply" },
        { token: "esc", action: "cancel" }
      ]
    }
  ).lines;
}

export function renderAsideScreen(
  state: StoryScreenState,
  surface: AsideSurfaceState,
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const composerHeight = asideComposerRows(height);
  const clearing = surface.busy && surface.inflightQuestion === null;
  const notesFocus = surface.focus === "notes" || surface.useMenu !== null;
  const composer = renderComposerLayout({
    composer: surface.composer,
    fullscreen: true,
    terminalWidth: width,
    terminalHeight: composerHeight + 1,
    measure: width,
    title: "aside · prompt",
    caret: clearing || notesFocus ? "none" : surface.busy ? "streaming" : "focused",
    footerNotice: surface.busy ? null : state.toast,
    footerHints: asideFooterHint(surface),
    placeholder: ASIDE_INPUT_PLACEHOLDER,
    narrow: width < 100,
    softWrap: true
  });
  const header = asideHeaderWindow(surface, width, height - composer.lines.length);
  const historyRows = Math.max(0, height - header.length - composer.lines.length);
  const history = asideHistoryWindow(surface, width, historyRows);
  const lines: FrameLine[] = [
    ...header.map((text) => [segment(text, "prose")]),
    ...history.map((text) => {
      const focused = text.startsWith("▸ ");
      return [segment(text, focused ? "focus / accent" : "prose")];
    }),
    ...composer.lines
  ];
  const composerStart = header.length + historyRows;
  while (lines.length < height) lines.push([]);
  const visibleLines = lines.slice(0, height).map((line) => fitLine(line, width));
  const hitRows: HitRows = Array.from({ length: height }, (_, row) => {
    if (row < composerStart || row >= composerStart + composer.lines.length) return null;
    return { target: composerHitTarget(visibleLines[row]), left: 0, right: width };
  });
  // Menu first (owns scrim), connection banner last so its retry hit stays live.
  let renderedLines = visibleLines;
  if (surface.useMenu !== null) {
    renderedLines = renderAsideUseMenu(renderedLines, surface, width, height, hitRows);
  }
  if (state.connection.down) {
    renderedLines = renderConnectionBanner(
      renderedLines, { ...state, hitRows }, width, deadlines
    );
  }
  return {
    lines: renderedLines,
    selectable: null,
    derived: {
      hitRows,
      viewScroll: null,
      viewScrollDelta: 0,
      lastViewportStart: 0,
      composerScrollTop: composer.scrollTop,
      editorScrollTop: 0,
      keysScrollTop: 0,
      composerSelectionProjection: notesFocus
        ? null
        : buildComposerSelectionProjection(renderedLines, width),
      storySelectionProjection: null,
      map: null,
      request: null,
      record: null
    }
  };
}

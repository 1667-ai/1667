/**
 * Full-screen Aside surface: header, Side Notes, composer, and use menu.
 */
import type { FrameDeadlineCollector } from "../../animation-deadline.js";
import {
  asideComposerRows,
  asideFooterHint,
  asideHeaderWindow,
  asideHistoryWindow,
  asideHistoryWindowWithKinds
} from "../../aside-actions.js";
import type { AsideChatRowKind } from "../../aside-v2-layout.js";
import {
  ASIDE_INPUT_PLACEHOLDER,
  asideNotes,
  currentAsideTurns,
  isAsideV2,
  type AsideSessionSurfaceState,
  type AsideSurfaceState
} from "../../aside-surface.js";
import { resetAsideStatus } from "../../aside-v2-actions.js";
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

function renderAsideV2Status(
  state: StoryScreenState,
  surface: AsideSessionSurfaceState,
  width: number
): FrameLine {
  const resetConfirmation = surface.confirmReset !== null
    && surface.confirmReset.turnIndex >= 0;
  if (resetConfirmation) {
    return fitLine([{
      text: resetAsideStatus(surface),
      role: "danger text",
      background: "danger",
      bold: true
    }], width);
  }
  const sessionCount = Math.max(1, surface.sessions.length);
  const anchor = surface.anchor;
  const part = anchor?.partNumber === undefined ? "?" : String(anchor.partNumber);
  const take = anchor?.takeIndex === undefined || anchor.takeCount === undefined
    ? "?/?" : `${anchor.takeIndex}/${anchor.takeCount}`;
  const position = `¶ ${part} · take ${take} · session ${Math.min(
    sessionCount,
    surface.sessionIndex + 1
  )}/${sessionCount}`;
  const left = [
    { text: " ASIDE ", role: "background" as const, background: "accent · deep" as const, bold: true },
    segment(width < 100 ? `  ${position}` : `  ${surface.storyTitle} · ${position}`, "chrome")
  ];
  const rightText = surface.busy
    ? surface.streamPhase ?? "thinking"
    : width < 100 ? "utility route" : `utility route · ${state.model}`;
  const right = segment(` ${rightText} `, surface.busy ? "focus / accent" : "chrome");
  const rightWidth = visibleWidth(rightText) + 2;
  return [...fitLine(left, Math.max(1, width - rightWidth)), right];
}

function renderAsideV2Composer(
  state: StoryScreenState,
  surface: AsideSessionSurfaceState,
  width: number,
  height: number
): FrameLine[] {
  const turnsFocus = surface.focus === "turns" || surface.focus === "notes";
  if (surface.busy) {
    return [fitLine([
      segment("› ", "accent · deep"),
      segment("composer waits", "chrome")
    ], width)];
  }
  if (turnsFocus && !surface.busy) {
    const text = surface.composer.text.length === 0
      ? ASIDE_INPUT_PLACEHOLDER : surface.composer.text;
    return [fitLine([
      segment("› ", "accent · deep"),
      segment(text, surface.composer.text.length === 0 ? "dimmed page" : "prose · dim")
    ], width)];
  }
  const composer = renderComposerLayout({
    composer: surface.composer,
    fullscreen: true,
    terminalWidth: width,
    terminalHeight: Math.max(4, Math.min(asideComposerRows(height), height - 3)),
    measure: width,
    title: "aside · prompt",
    caret: surface.busy ? "streaming" : "focused",
    footerNotice: surface.busy ? null : state.toast,
    footerHints: asideV2FooterHint(surface, width),
    placeholder: ASIDE_INPUT_PLACEHOLDER,
    narrow: width < 100,
    softWrap: true
  });
  return composer.lines;
}

function asideV2FooterHint(surface: AsideSessionSurfaceState, width: number): string {
  if (surface.confirmReset !== null) {
    return surface.confirmReset.turnIndex < 0
      ? "↵ confirms · esc keeps"
      : "⌫ confirms · esc keeps";
  }
  if (surface.busy) return "t Thoughts · esc stops";
  const full = asideFooterHint(surface);
  if (visibleWidth(full) <= width) return full;
  if (surface.focus === "turns" || surface.focus === "notes") {
    const turns = currentAsideTurns(surface);
    const history = surface.turnCursor < Math.max(0, turns.length - 1)
      ? "⌫ reset" : "r retake";
    return `↑↓ turn · ←→ session · n new · ↵ use · ${history} · x delete · t Thoughts · tab ask · [ ] hop · g go · esc read`;
  }
  return "↵ ask · ⇧↵ newline · tab turns · esc read";
}

function asideV2StandaloneFooterLines(surface: AsideSessionSurfaceState, width: number): string[] {
  if (width >= 100 || surface.busy || surface.confirmReset !== null
    || (surface.focus !== "turns" && surface.focus !== "notes")) {
    return [asideV2FooterHint(surface, width)];
  }
  const turns = currentAsideTurns(surface);
  const history = surface.turnCursor < Math.max(0, turns.length - 1)
    ? "⌫ reset" : "r retake";
  return [
    `↑↓ turn · ←→ session · n new · ↵ use · ${history} · x delete`,
    "t Thoughts · tab ask · [ ] hop · g go · esc read"
  ];
}

function renderAsideV2Screen(
  state: StoryScreenState,
  surface: AsideSessionSurfaceState,
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const composerLines = renderAsideV2Composer(state, surface, width, height);
  const status = renderAsideV2Status(state, surface, width);
  const turnsFocus = surface.focus === "turns" || surface.focus === "notes";
  const standaloneFooter = turnsFocus || surface.busy;
  const footerLines = !standaloneFooter ? []
    : turnsFocus && typeof state.toast === "string" && state.toast.length > 0
    ? [state.toast]
    : asideV2StandaloneFooterLines(surface, width);
  const bottomRows = composerLines.length + footerLines.length + 1;
  const header = asideHeaderWindow(surface, width, Math.max(0, height - bottomRows));
  const historyRows = Math.max(0, height - header.length - bottomRows);
  const history = asideHistoryWindowWithKinds(surface, width, historyRows, state.now);
  const lines: FrameLine[] = [
    ...header.map(renderAsideV2HeaderLine),
    ...history.lines.map((text, index) =>
      renderAsideV2HistoryLine(text, history.rowKinds[index] ?? "plain")),
    ...composerLines,
    ...footerLines.map((line) => [segment(line, "chrome")]),
    status
  ].map((line) => fitLine(line, width));
  while (lines.length < height) lines.push([]);
  const composerStart = header.length + historyRows;
  const hitRows: HitRows = Array.from({ length: height }, (_, row) => {
    if (row < composerStart || row >= composerStart + composerLines.length) return null;
    return { target: { kind: "composer" }, left: 0, right: width };
  });
  let renderedLines = lines.slice(0, height);
  if (surface.useMenu !== null) {
    renderedLines = renderAsideUseMenu(renderedLines, surface, width, height, hitRows);
  }
  if (state.connection.down) {
    renderedLines = renderConnectionBanner(renderedLines, { ...state, hitRows }, width, deadlines);
  }
  const selectionInTurns = turnsFocus || surface.useMenu !== null;
  return {
    lines: renderedLines,
    selectable: null,
    derived: {
      hitRows,
      viewScroll: null,
      viewScrollDelta: 0,
      lastViewportStart: 0,
      composerScrollTop: 0,
      editorScrollTop: 0,
      keysScrollTop: 0,
      composerSelectionProjection: selectionInTurns
        ? null : buildComposerSelectionProjection(renderedLines, width),
      storySelectionProjection: null,
      map: null,
      request: null,
      record: null
    }
  };
}

function renderQuestionHistoryLine(
  text: string,
  prefix: string,
  prefixRole: "focus / accent" | "accent · deep",
  bodyRole: "prose" | "prose · dim"
): FrameLine {
  const content = text.slice(prefix.length);
  const timestamp = content.match(/^(.*?)( {2,})((?:just now|yesterday|\d+[mhd] ago))$/u);
  if (timestamp === null) {
    return [segment(prefix, prefixRole), segment(content, bodyRole)];
  }
  return [
    segment(prefix, prefixRole),
    segment(timestamp[1]!, bodyRole),
    segment(timestamp[2]!, "background"),
    segment(timestamp[3]!, "dimmed page")
  ];
}

function renderAsideV2HistoryLine(
  text: string,
  kind: AsideChatRowKind
): FrameLine {
  if (kind === "question") {
    if (text.startsWith("▸ › ")) {
      return renderQuestionHistoryLine(text, "▸ › ", "focus / accent", "prose");
    }
    if (text.startsWith("  › ")) {
      return renderQuestionHistoryLine(text, "  › ", "accent · deep", "prose · dim");
    }
  }
  if (kind === "thought" && text.startsWith("  ┊ ")) {
    return [segment("  ┊ ", "dimmed page"), segment(text.slice(4), "dimmed page")];
  }
  if (kind === "status" && (text.startsWith("  ⟳ ") || text.startsWith("▸ ⟳ "))) {
    const prefix = text.startsWith("▸") ? "▸ ⟳ " : "  ⟳ ";
    return [segment(prefix, "dimmed page"), segment(text.slice(prefix.length), "dimmed page")];
  }
  return [segment(text, "prose · dim")];
}

function renderAsideV2HeaderLine(text: string): FrameLine {
  if (text.startsWith("elsewhere   ")) {
    const currentStart = text.indexOf("[ ", 12);
    const currentEnd = currentStart < 0 ? -1 : text.indexOf(" ]", currentStart + 2);
    if (currentStart >= 0 && currentEnd >= 0) {
      return [
        segment("elsewhere   ", "chrome"),
        segment(text.slice(12, currentStart), "chrome"),
        {
          text: text.slice(currentStart, currentEnd + 2),
          role: "background",
          background: "focus / accent",
          bold: true
        },
        segment(text.slice(currentEnd + 2), "chrome")
      ];
    }
    return [segment("elsewhere   ", "chrome"), segment(text.slice(12), "chrome")];
  }
  const badge = "non-canon";
  const badgeStart = text.endsWith(badge) ? text.length - badge.length : -1;
  const main = badgeStart < 0 ? text : text.slice(0, badgeStart);
  const storyEnd = main.indexOf(" ━ ¶ ");
  const anchorEnd = storyEnd < 0 ? -1 : main.indexOf(" ━ ‹ session ", storyEnd + 1);
  if (text.startsWith("aside ━━━ ") && storyEnd > 0 && anchorEnd > storyEnd) {
    return [
      segment(main.slice(0, 10), "chrome"),
      segment(main.slice(10, storyEnd), "prose · dim"),
      segment(main.slice(storyEnd, anchorEnd), "accent · deep"),
      segment(main.slice(anchorEnd), "focus / accent"),
      ...(badgeStart < 0 ? [] : [
        segment(text.slice(main.length, badgeStart), "chrome"),
        segment(badge, "chrome")
      ])
    ];
  }
  return badgeStart < 0
    ? [segment(text, "chrome")]
    : [segment(main, "chrome"), segment(text.slice(main.length), "chrome")];
}

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
  const note = asideNotes(surface)[menu.noteIndex];
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
  if (isAsideV2(surface)) {
    return renderAsideV2Screen(state, surface, width, height, deadlines);
  }
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
  const history = asideHistoryWindow(surface, width, historyRows, state.now);
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

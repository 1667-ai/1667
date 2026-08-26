/**
 * Full-screen Aside surface: header, Side Notes, composer, and use menu.
 */
import type { FrameDeadlineCollector } from "../../animation-deadline.js";
import {
  asideComposerRows,
  asideFooterHint,
  asideHeaderWindow,
  asideHistoryLayout,
  asideHistoryWindowWithKinds,
  asideV2FooterHeight
} from "../../aside-actions.js";
import type { AsideChatRowKind } from "../../aside-v2-layout.js";
import {
  ASIDE_INPUT_PLACEHOLDER,
  asideNotes,
  currentAsideTurns,
  isAsideV2,
  type AsideAnswerSource,
  type AsideSessionSurfaceState,
  type AsideSurfaceState
} from "../../aside-surface.js";
import { resetAsideStatus } from "../../aside-v2-actions.js";
import {
  asideAnswerRowId,
  asideUseActions,
  asideUseMenuTitle,
  asideUseRowId
} from "../../aside-use.js";
import type { HitRows, HitTarget } from "../../hit.js";
import {
  buildComposerSelectionProjection,
  buildStorySelectionProjection
} from "../../selection-projection.js";
import type { StoryScreenState } from "../../state.js";
import { renderConnectionBanner } from "../connection-banner.js";
import {
  dimPage,
  panelContentRows,
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "../overlay.js";
import { cellPad, panelRange, panelRowWindow } from "../panel-table-layout.js";
import { wrapText } from "../../wrap.js";
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
    return `↑↓ turn · ←→ session · n new · ↵ use · ${history} · x delete · t Thoughts · tab ask · [ ] hop · g go · esc exit`;
  }
  return "↵ ask · ⇧↵ newline · tab turns · esc exit";
}

function asideV2StandaloneFooterLines(
  surface: AsideSessionSurfaceState,
  width: number,
  toast?: string | null
): string[] {
  const turnsFocus = surface.focus === "turns" || surface.focus === "notes";
  if (turnsFocus && toast !== undefined && toast !== null && toast.length > 0) {
    return [toast];
  }
  if (asideV2FooterHeight(surface, width, toast) !== 2) {
    return [asideV2FooterHint(surface, width)];
  }
  const turns = currentAsideTurns(surface);
  const history = surface.turnCursor < Math.max(0, turns.length - 1)
    ? "⌫ reset" : "r retake";
  return [
    `↑↓ turn · ←→ session · n new · ↵ use · ${history} · x delete`,
    "t Thoughts · tab ask · [ ] hop · g go · esc exit"
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
  const footerLines = standaloneFooter
    ? asideV2StandaloneFooterLines(surface, width, state.toast)
    : [];
  const bottomRows = composerLines.length + footerLines.length + 1;
  const header = asideHeaderWindow(surface, width, Math.max(0, height - bottomRows));
  const historyRows = Math.max(0, height - header.length - bottomRows);
  const historyLayout = asideHistoryLayout(surface, width, state.now);
  const history = asideHistoryWindowWithKinds(
    surface, width, historyRows, state.now, historyLayout
  );
  const lines: FrameLine[] = [
    ...header.map(renderAsideV2HeaderLine),
    ...history.lines.map((text, index) =>
      renderAsideV2HistoryLine(
        text,
        history.rowKinds[index] ?? "plain",
        historyLayout.rowAnswerSources[history.start + index]
      )),
    ...composerLines,
    ...footerLines.map((line) => [segment(line, "chrome")]),
    status
  ].map((line) => fitLine(line, width));
  while (lines.length < height) lines.push([]);
  const composerStart = header.length + historyRows;
  const hitRows: HitRows = Array.from({ length: height }, (_, row) => {
    if (row >= header.length && row < composerStart) {
      const target = asideAnswerHitTarget(
        surface,
        historyLayout,
        history.start,
        row - header.length
      );
      if (target !== null) return { target, left: 0, right: width };
    }
    if (row < composerStart || row >= composerStart + composerLines.length) return null;
    return { target: { kind: "composer" }, left: 0, right: width };
  });
  const storySelectionProjection = buildStorySelectionProjection(lines, width);
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
      storySelectionProjection,
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
  kind: AsideChatRowKind,
  answerSource?: AsideAnswerSource | null
): FrameLine {
  if (kind === "question") {
    if (text.startsWith("▸ › ")) {
      return renderQuestionHistoryLine(text, "▸ › ", "focus / accent", "prose");
    }
    if (text.startsWith("  › ")) {
      return renderQuestionHistoryLine(text, "  › ", "accent · deep", "prose · dim");
    }
    // Older layouts can leave a decorated continuation without the repeated
    // marker. Keep its body role aligned with the labelled question row.
    if (text.startsWith("▸ ")) {
      return [segment("▸ ", "focus / accent"), segment(text.slice(2), "prose")];
    }
    if (text.startsWith("    ")) {
      return [segment(text.slice(0, 4), "accent · deep"), segment(text.slice(4), "prose · dim")];
    }
  }
  if (kind === "thought" && text.startsWith("  ┊ ")) {
    return [segment("  ┊ ", "dimmed page"), segment(text.slice(4), "dimmed page")];
  }
  if (kind === "status" && (text.startsWith("  ⟳ ") || text.startsWith("▸ ⟳ "))) {
    const prefix = text.startsWith("▸") ? "▸ ⟳ " : "  ⟳ ";
    return [segment(prefix, "dimmed page"), segment(text.slice(prefix.length), "dimmed page")];
  }
  if (kind === "answer") {
    const prefix = text.startsWith("▸ ") ? "▸ " : text.startsWith("  ") ? "  " : "";
    if (prefix.length > 0) {
      return [
        segment(prefix, "prose · dim"),
        asideAnswerSegment(text.slice(prefix.length), "prose · dim", answerSource)
      ];
    }
  }
  return [segment(text, "prose · dim")];
}

function renderLegacyHistoryLine(
  text: string,
  kind: AsideChatRowKind,
  answerSource?: AsideAnswerSource | null
): FrameLine {
  if (kind === "question") {
    if (text.startsWith("▸ Q: ")) {
      return [segment("▸ Q: ", "focus / accent"), segment(text.slice(5), "prose")];
    }
    if (text.startsWith("  Q: ")) {
      return [segment("  Q: ", "accent · deep"), segment(text.slice(5), "prose · dim")];
    }
    // Legacy rows use a five-cell Q: prefix. Keep continuation body roles
    // aligned with the labelled question row.
    if (text.startsWith("▸ ")) {
      return [segment("▸ ", "focus / accent"), segment(text.slice(2), "prose")];
    }
    if (text.startsWith("     ")) {
      return [segment(text.slice(0, 5), "accent · deep"), segment(text.slice(5), "prose · dim")];
    }
  }
  if (kind === "answer") {
    const prefix = text.startsWith("▸ A: ") || text.startsWith("▸    ")
      ? "▸ A: ".length
      : text.startsWith("  A: ") || text.startsWith("     ")
        ? "  A: ".length : 0;
    if (prefix > 0) {
      const focused = text.startsWith("▸ ");
      return [
        segment(text.slice(0, prefix), focused ? "focus / accent" : "prose"),
        asideAnswerSegment(text.slice(prefix), focused ? "focus / accent" : "prose", answerSource)
      ];
    }
  }
  const focused = text.startsWith("▸ ");
  return [segment(text, focused ? "focus / accent" : "prose")];
}

function asideAnswerSegment(
  text: string,
  role: "focus / accent" | "prose" | "prose · dim",
  source: AsideAnswerSource | null | undefined
): FrameLine[number] {
  return {
    ...segment(text, role),
    ...(source === null || source === undefined ? {} : {
      storySource: source,
      prose: true as const
    })
  };
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

/** Map a visible history row back to its saved answer. Inflight answers are
 * deliberately left without a target because Placement and Fact insertion
 * need a settled turn/note. */
function asideAnswerHitTarget(
  surface: AsideSurfaceState,
  layout: ReturnType<typeof asideHistoryLayout>,
  start: number,
  visibleRow: number
): HitTarget | null {
  const bodyRow = start + visibleRow;
  if (layout.rowKinds[bodyRow] !== "answer") return null;
  const noteIndex = isAsideV2(surface)
    ? layout.rowTurnIndex[bodyRow]
    : layout.rowNoteIndex[bodyRow];
  if (noteIndex === null || noteIndex === undefined) return null;
  return {
    kind: "aside-answer",
    noteIndex,
    rowId: asideAnswerRowId(surface, noteIndex)
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
  const actions = asideUseActions(menu.selectionText);
  const contentWidth = panelHorizontalGeometry(width, 56).contentWidth;
  // placePanel reserves the last screen row for its bottom rule. Account for
  // that low-height paint bound before windowing, or a two-line block could
  // lose its final line when the panel reaches its minimum height.
  const contentBudget = Math.max(1, Math.min(panelContentRows(height), height - 4));
  const leadWidth = Math.min(4, contentWidth);
  const widestName = Math.max(...actions.map((action) => visibleWidth(action.name)));
  const nameWidth = Math.min(widestName + 2, Math.max(0, contentWidth - leadWidth));
  const descriptionWidth = Math.max(0, contentWidth - leadWidth - nameWidth);
  const overflowBlocks = new Set<number>();
  const blocks = actions.map((action, index) => {
    const initial = asideUseActionBlock(
      action,
      index,
      menu.cursor,
      contentWidth,
      leadWidth,
      nameWidth,
      descriptionWidth
    );
    if (initial.length <= contentBudget) return initial;
    const reflowed = asideUseActionBlockFullWidth(action, index, menu.cursor, contentWidth);
    if (reflowed.length <= contentBudget) return reflowed;
    overflowBlocks.add(index);
    return [asideUseOverflowLine(index === menu.cursor, contentWidth)];
  });
  const window = panelRowWindow(
    blocks.map((block) => block.length),
    menu.cursor,
    contentBudget
  );
  const content = blocks.slice(window.start, window.end).flat();
  const targets = blocks.slice(window.start, window.end).flatMap((block, offset) =>
    block.map((): HitTarget | null => overflowBlocks.has(window.start + offset)
      ? null
      : {
        kind: "list",
        index: window.start + offset,
        rowId: asideUseRowId(menu.sessionId, actions[window.start + offset]!.id),
        selected: window.start + offset === menu.cursor
      })
  );
  // Keep ↵ and esc complete at 20–21 columns; drop secondary words first.
  const footer = panelHorizontalGeometry(width, 56).footerWidth < visibleWidth("↑↓ · ↵ · esc notes")
    ? "↵ · esc"
    : "↑↓ · ↵ · esc notes";
  const menuTitle = asideUseMenuTitle(note.answer, menu.selectionText);
  const hasHiddenActions = window.start > 0 || window.end < actions.length;
  const title = overflowBlocks.size > 0 || hasHiddenActions
    ? `use ↑↓ · ${menuTitle.slice(menuTitle.indexOf(" · ") + 3)}`
    : `${menuTitle}${panelRange(actions.length, window)}`;
  return placePanel(
    dimPage(base),
    title,
    content,
    footer,
    width,
    height,
    56,
    {
      rows: hitRows,
      targets,
      footerActions: [
        { token: "↵", action: "apply" },
        { token: "esc", action: "cancel" }
      ]
    }
  ).lines;
}

const MIN_INLINE_DESCRIPTION_WIDTH = 12;

function wrappedActionText(text: string, width: number): string[] {
  return wrapText(text, [], Math.max(1, width)).map((line) => line.text);
}

/** Wrap one action without passing an ellipsis into the panel's cell fitter.
 * Wide panels keep the aligned two-column layout. Narrow panels stack the
 * label and description so both fields retain their complete text. */
function asideUseActionBlock(
  action: { name: string; description: string },
  index: number,
  cursor: number,
  contentWidth: number,
  leadWidth: number,
  nameWidth: number,
  descriptionWidth: number
): FrameLine[] {
  const selected = index === cursor;
  if (descriptionWidth >= MIN_INLINE_DESCRIPTION_WIDTH && nameWidth > 0) {
    const names = wrappedActionText(action.name, nameWidth);
    const descriptions = wrappedActionText(action.description, descriptionWidth);
    const rows = Math.max(names.length, descriptions.length);
    return Array.from({ length: rows }, (_, row) => [
      raisedSegment(cellPad(row === 0 && selected ? "  ▸ " : "", leadWidth),
        row === 0 && selected ? "focus / accent" : "chrome"),
      raisedSegment(cellPad(names[row] ?? "", nameWidth),
        selected ? "prose" : "prose · dim"),
      raisedSegment(descriptions[row] ?? "", "chrome")
    ]);
  }

  const labelWidth = Math.max(1, contentWidth - Math.min(leadWidth, contentWidth));
  const names = wrappedActionText(action.name, labelWidth);
  const indent = Math.min(2, contentWidth);
  const descriptionMeasure = Math.max(1, contentWidth - indent);
  const descriptions = wrappedActionText(action.description, descriptionMeasure);
  const labelRows = names.map((name, row): FrameLine => [
    raisedSegment(cellPad(row === 0 && selected ? "  ▸ " : "", Math.min(leadWidth, contentWidth)),
      row === 0 && selected ? "focus / accent" : "chrome"),
    raisedSegment(cellPad(name, labelWidth), selected ? "prose" : "prose · dim")
  ]);
  const descriptionRows = descriptions.map((description): FrameLine => [
    raisedSegment(" ".repeat(indent), "chrome"),
    raisedSegment(description, "chrome")
  ]);
  return [...labelRows, ...descriptionRows];
}

/** Reflow a tall two-column block as one full-width stack before giving up to
 * the viewport. This keeps the panel from painting the bottom half of an
 * action when only a small body budget remains. */
function asideUseActionBlockFullWidth(
  action: { name: string; description: string },
  index: number,
  cursor: number,
  contentWidth: number
): FrameLine[] {
  const selected = index === cursor;
  const marker = selected ? "▸ " : "  ";
  const nameWidth = Math.max(1, contentWidth - visibleWidth(marker));
  const names = wrappedActionText(action.name, nameWidth);
  const descriptions = wrappedActionText(action.description, contentWidth);
  return [
    ...names.map((name, row): FrameLine => [
      raisedSegment(row === 0 ? marker : " ".repeat(visibleWidth(marker)),
        row === 0 && selected ? "focus / accent" : "chrome"),
      raisedSegment(name, selected ? "prose" : "prose · dim")
    ]),
    ...descriptions.map((description): FrameLine => [
      raisedSegment(description, "chrome")
    ])
  ];
}

function asideUseOverflowLine(selected: boolean, contentWidth: number): FrameLine {
  const marker = selected ? "▸ " : "  ";
  const cue = "… use ↑↓";
  const available = Math.max(1, contentWidth - visibleWidth(marker));
  return [
    raisedSegment(marker, selected ? "focus / accent" : "chrome"),
    raisedSegment(truncate(cue, available), selected ? "prose" : "prose · dim")
  ];
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
  const historyLayout = asideHistoryLayout(surface, width, state.now);
  const history = asideHistoryWindowWithKinds(
    surface, width, historyRows, state.now, historyLayout
  );
  const lines: FrameLine[] = [
    ...header.map((text) => [segment(text, "prose")]),
    ...history.lines.map((text, index) => renderLegacyHistoryLine(
      text,
      history.rowKinds[index] ?? "plain",
      historyLayout.rowAnswerSources[history.start + index]
    )),
    ...composer.lines
  ];
  const composerStart = header.length + historyRows;
  while (lines.length < height) lines.push([]);
  const visibleLines = lines.slice(0, height).map((line) => fitLine(line, width));
  const hitRows: HitRows = Array.from({ length: height }, (_, row) => {
    if (row >= header.length && row < composerStart) {
      const target = asideAnswerHitTarget(
        surface,
        historyLayout,
        history.start,
        row - header.length
      );
      if (target !== null) return { target, left: 0, right: width };
    }
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
  const storySelectionProjection = buildStorySelectionProjection(visibleLines, width);
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
      storySelectionProjection,
      map: null,
      request: null,
      record: null
    }
  };
}

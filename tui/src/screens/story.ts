import { BOOKMARK_LABELS } from "../../../shared/types.js";
import type { FrameDeadlineCollector } from "../animation-deadline.js";
import { bookmarkLabelChoice } from "../bookmark-presentation.js";
import { chapterWord } from "../chapter-model.js";
import type { KeyAction } from "../keys.js";
import {
  createStoryViewModel,
  rowIndexForNode,
  rowPart,
  type StoryViewModel
} from "../model.js";
import { buildRailModel } from "../rail.js";
import { projectNextRequest } from "../request-context.js";
import { nextRequestEstimate, type NextRequestEstimate } from "../request-projection.js";
import type { HitRow, HitRows, HitTarget } from "../hit.js";
import type { StoryScreenState } from "../state.js";
import { deriveStoryFrameLayout, type StoryFrameLayout } from "../story-frame-layout.js";
import { createWrapCache, type ProseStyle, type WrapCache } from "../wrap.js";
import { renderFactsRail } from "./story/facts-rail.js";
import { dimPage, panelWidthFor, placePanel, raisedSegment } from "./overlay.js";
import { renderKeysOverlay } from "./keys-modal.js";
import { renderMapScreen } from "./map.js";
import { renderPanels } from "./panels.js";
import { renderConnectionBanner } from "./connection-banner.js";
import {
  fitLine,
  hintItem,
  joinHints,
  plainLine,
  segment,
  splitFrame,
  truncateTail,
  visibleWidth,
  type DisplayRole,
  type FrameComposition,
  type FrameLine,
  type FrameSegment,
  type HintItem
} from "./story/frame.js";
import { addInlineHits } from "./story/hits.js";
import { layoutStoryRow, renderChapterOneHeading, STORY_GUTTER } from "./story/row-layout.js";
import { paintStorySelection } from "./story/selection-highlight.js";
import { stickFocusedGutter, type FocusedStickyGutter } from "./story/sticky-gutter.js";
import { applyComposePageMode, renderComposerLayout } from "./story/composer.js";
import { renderStatus as renderCanonicalStatus } from "./story/status.js";
import { viewportLines, type ViewportBlock } from "./story/viewport.js";
import { isStoryViewportPinned } from "../viewport-intent.js";
import {
  buildComposerSelectionProjection,
  buildStorySelectionProjection,
  type ComposerSelectionProjection,
  type StorySelectionProjection
} from "../selection-projection.js";

export interface StoryScreenOptions {
  width: number;
  height: number;
  wrapCache?: WrapCache<ProseStyle>;
  layout?: StoryFrameLayout;
  deadlines?: FrameDeadlineCollector;
  /** Static mockups may frame a second semantic row without changing focus. */
  viewportAnchorId?: string;
}

export interface StoryScreenDerived {
  hitRows: HitRows;
  viewScroll: number | null;
  viewScrollDelta: number;
  lastViewportStart: number;
  composerScrollTop: number;
  editorScrollTop: number;
  keysScrollTop: number;
  composerSelectionProjection: ComposerSelectionProjection | null;
  storySelectionProjection: StorySelectionProjection | null;
  map: StoryScreenState["map"];
}

export interface StoryScreenFrame extends FrameComposition {
  derived: StoryScreenDerived;
}

const DEFAULT_CACHE = createWrapCache<ProseStyle>();

export function renderStoryScreen(state: StoryScreenState, options: StoryScreenOptions): StoryScreenFrame {
  const { height } = options;
  if (state.map !== null && (state.mode === "MAP"
    || state.mode === "BOOKMARK" && state.bookmark?.returnMode === "MAP")) {
    return renderMap(state, options.width, height, options.deadlines);
  }
  const fullscreen = state.mode === "COMPOSE" && state.composer.fullscreen;
  const view = createStoryViewModel(state.payload, state.stream);
  const projectedRequest = projectNextRequest(state, view);
  const estimate = nextRequestEstimate(projectedRequest.payload, projectedRequest.context);
  if (state.mode === "EDITOR" && state.editor !== null) {
    return renderInlineEditor(state, view, options.width, height, estimate, options.deadlines);
  }
  if (fullscreen) {
    return renderFullscreenComposer(state, view, options.width, height, estimate, options.deadlines);
  }
  const frameLayout = options.layout ?? deriveStoryFrameLayout(options.width, state.config);
  const rail = frameLayout.railStart !== null;
  const width = frameLayout.pageWidth;
  const narrow = width < 100;
  const measure = storyProseMeasure(width);
  const cache = options.wrapCache ?? DEFAULT_CACHE;
  const parts = view.parts;
  const rows = view.rows;
  const blocks: ViewportBlock[] = [];
  let focusedGutter: FocusedStickyGutter | null = null;
  const toastInNavFooter = state.mode !== "COMPOSE" && state.toast !== null
    && isStoryViewportPinned(state);
  if (view.chapters.length > 1) {
    blocks.push({
      partId: "chapter-one-heading", partIndex: -1,
      height: 2,
      render: () => [...renderChapterOneHeading(view, measure, narrow), []]
    });
  }
  for (const [rowIndex, row] of rows.entries()) {
    const toast = !toastInNavFooter && state.mode !== "COMPOSE" && state.toast !== null && rowIndex === state.focusIndex
      ? state.toast
      : null;
    const layout = layoutStoryRow(row, rowIndex, parts, state, measure, narrow, cache, options.deadlines);
    if (layout.stickyGutter !== null) {
      focusedGutter = {
        rowIndex,
        partHeight: layout.height,
        gutter: layout.stickyGutter
      };
    }
    blocks.push({
      partId: row.id,
      partIndex: rowIndex,
      height: layout.height + 1 + (toast === null ? 0 : 2),
      render: () => [
        ...layout.render(),
        [],
        ...(toast === null ? [] : [[segment("  "), segment(toast, "focus / accent")], []] as FrameLine[])
      ]
    });
  }
  // A toast must survive even when no part carries it (empty story, focus
  // beyond the line): fall back to a standalone block above the composer.
  if (!toastInNavFooter && state.mode !== "COMPOSE" && state.toast !== null && rows[state.focusIndex] === undefined) {
    blocks.push({
      partId: "toast", partIndex: -1, height: 2,
      render: () => [[segment("  "), segment(state.toast!, "focus / accent")], []]
    });
  }

  const composer = renderPageComposer(state, view, width, measure, narrow, height);
  const composerLines = composer.lines;
  const composerRows = composerLines.length;
  const contentHeight = Math.max(1, height - composerRows - 1);
  // Generation moves focus to its target when the stream opens. Later user
  // navigation owns the same semantic focus, so rendering needs no second
  // auto-follow flag that can drift from the reducer state.
  const focusId = options.viewportAnchorId ?? rows[state.focusIndex]?.id ?? rows[0]?.id ?? null;
  const viewport = viewportLines(
    blocks,
    focusId,
    contentHeight,
    state.typewriter,
    state.viewScroll,
    state.viewScrollDelta
  );
  const visibleBody = stickFocusedGutter(
    viewport.lines,
    viewport.owners,
    viewport.blockRows,
    focusedGutter,
    width
  );
  const pad = contentHeight - visibleBody.length;
  // The status bar is frame chrome, not page content: with a rail present it
  // spans the whole terminal, so the split surface is everything above it. It
  // still stops at the rail's outer margin, which keeps the frame off the
  // terminal's right edge.
  const surfaceRows = Math.max(0, height - 1);
  const status = fitLine(
    renderStoryStatus(state, view, frameLayout.railRight ?? frameLayout.fullWidth, narrow, estimate),
    frameLayout.fullWidth
  );
  let lines: FrameLine[] = [
    ...Array.from({ length: pad }, (): FrameLine => []),
    ...visibleBody,
    ...composerLines
  ];
  lines = lines.slice(0, surfaceRows).map((line) => fitLine(line, width));
  // Rebuild the click map for this frame: pad rows, then body rows owned by
  // their part, then the composer and status bar.
  // Prose and composer clicks stop at the page's own width so the rail, when
  // present, never answers for them.
  let hitRows: HitRows = Array.from({ length: height }, (_, row): HitRow | null => {
    const bounds = { left: 0, right: width };
    if (row < pad) return null;
    const bodyRow = row - pad;
    if (bodyRow < viewport.owners.length) {
      const owner = viewport.owners[bodyRow] ?? -1;
      const rowId = rows[owner]?.id;
      return owner < 0 || rowId === undefined
        ? null
        : { target: { kind: "part", index: owner, rowId }, ...bounds };
    }
    if (row >= height - 1) return null;
    return { target: { kind: "composer" }, ...bounds };
  });
  if (rail) {
    const focusedText = rowPart(view, state.focusIndex)?.node.text ?? "";
    lines = renderFactsRail(lines,
      buildRailModel(state.payload, focusedText, state.contextWindow, estimate),
      hitRows, surfaceRows, frameLayout, state.contextMeterExpanded);
  }
  if (state.mode === "COMPOSE") {
    lines = applyComposePageMode(
      lines, contentHeight, frameLayout.pageWidth, state.config.composeFocus === "on"
    );
  }
  // Settings-row cells are only live in NAV: opening settings does not close an
  // inline editor session, so a click from EDITOR would leave `state.editor` set
  // behind a panel that returns to NAV.
  const liveHit = (target: HitTarget) => target.kind !== "settings-row" || state.mode === "NAV";
  addInlineHits(lines, hitRows, liveHit);
  // The status bar is composited after the split surface, so it harvests its
  // own row rather than riding along with the page rows above it.
  lines.push(status);
  addInlineHits([status], hitRows, liveHit, surfaceRows);
  const menuSelection = state.actions?.selectionSpans;
  if (menuSelection !== undefined && menuSelection.length > 0) {
    lines = paintStorySelection(lines, menuSelection);
  }
  const full = options.width;
  let selectable: FrameComposition["selectable"] = null;
  // The reference is taller than a short terminal can show, so its scroll
  // offset is clamped where the rows are known and handed back to the state.
  let keysScrollTop = state.keysScrollTop;
  if (state.mode === "KEYS") {
    const keys = renderKeysOverlay(dimPage(lines), hitRows, full, height, state.keysScrollTop);
    lines = keys.composition.lines;
    selectable = keys.composition.selectable;
    keysScrollTop = keys.scrollTop;
  }
  const panels = renderPanels(lines, state, hitRows, full, height, estimate, options.deadlines);
  const presentedLines = panels.lines;
  const pageSelectionLines = frameLayout.railStart === null
    ? presentedLines
    : splitFrame(presentedLines, frameLayout.pageWidth)[0];
  return {
    lines: presentedLines,
    selectable: panels.selectable ?? selectable,
    derived: {
      hitRows,
      viewScroll: viewport.viewScroll,
      viewScrollDelta: 0,
      lastViewportStart: viewport.start,
      composerScrollTop: composer.scrollTop,
      editorScrollTop: state.editorScrollTop,
      keysScrollTop,
      composerSelectionProjection: state.mode === "SETTINGS" && state.settings?.edit != null
        ? buildComposerSelectionProjection(presentedLines, full)
        : state.mode === "COMPOSE"
          ? buildComposerSelectionProjection(pageSelectionLines, frameLayout.pageWidth)
          : null,
      storySelectionProjection: state.mode === "NAV"
        ? buildStorySelectionProjection(pageSelectionLines, frameLayout.pageWidth)
        : null,
      map: state.map
    }
  };
}

export function storyProseMeasure(pageWidth: number): number {
  return Math.max(1, Math.min(72, pageWidth < 100 ? pageWidth - 4 : pageWidth - 26));
}

function renderMap(
  state: StoryScreenState,
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const hitRows: HitRows = Array.from({ length: height }, () => null);
  const frame = renderMapScreen(state, state.map!, width, height, hitRows, deadlines);
  const map = {
    ...state.map!,
    rowIds: frame.derived.rowIds,
    pathCursorId: frame.derived.pathCursorId,
    treeCursorId: frame.derived.treeCursorId,
    openedColdFolds: new Set(state.map!.openedColdFolds)
  };
  const bookmark = state.mode === "BOOKMARK" && state.bookmark !== null
    ? renderMapBookmark(frame.lines, state, hitRows, width, height)
    : null;
  const lines = state.connection.down
    ? renderConnectionBanner(bookmark?.lines ?? frame.lines, { ...state, hitRows }, width, deadlines)
    : bookmark?.lines ?? frame.lines;
  return {
    lines,
    selectable: bookmark?.selectable ?? frame.selectable,
    derived: {
      hitRows,
      viewScroll: state.viewScroll,
      viewScrollDelta: state.viewScrollDelta,
      lastViewportStart: state.lastViewportStart,
      composerScrollTop: state.composerScrollTop,
      editorScrollTop: state.editorScrollTop,
      keysScrollTop: state.keysScrollTop,
      composerSelectionProjection: null,
      storySelectionProjection: null,
      map
    }
  };
}

function renderMapBookmark(
  base: FrameLine[],
  state: StoryScreenState,
  hitRows: HitRows,
  width: number,
  height: number
): FrameComposition {
  const prompt = state.bookmark!;
  const selected = bookmarkLabelChoice(BOOKMARK_LABELS[prompt.labelIndex] ?? "");
  const namePrefix = "  Name  ";
  const nameWidth = Math.max(0, panelWidthFor(width, 64) - 2 - visibleWidth(namePrefix) - 1);
  const input: FrameLine = [
    raisedSegment(namePrefix, "chrome"),
    raisedSegment(truncateTail(prompt.name, nameWidth), "streaming"),
    ...(prompt.choosingLabel ? [] : [{
      text: " ", role: "background" as const, background: "focus / accent" as const
    }])
  ];
  const content: FrameLine[] = [input, [], [
    raisedSegment("  Label  ", "chrome"),
    raisedSegment(`‹ ${selected} ›`, prompt.choosingLabel ? "focus / accent" : "prose · dim")
  ]];
  const footer = prompt.choosingLabel
    ? `←→ label · enter save · esc cancel${prompt.existing ? " · d delete" : ""}`
    : "enter choose label · esc cancel";
  return placePanel(dimPage(base), "bookmark line", content, footer, width, height, 64, {
    rows: hitRows,
    targets: content.map(() => null)
  });
}

function renderPageComposer(state: StoryScreenState, view: StoryViewModel, width: number, measure: number, narrow: boolean, height: number): { lines: FrameLine[]; scrollTop: number } {
  const indent = narrow ? "  " : " ".repeat(STORY_GUTTER);
  const rule = [segment(indent), segment("─".repeat(measure), "chrome")];
  if (state.mode === "BOOKMARK" && state.bookmark !== null) {
    const selected = bookmarkLabelChoice(BOOKMARK_LABELS[state.bookmark.labelIndex] ?? "");
    const bookmarkPrefix = "› bookmark ";
    const nameWidth = Math.max(0, measure - visibleWidth(bookmarkPrefix) - 1);
    const pinned = isStoryViewportPinned(state);
    const promptHint = state.toast !== null && pinned
      ? state.toast
      : state.bookmark.choosingLabel
        ? `label ‹ ${selected} › · ←→ picks · enter saves · esc cancels${state.bookmark.existing ? " · d deletes" : ""}`
        : "enter chooses label · esc cancels";
    return { lines: [
      rule,
      [segment(indent), segment(bookmarkPrefix, "accent · deep"), segment(truncateTail(state.bookmark.name, nameWidth), "streaming"), segment(state.bookmark.choosingLabel ? "" : "▌", "focus / accent")],
      [segment(indent), segment(promptHint, state.toast !== null && pinned ? "focus / accent" : "chrome")]
    ], scrollTop: state.composerScrollTop };
  }
  if (state.mode !== "COMPOSE") {
    const hintBudget = Math.max(8, measure - 3);
    const hint = navHint(state, view, hintBudget);
    // The hint shares the prose measure — long seam hints must clip, not bleed.
    return { lines: [[segment(indent), segment("›", "accent · deep"), segment("  "), ...fitLine(hint, hintBudget)]], scrollTop: state.composerScrollTop };
  }
  const composer = renderComposerLayout({
    composer: state.composer,
    terminalWidth: width,
    terminalHeight: height,
    measure,
    indent,
    composeMaxHeight: state.config.composeMaxHeight,
    directingPart: composerPartNumber(state, view),
    caret: state.stream === null ? "focused" : "streaming",
    footerNotice: composerFooterNotice(state),
    retaking: state.retakePrompt !== null,
    scrollTop: state.composerScrollTop,
    focusDim: state.config.composeFocus === "on",
    narrow
  });
  return { lines: composer.lines, scrollTop: composer.scrollTop };
}

/** The contextual NAV hint under the story: what this focus can do next. */
function navHint(
  state: StoryScreenState,
  view: StoryViewModel,
  budget: number
): FrameLine {
  if (state.toast !== null && isStoryViewportPinned(state)) {
    return [segment(state.toast, "focus / accent")];
  }
  if (state.connection.down) {
    const lead: FrameLine = [segment("connection offline · reading · overlays remain available", "chrome")];
    const suffix: FrameLine = [segment(" · ", "chrome"), actionHint("R retries", "retry")];
    return [
      ...fitLine(lead, Math.min(visibleWidth(plainLine(lead)),
        Math.max(0, budget - visibleWidth(plainLine(suffix))))),
      ...suffix
    ];
  }
  return joinHints(navHintItems(state, view), budget);
}

/** Array order is reading order; rank is drop order, and the two are
 * independent. Rank 0 survives while anything survives, then the highest rank
 * goes first. Ranks are unique per branch — two items sharing one would leave
 * which of them sheds up to the scan rather than to this table. */
function navHintItems(state: StoryScreenState, view: StoryViewModel): HintItem[] {
  const row = view.rows[state.focusIndex];
  if (row?.kind === "chapter-summary") {
    return [
      hintItem([actionHint("enter expands", "compose")]),
      hintItem([actionHint("e edits", "edit")]),
      hintItem([actionHint("r refreshes", "regenerate")], 1),
      hintItem([actionHint("c chapters", "open-chapters")], 2),
      hintItem([actionHint("? keys", "open-keys")], 3)
    ];
  }
  if (row?.kind === "chapter-divider") {
    return [
      hintItem([actionHint("e renames", "edit")]),
      hintItem([actionHint("d removes", "prune")]),
      hintItem([actionHint("r summarizes above", "regenerate")], 1),
      hintItem([actionHint("c chapters", "open-chapters")], 2)
    ];
  }
  const focused = rowPart(view, state.focusIndex);
  const onSeam = focused !== null && focused.pathIndex < state.payload.path.length - 1 && state.stream === null;
  if (onSeam) {
    return [
      hintItem([actionHint(`space continues ¶ ${focused.number}`, "continue")]),
      hintItem([actionHint("enter direct", "compose")]),
      hintItem([actionHint("G leaf", "leaf")], 1),
      hintItem([actionHint("n new story", "new-item")], 3),
      hintItem([actionHint("? keys", "open-keys")], 2)
    ];
  }
  const leafBreak = focused !== null && focused.pathIndex === state.payload.path.length - 1
    && state.payload.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === focused.id);
  if (leafBreak) {
    // The notice leads, but it is also the longest thing here and the only
    // item that names no key — so it is the first of these to yield its cells.
    return [
      hintItem([segment(`next part opens chapter ${chapterWord(focused.chapterNumber + 1).toLowerCase()}`, "chrome")], 3),
      hintItem([actionHint("space continues", "continue")]),
      hintItem([actionHint("c chapters", "open-chapters")], 1),
      hintItem([actionHint("n new story", "new-item")], 2)
    ];
  }
  // No `←→ flips takes` here: the focused part's own `‹ take j/m ›` carries
  // that affordance where it applies, with the arrows as click targets.
  return [
    hintItem([actionHint("space continues", "continue")]),
    hintItem([actionHint("enter directs", "compose")]),
    hintItem([actionHint("n new story", "new-item")], 2),
    hintItem([actionHint("m map", "open-map")], 3),
    hintItem([actionHint("? keys", "open-keys")], 1)
  ];
}

function renderFullscreenComposer(
  state: StoryScreenState,
  view: StoryViewModel,
  width: number,
  height: number,
  estimate: NextRequestEstimate,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const composer = renderComposerLayout({
    composer: state.composer,
    terminalWidth: width,
    terminalHeight: height,
    measure: width,
    composeMaxHeight: state.config.composeMaxHeight,
    directingPart: composerPartNumber(state, view),
    caret: state.stream === null ? "focused" : "streaming",
    footerNotice: composerFooterNotice(state),
    retaking: state.retakePrompt !== null,
    scrollTop: state.composerScrollTop,
    focusDim: state.config.composeFocus === "on",
    narrow: width < 100
  });
  const lines = [...composer.lines, renderStoryStatus(state, view, width, width < 100, estimate)]
    .slice(0, height)
    .map((line) => fitLine(line, width));
  const hitRows: HitRows = Array.from({ length: height }, (_, row): HitRow | null => row < height - 1
    ? { target: { kind: "composer" }, left: 0, right: width }
    : null);
  // The fullscreen field draws the same footer keys the inline one does, so it
  // harvests them the same way. Without this they were painted controls that
  // answered nothing. Settings-row cells stay NAV-only, as on the page.
  addInlineHits(lines, hitRows, (target) => target.kind !== "settings-row");
  const panels = renderPanels(lines, state, hitRows, width, height, estimate, deadlines);
  const presentedLines = panels.lines;
  return {
    lines: presentedLines,
    selectable: panels.selectable,
    derived: {
      hitRows,
      viewScroll: state.viewScroll,
      viewScrollDelta: state.viewScrollDelta,
      lastViewportStart: state.lastViewportStart,
      composerScrollTop: composer.scrollTop,
      editorScrollTop: state.editorScrollTop,
      keysScrollTop: state.keysScrollTop,
      composerSelectionProjection: buildComposerSelectionProjection(presentedLines, width),
      storySelectionProjection: null,
      map: state.map
    }
  };
}

function renderInlineEditor(
  state: StoryScreenState,
  view: StoryViewModel,
  width: number,
  height: number,
  estimate: NextRequestEstimate,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const editor = state.editor!;
  const layout = renderComposerLayout({
    composer: editor.composer,
    terminalWidth: width,
    terminalHeight: height,
    measure: width,
    title: editor.title,
    footerHints: "shift+arrows select · ctrl+c/v · ctrl+s save · esc cancel",
    placeholder: editor.placeholder,
    footerNotice: state.toast ?? editor.conflict?.message ?? null,
    scrollTop: state.editorScrollTop,
    narrow: width < 100,
    softWrap: true
  });
  const base = [...layout.lines, renderStoryStatus(state, view, width, width < 100, estimate)]
    .slice(0, height)
    .map((line) => fitLine(line, width));
  const hitRows: HitRows = Array.from({ length: height }, (_, row): HitRow | null => row < height - 1
    ? { target: { kind: "composer" }, left: 0, right: width }
    : null);
  const lines = state.connection.down
    ? renderConnectionBanner(base, { ...state, hitRows }, width, deadlines)
    : base;
  return {
    lines,
    selectable: null,
    derived: {
      hitRows,
      viewScroll: state.viewScroll,
      viewScrollDelta: state.viewScrollDelta,
      lastViewportStart: state.lastViewportStart,
      composerScrollTop: state.composerScrollTop,
      editorScrollTop: layout.scrollTop,
      keysScrollTop: state.keysScrollTop,
      composerSelectionProjection: buildComposerSelectionProjection(lines, width),
      storySelectionProjection: null,
      map: state.map
    }
  };
}

/** Prose the writer must read, never a keymap: the footer's own keys stay
 * structured segments so every one of them answers a click. */
function composerFooterNotice(state: StoryScreenState): string | null {
  return state.toast;
}

function composerPartNumber(state: StoryScreenState, view: StoryViewModel): number | null {
  const index = state.retakePrompt === null
    ? state.focusIndex
    : rowIndexForNode(view, state.retakePrompt.nodeId);
  return rowPart(view, index)?.number ?? null;
}

function renderStoryStatus(
  state: StoryScreenState,
  view: StoryViewModel,
  width: number,
  narrow: boolean,
  estimate: NextRequestEstimate
): FrameLine {
  const status = renderCanonicalStatus(state, view, width, narrow, estimate);
  if (state.mode !== "COMPOSE" || state.retakePrompt === null) return status;
  const [modeBlock, ...rest] = status;
  if (modeBlock === undefined || modeBlock.role !== "background" || !modeBlock.text.includes("COMPOSE")) {
    return status;
  }
  return [{ ...modeBlock, text: modeBlock.text.replace("COMPOSE", "RETAKE") }, ...rest];
}

function actionHint(text: string, action: KeyAction, role: DisplayRole = "chrome"): FrameSegment {
  return segment(text, role, { kind: "inline-action", action });
}

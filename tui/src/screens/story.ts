import { STARTER_LOGO_TEXT } from "../../../shared/starter-vault.js";
import {
  authorsNoteWarning,
  MAX_AUTHORS_NOTE_CHARS,
  MAX_AUTHORS_NOTE_DEPTH
} from "../../../shared/authors-note.js";
import { unicodeScalarLength } from "../../../shared/unicode.js";
import { TAG_STATUSES } from "../../../shared/types.js";
import type { FrameDeadlineCollector } from "../animation-deadline.js";
import { tagStatusChoice } from "../tag-presentation.js";
import { chapterWord } from "../chapter-model.js";
import type { KeyAction } from "../keys.js";
import {
  createStoryViewModel,
  rowIndexForNode,
  rowPart,
  type StoryViewModel
} from "../model.js";
import { buildRailModel } from "../rail.js";
import {
  projectNextRequest,
  promptProjectionIdentity,
  sameProjectionIdentity,
  type ProjectedNextRequest
} from "../request-context.js";
import { nextRequestEstimate, type NextRequestEstimate } from "../request-projection.js";
import type { PromptTokenCount } from "../../../shared/tokenize-source.js";
import { estimateResponseGrowthTokens } from "../response-growth-estimate.js";
import type { HitRow, HitRows, HitTarget } from "../hit.js";
import type {
  DocumentEditorSession,
  StoryScreenState
} from "../state.js";
import { deriveStoryFrameLayout, type StoryFrameLayout } from "../story-frame-layout.js";
import { createWrapCache, type ProseStyle, type WrapCache } from "../wrap.js";
import { renderFactsRail } from "./story/facts-rail.js";
import { renderFactEditorLayout } from "./story/fact-editor-layout.js";
import { writingPromptEditorStatus } from "../settings-prompt-editor.js";
import { spliceDraftImageRows } from "./story/draft-image-rows.js";
import { draftImagesFor } from "../draft-image.js";
import { dimPage, panelHorizontalGeometry, placePanel, raisedSegment } from "./overlay.js";
import { renderKeysOverlay } from "./keys-modal.js";
import { renderMapScreen } from "./map.js";
import { renderSearchScreen } from "./search.js";
import { renderRequestViewerScreen } from "./request-viewer.js";
import { renderTokenProbabilitiesScreen } from "./token-probabilities.js";
import { renderGenerationRecordViewerScreen } from "./generation-record-viewer.js";
import { renderLogScreen } from "./log.js";
import { wrapFeedback } from "./feedback-wrap.js";
import { renderPanels, renderTextActionsPanel } from "./panels.js";
import { renderConnectionBanner } from "./connection-banner.js";
import { renderAsideScreen } from "./story/aside-screen.js";
import { resolveStoryScreenRoute } from "./story-route.js";
import {
  fitLine,
  hintItem,
  joinHints,
  plainLine,
  segment,
  splitFrame,
  truncateTail,
  TYPING_CARET,
  visibleWidth,
  type DisplayRole,
  type FrameComposition,
  type FrameLine,
  type FrameSegment,
  type HintItem
} from "./story/frame.js";
import { addInlineHits } from "./story/hits.js";
import { partHasThought } from "../reasoning-model.js";
import { layoutStoryRow, renderChapterOneHeading, type StickyStoryPrompt } from "./story/row-layout.js";
import { paintStorySelection } from "./story/selection-highlight.js";
import { stickStoryGutters, type OwnedStickyGutter } from "./story/sticky-gutter.js";
import { stickStoryPrompt } from "./story/sticky-prompt.js";
import {
  applyComposePageMode,
  renderComposerLayout,
  type ComposerLayout
} from "./story/composer.js";
import { storyProseMeasure, STORY_GUTTER } from "../composer-geometry.js";
import type { ComposerStatus as ComposerChromeStatus } from "./story/composer-chrome.js";
import { renderStatus as renderCanonicalStatus } from "./story/status.js";
import { viewportLines, type ViewportBlock } from "./story/viewport.js";
import {
  PLACEMENT_PLACING_KEYLINE,
  placementInputLocked,
  placementOutcomeUnknown
} from "../aside-placement.js";
import {
  placementEnterPlaceRowId,
  placementFocusBlockId,
  placementLeafGapBlock,
  placementMarkerAfterRow
} from "./story/placement-marker.js";
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
  request: StoryScreenState["request"];
  record: StoryScreenState["record"];
}

export interface StoryScreenFrame extends FrameComposition {
  derived: StoryScreenDerived;
}

const DEFAULT_CACHE = createWrapCache<ProseStyle>();

/** The lane's stored answer (see prompt-token-count.ts), trusted only while it
 *  still describes this frame: the same route, so it cannot be a count the
 *  previous connection gave, and the same projection inputs, so it cannot
 *  describe prose that has since changed. Either mismatch falls back to null,
 *  which every reader treats as the plain client estimate. Costs a handful of
 *  reference comparisons — it never hashes or re-counts anything. */
function effectivePromptTokenCount(
  state: StoryScreenState,
  projected: ProjectedNextRequest
): PromptTokenCount | null {
  const record = state.promptTokenCount;
  if (record === null
    || record.route !== state.generationRoute
    || !sameProjectionIdentity(
      record.identity,
      promptProjectionIdentity(state, projected.context)
    )) return null;
  return record.count;
}

export function renderStoryScreen(state: StoryScreenState, options: StoryScreenOptions): StoryScreenFrame {
  const { height } = options;
  const route = resolveStoryScreenRoute(state);
  if (route.kind === "log") return renderLog(state, options.width, height, options.deadlines);
  if (route.kind === "search") {
    return renderSearch(state, route.search, options.width, height, options.deadlines);
  }
  if (route.kind === "map") {
    return renderMap(state, route.map, options.width, height, options.deadlines);
  }
  if (route.kind === "record") {
    return renderGenerationRecordViewerScreen(state, route.record, options.width, height, options.deadlines);
  }
  const view = createStoryViewModel(state.payload, state.stream);
  const projectedRequest = projectNextRequest(state, view);
  const estimate = nextRequestEstimate(projectedRequest.payload, projectedRequest.context);
  const promptTokenCount = effectivePromptTokenCount(state, projectedRequest);
  if (route.kind === "request") {
    return renderRequestViewerScreen(
      state, route.request, projectedRequest.context,
      estimate, options.width, height, options.deadlines, promptTokenCount
    );
  }
  if (route.kind === "probs") {
    return renderTokenProbabilitiesScreen(
      state, route.probs, estimate, options.width, height, options.deadlines
    );
  }
  if (route.kind === "aside") {
    return renderAsideScreen(state, route.aside, options.width, height, options.deadlines);
  }
  if (route.kind === "editor") {
    return renderInlineEditor(
      state,
      view,
      route.editor,
      options.width,
      height,
      estimate,
      options.deadlines
    );
  }
  if (route.kind === "fullscreen-composer") {
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
  const stickyGutters: OwnedStickyGutter[] = [];
  const stickyPrompts = new Map<number, StickyStoryPrompt>();
  if (view.chapters.length > 1) {
    blocks.push({
      partId: "chapter-one-heading", partIndex: -1,
      height: 2,
      render: () => [...renderChapterOneHeading(view, measure, narrow), []]
    });
  }
  for (const [rowIndex, row] of rows.entries()) {
    const layout = layoutStoryRow(row, rowIndex, parts, state, measure, narrow, cache, options.deadlines);
    if (layout.stickyGutter !== null) {
      stickyGutters.push({
        rowIndex,
        partHeight: layout.height,
        gutter: layout.stickyGutter
      });
    }
    if (layout.stickyPrompt !== null) {
      stickyPrompts.set(rowIndex, layout.stickyPrompt);
    }
    blocks.push({
      partId: row.id,
      partIndex: rowIndex,
      height: layout.height + 1,
      render: () => [...layout.render(), []]
    });
    const placementMarker = placementMarkerAfterRow(
      state.placement,
      row,
      view,
      measure
    );
    if (placementMarker !== null) blocks.push(placementMarker);
  }
  // After chapter summary/divider rows that follow the active leaf.
  const leafGapMarker = placementLeafGapBlock(state.placement, view, measure);
  if (leafGapMarker !== null) blocks.push(leafGapMarker);

  const composer = renderPageComposer(state, view, width, measure, narrow, height);
  const composerLines = composer.lines;
  const composerRows = composerLines.length;
  const contentHeight = Math.max(1, height - composerRows - 1);
  // Generation moves focus to its target when the stream opens. Later user
  // navigation owns the same semantic focus, so rendering needs no second
  // auto-follow flag that can drift from the reducer state.
  // Placement keeps the selected destination marker in view by focusing its
  // synthetic block id rather than only the related Part.
  const placementFocus = state.mode === "PLACE" && state.placement !== null
    ? placementFocusBlockId(state.placement)
    : null;
  const focusId = options.viewportAnchorId
    ?? placementFocus
    ?? rows[state.focusIndex]?.id
    ?? rows[0]?.id
    ?? null;
  const focusAtStarterIntro = options.viewportAnchorId === undefined
    && state.focusIndex === 0
    && rowPart(view, state.focusIndex)?.node.text.startsWith(`${STARTER_LOGO_TEXT}\n\n`) === true;
  const viewport = viewportLines(
    blocks,
    focusId,
    contentHeight,
    state.typewriter,
    state.viewScroll,
    state.viewScrollDelta,
    focusAtStarterIntro
  );
  const visibleBody = stickStoryPrompt(
    stickStoryGutters(
      viewport.lines,
      viewport.owners,
      viewport.blockRows,
      stickyGutters,
      width
    ),
    viewport.owners,
    viewport.blockRows,
    stickyPrompts,
    narrow,
    width
  );
  const pad = contentHeight - visibleBody.length;
  // The status bar is frame chrome, not page content: with a rail present it
  // spans the whole terminal, so the split surface is everything above it. It
  // still stops at the rail's outer margin, which keeps the frame off the
  // terminal's right edge.
  const surfaceRows = Math.max(0, height - 1);
  const status = fitLine(
    renderStoryStatus(
      state,
      view,
      frameLayout.railRight ?? frameLayout.fullWidth,
      narrow,
      estimate,
      options.deadlines
    ),
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
    // Once output starts, remaining generation size is unknown. Keep the
    // projected request live, but withhold a growth forecast until idle.
    // Retake projection already excludes the replaced target, so growth is the
    // likely generation size — never that size minus a target already dropped.
    const growthTokens = state.stream === null
      ? estimateResponseGrowthTokens({
        payload: state.payload,
        maxOutputTokens: state.maxTokens,
        requestTokens: estimate.tokens,
        contextWindow: state.contextWindow
      })
      : 0;
    // Compose focus maps both growth pulse roles to chrome, so a pulse
    // deadline would only force invisible repaints. Own the skip here where
    // the dim is decided; the meter still owns deadline registration.
    const growthPulse = !(state.mode === "COMPOSE" && state.config.composeFocus === "on");
    lines = renderFactsRail(lines,
      buildRailModel(
        state.payload, focusedText, state.contextWindow, estimate, growthTokens, state.maxTokens,
        promptTokenCount
      ),
      hitRows, surfaceRows, frameLayout, state.contextMeterExpanded, state.now, options.deadlines,
      growthPulse);
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
  // The part-actions menu and the command palette each bind their own
  // captured selection; paint whichever one is open so the writer can see
  // exactly what a rewrite would touch.
  const menuSelection = state.actions?.selectionSpans;
  const paletteSelection = state.mode === "COMMANDS" ? state.commands?.selection?.spans : undefined;
  const highlightSpans = menuSelection !== undefined && menuSelection.length > 0
    ? menuSelection
    : paletteSelection;
  if (highlightSpans !== undefined && highlightSpans.length > 0) {
    lines = paintStorySelection(lines, highlightSpans);
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
      composerSelectionProjection: state.mode === "SETTINGS"
        && (state.settings?.edit != null || state.settings?.sampling?.edit != null)
        ? buildComposerSelectionProjection(presentedLines, full)
        : state.mode === "COMPOSE"
          ? buildComposerSelectionProjection(pageSelectionLines, frameLayout.pageWidth)
          : null,
      storySelectionProjection: state.mode === "NAV"
        ? buildStorySelectionProjection(pageSelectionLines, frameLayout.pageWidth)
        : null,
      map: state.map,
      request: state.request,
      record: state.record
    }
  };
}

function fullBleedDerived(
  state: StoryScreenState,
  hitRows: HitRows,
  map: StoryScreenState["map"]
): StoryScreenDerived {
  return {
    hitRows,
    viewScroll: state.viewScroll,
    viewScrollDelta: state.viewScrollDelta,
    lastViewportStart: state.lastViewportStart,
    composerScrollTop: state.composerScrollTop,
    editorScrollTop: state.editorScrollTop,
    keysScrollTop: state.keysScrollTop,
    composerSelectionProjection: null,
    storySelectionProjection: null,
    map,
    request: state.request,
    record: state.record
  };
}

/** Search takes the map's full-bleed shell: a query is answered by travelling
 *  somewhere, so it can never be a panel floating over the page it will leave. */
/** C-37 is a full-bleed surface, so it takes the same shell the map and search
 *  take — including the banner, which outranks every surface. */
function renderLog(
  state: StoryScreenState,
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const hitRows: HitRows = Array.from({ length: height }, () => null);
  const frame = renderLogScreen(state, state.notices, width, height, hitRows);
  const lines = state.connection.down
    ? renderConnectionBanner(frame.lines, { ...state, hitRows }, width, deadlines)
    : frame.lines;
  return {
    lines,
    selectable: frame.selectable,
    derived: fullBleedDerived(state, hitRows, state.map)
  };
}

function renderSearch(
  state: StoryScreenState,
  search: StoryScreenState["search"] & {},
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const hitRows: HitRows = Array.from({ length: height }, () => null);
  const frame = renderSearchScreen(state, search, width, height, hitRows);
  // The banner counts down to the next retry, so it needs the frame deadline
  // collector here exactly as it does over the map.
  const lines = state.connection.down
    ? renderConnectionBanner(frame.lines, { ...state, hitRows }, width, deadlines)
    : frame.lines;
  return {
    lines,
    selectable: frame.selectable,
    derived: fullBleedDerived(state, hitRows, state.map)
  };
}

function renderMap(
  state: StoryScreenState,
  mapState: StoryScreenState["map"] & {},
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const hitRows: HitRows = Array.from({ length: height }, () => null);
  const frame = renderMapScreen(state, mapState, width, height, hitRows, deadlines);
  const map = {
    ...mapState,
    rowIds: frame.derived.rowIds,
    pathCursorId: frame.derived.pathCursorId,
    treeCursorId: frame.derived.treeCursorId,
    openedColdFolds: new Set(mapState.openedColdFolds)
  };
  const tag = state.mode === "TAG" && state.tag !== null
    ? renderMapTag(frame.lines, state, hitRows, width, height)
    : null;
  const lines = state.connection.down
    ? renderConnectionBanner(tag?.lines ?? frame.lines, { ...state, hitRows }, width, deadlines)
    : tag?.lines ?? frame.lines;
  return {
    lines,
    selectable: tag?.selectable ?? frame.selectable,
    derived: fullBleedDerived(state, hitRows, map)
  };
}

function renderMapTag(
  base: FrameLine[],
  state: StoryScreenState,
  hitRows: HitRows,
  width: number,
  height: number
): FrameComposition {
  const prompt = state.tag!;
  const selected = tagStatusChoice(TAG_STATUSES[prompt.statusIndex] ?? "");
  const namePrefix = "  Name  ";
  const nameWidth = Math.max(
    0,
    panelHorizontalGeometry(width, 64).contentWidth - visibleWidth(namePrefix) - 1
  );
  const input: FrameLine = [
    raisedSegment(namePrefix, "chrome"),
    raisedSegment(truncateTail(prompt.name, nameWidth), "streaming"),
    ...(prompt.choosingStatus ? [] : [{
      text: " ", role: "background" as const, background: "focus / accent" as const
    }])
  ];
  const content: FrameLine[] = [input, [], [
    raisedSegment("  Status  ", "chrome"),
    raisedSegment(`‹ ${selected} ›`, prompt.choosingStatus ? "focus / accent" : "prose · dim")
  ]];
  const footer = prompt.choosingStatus
    ? `←→ status · enter save · esc cancel${prompt.existing ? prompt.deleteArmed ? " · D confirms · esc keeps" : " · D delete" : ""}`
    : "enter choose status · esc cancel";
  return placePanel(dimPage(base), "tag line", content, footer, width, height, 64, {
    rows: hitRows,
    targets: content.map(() => null)
  });
}

function renderPageComposer(state: StoryScreenState, view: StoryViewModel, width: number, measure: number, narrow: boolean, height: number): { lines: FrameLine[]; scrollTop: number } {
  const indent = narrow ? "  " : " ".repeat(STORY_GUTTER);
  const rule = [segment(indent), segment("─".repeat(measure), "chrome")];
  if (state.mode === "TAG" && state.tag !== null) {
    const selected = tagStatusChoice(TAG_STATUSES[state.tag.statusIndex] ?? "");
    const tagPrefix = "› tag ";
    const nameWidth = Math.max(0, measure - visibleWidth(tagPrefix) - 1);
    const promptHint = state.toast !== null
      ? state.toast
      : state.tag.choosingStatus
        ? `status ‹ ${selected} › · ←→ picks · enter saves · esc cancels${state.tag.existing ? state.tag.deleteArmed ? " · D confirms · esc keeps" : " · D deletes" : ""}`
        : "enter chooses status · esc cancels";
    return { lines: [
      rule,
      [segment(indent), segment(tagPrefix, "accent · deep"), segment(truncateTail(state.tag.name, nameWidth), "streaming"), segment(state.tag.choosingStatus ? "" : TYPING_CARET, "focus / accent")],
      [segment(indent), segment(promptHint, state.toast !== null ? "focus / accent" : "chrome")]
    ], scrollTop: state.composerScrollTop };
  }
  if (state.mode !== "COMPOSE") {
    const hintBudget = Math.max(8, measure - 3);
    // Decision 24: a toast wraps into a 2-col hanging indent under its own
    // first character rather than clipping to one row, because the tail of a
    // toast is the undo key. Everything else still gets exactly one line.
    if (state.toast !== null) {
      // Continuation rows hang two cells in under the message's first
      // character, so the wrap measures against what they actually get.
      const wrapped = wrapFeedback(
        state.toast, Math.max(8, hintBudget - TOAST_HANGING_INDENT), TOAST_ROW_CAP, "! full"
      );
      return {
        lines: wrapped.rows.map((row, index): FrameLine => [
          segment(indent),
          index === 0
            ? segment("›", "accent · deep")
            : segment(" "),
          segment(index === 0 ? "  " : "    "),
          ...fitLine([segment(row, "focus / accent")], hintBudget)
        ]),
        scrollTop: state.composerScrollTop
      };
    }
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
    promptKind: state.retakePrompt?.intent.kind ?? null,
    scrollTop: state.composerScrollTop,
    focusDim: state.config.composeFocus === "on",
    narrow,
    softWrap: state.config.wordWrap === "on"
  });
  const withImages = spliceDraftImageRows(composer, draftImagesFor(state.composer), indent);
  return { lines: withImages.lines, scrollTop: withImages.scrollTop };
}

/** Decision 24 caps a toast at four wrapped rows; the gutter gives 22 usable
 * cells and the hint line is wider, but the cap is the message's, not the
 * measure's. Past it the body truncates and `!` opens the whole thing. */
const TOAST_ROW_CAP = 4;
/** Decision 24's hanging indent, under the message's first character. */
const TOAST_HANGING_INDENT = 2;

/** The contextual NAV hint under the story: what this focus can do next.
 *
 * A toast takes this line whatever the viewport is doing. The alternative was
 * printing it under the focused part, which puts a message about the app inside
 * the manuscript, reflows two lines of prose to do it, and lands somewhere new
 * every time focus moves. One fixed line costs the hint for a moment, and the
 * hint comes back. */
function navHint(
  state: StoryScreenState,
  view: StoryViewModel,
  budget: number
): FrameLine {
  if (state.connection.down) {
    const lead: FrameLine = [segment("connection offline · reading · overlays remain available", "chrome")];
    const suffix: FrameLine = [segment(" · ", "chrome"), actionHint("R retries", "retry")];
    return [
      ...fitLine(lead, Math.min(visibleWidth(plainLine(lead)),
        Math.max(0, budget - visibleWidth(plainLine(suffix))))),
      ...suffix
    ];
  }
  if (state.mode === "PLACE" && state.placement !== null) {
    // Esc/arrows/Enter are ignored only while this Placement owns createNode.
    if (placementInputLocked(state)) {
      return fitLine([segment(` ${PLACEMENT_PLACING_KEYLINE}`, "chrome")], budget);
    }
    // Uncertain outcome: no Enter place until recovery settles the first node.
    if (placementOutcomeUnknown(state)) {
      return joinHints([
        hintItem([actionHint("Up/Down where", "focus-next")]),
        hintItem([actionHint("Esc back to Aside", "cancel")], 1)
      ], budget);
    }
    // Stamp Enter place with session + stop so a queued Up/Down or a later
    // Placement open at the same stop cannot createNode against the wrong work.
    const placeStopId = placementEnterPlaceRowId(state.placement) ?? undefined;
    return joinHints([
      hintItem([actionHint("Up/Down where", "focus-next")]),
      hintItem([actionHint("Enter place", "apply", "chrome", placeStopId)]),
      hintItem([actionHint("Esc back to Aside", "cancel")], 1)
    ], budget);
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
      hintItem([actionHint("D removes", "prune")]),
      hintItem([actionHint("r summarizes above", "regenerate")], 1),
      hintItem([actionHint("c chapters", "open-chapters")], 2)
    ];
  }
  const focused = rowPart(view, state.focusIndex);
  // The one keyline affordance for a thought — present only when the
  // focused part actually has one to fold or unfold, live or stored (see
  // `partHasThought`). At 80 columns the gutter waymark disappears entirely
  // (`prefixLine` drops every gutter cell in narrow mode); this is what
  // keeps the feature discoverable there. Rank 1, the same tier "? keys"
  // already holds in every branch below: low enough to outlast the
  // lowest-priority item or two, without claiming rank 0's "never drops
  // first" tier from the branch's own primary read/write verbs.
  const thoughtHint = focused !== null && state.reasoning !== "off" && partHasThought(focused, state)
    ? hintItem([actionHint("T thought", "toggle-thought")], 1)
    : null;
  const withThoughtHint = (items: HintItem[]): HintItem[] =>
    thoughtHint === null ? items : [...items, thoughtHint];
  const onSeam = focused !== null && focused.pathIndex < state.payload.path.length - 1 && state.stream === null;
  if (onSeam) {
    return withThoughtHint([
      hintItem([actionHint(`space continues ¶ ${focused.number}`, "continue")]),
      hintItem([actionHint("enter direct", "compose")]),
      hintItem([actionHint("G leaf", "leaf")], 4),
      hintItem([actionHint("a aside", "open-aside")], 2),
      hintItem([actionHint("n note", "open-authors-note")], 3),
      hintItem([actionHint("? keys", "open-keys")], 1)
    ]);
  }
  const leafBreak = focused !== null && focused.pathIndex === state.payload.path.length - 1
    && state.payload.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === focused.id);
  if (leafBreak) {
    // The notice leads, but it is also the longest thing here and the only
    // item that names no key — so it is the first of these to yield its cells.
    return withThoughtHint([
      hintItem([segment(`next part opens chapter ${chapterWord(focused.chapterNumber + 1).toLowerCase()}`, "chrome")], 3),
      hintItem([actionHint("space continues", "continue")]),
      hintItem([actionHint("c chapters", "open-chapters")], 1),
      hintItem([actionHint("a aside", "open-aside")], 2),
      hintItem([actionHint("n note", "open-authors-note")], 4)
    ]);
  }
  // No `←→ flips takes` here: the focused part's own `‹ take j/m ›` carries
  // that affordance where it applies, with the arrows as click targets.
  return withThoughtHint([
    hintItem([actionHint("space continues", "continue")]),
    hintItem([actionHint("enter directs", "compose")]),
    hintItem([actionHint("a aside", "open-aside")], 2),
    hintItem([actionHint("n note", "open-authors-note")], 3),
    hintItem([actionHint("m map", "open-map")], 4),
    hintItem([actionHint("? keys", "open-keys")], 1)
  ]);
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
    promptKind: state.retakePrompt?.intent.kind ?? null,
    scrollTop: state.composerScrollTop,
    focusDim: state.config.composeFocus === "on",
    narrow: width < 100,
    softWrap: state.config.wordWrap === "on"
  });
  const withImages = spliceDraftImageRows(composer, draftImagesFor(state.composer), "");
  const lines = [...withImages.lines, renderStoryStatus(
    state, view, width, width < 100, estimate, deadlines
  )]
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
      map: state.map,
      request: state.request,
      record: state.record
    }
  };
}

function editorFooterHints(editor: DocumentEditorSession): string {
  if (editor.kind === "document"
    && editor.target.kind === "settings-prompt") {
    return "shift+arrows select · ctrl+c/x/v · ctrl+s keep draft · esc cancel";
  }
  // Part editors offer dual save; other targets and incomplete fixtures keep
  // the single-save footer (tests may stub a minimal session without target).
  if (editor.kind === "document" && editor.target.kind === "part") {
    // ctrl+o is the portable same-take chord; ctrl+shift+s is an alias where
    // the terminal reports modified keys.
    return "shift+arrows select · ctrl+c/x/v · ctrl+s new take · ctrl+o same take · esc cancel";
  }
  return "shift+arrows select · ctrl+c/x/v · ctrl+s save · esc cancel";
}

function renderInlineEditor(
  state: StoryScreenState,
  view: StoryViewModel,
  host: DocumentEditorSession,
  width: number,
  height: number,
  estimate: NextRequestEstimate,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const editorConflict = host.kind === "document"
    && host.target.kind === "settings-prompt"
    ? host.target.owner.conflict?.message
    : host.conflict?.message;
  const footerNotice = state.toast ?? editorConflict ?? null;
  const status = authorNoteStatus(host, width) ?? writingPromptEditorStatus(host, width);
  const layout = host.kind === "fact"
    ? renderFactEditorLayout(host, {
        width,
        height,
        footerNotice,
        scrollTop: state.editorScrollTop,
        followCursor: state.editorScrollDetached !== true,
        narrow: width < 100,
        softWrap: state.config.wordWrap === "on"
      })
    : renderComposerLayout({
        composer: host.composer,
        fullscreen: true,
        terminalWidth: width,
        terminalHeight: height,
        measure: width,
        title: host.title,
        status,
        footerHints: editorFooterHints(host),
        placeholder: host.placeholder,
        footerNotice,
        scrollTop: state.editorScrollTop,
        narrow: width < 100,
        softWrap: state.config.wordWrap === "on"
      });
  return renderEditorLayoutFrame(state, view, width, height, estimate, layout, deadlines);
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

function authorNoteStatus(
  host: DocumentEditorSession,
  width: number
): ComposerChromeStatus | undefined {
  if (host.kind !== "document" || host.target.kind !== "authors-note") return undefined;
  const maxWidth = Math.max(1, width - visibleWidth(`┏━ ${host.title} `) - 1);
  if (unicodeScalarLength(host.composer.text, MAX_AUTHORS_NOTE_CHARS) > MAX_AUTHORS_NOTE_CHARS) {
    const text = [
      `· max is ${MAX_AUTHORS_NOTE_CHARS.toLocaleString("en-US")} Unicode scalar values`,
      `· max is ${MAX_AUTHORS_NOTE_CHARS.toLocaleString("en-US")} scalar values`,
      `· max is ${MAX_AUTHORS_NOTE_CHARS.toLocaleString("en-US")}`
    ].find((candidate) => [...candidate].length <= maxWidth)
      ?? `· max is ${MAX_AUTHORS_NOTE_CHARS.toLocaleString("en-US")}`;
    return { text, role: "danger text" };
  }
  const warning = authorsNoteWarning(host.composer.text, maxWidth);
  if (warning !== null) return { text: warning, role: "context warning" };
  const depthShort = `depth ${host.target.depth}/${MAX_AUTHORS_NOTE_DEPTH}`;
  const depthHint = `${depthShort} · ⌥-/= change`;
  const text = [depthHint, depthShort].find((candidate) => [...candidate].length <= maxWidth) ?? depthShort;
  return { text, role: "context note" };
}

function renderEditorLayoutFrame(
  state: StoryScreenState,
  view: StoryViewModel,
  width: number,
  height: number,
  estimate: NextRequestEstimate,
  layout: ComposerLayout,
  deadlines?: FrameDeadlineCollector
): StoryScreenFrame {
  const base = [...layout.lines, renderStoryStatus(
    state, view, width, width < 100, estimate, deadlines
  )]
    .slice(0, height)
    .map((line) => fitLine(line, width));
  const hitRows: HitRows = Array.from({ length: height }, (_, row): HitRow | null => row < height - 1
    ? { target: composerHitTarget(base[row]), left: 0, right: width }
    : null);
  const composition = state.textActions === null
    ? { lines: base, selectable: null }
    : renderTextActionsPanel(dimPage(base), { ...state, hitRows }, width, height);
  const lines = state.connection.down
    ? renderConnectionBanner(composition.lines, { ...state, hitRows }, width, deadlines)
    : composition.lines;
  return {
    lines,
    selectable: composition.selectable,
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
      map: state.map,
      request: state.request,
      record: state.record
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
  estimate: NextRequestEstimate,
  deadlines?: FrameDeadlineCollector
): FrameLine {
  const status = renderCanonicalStatus(state, view, width, narrow, estimate, deadlines);
  const prompt = state.mode === "COMPOSE" ? state.retakePrompt : null;
  if (prompt === null) return status;
  const [modeBlock, ...rest] = status;
  if (modeBlock === undefined || modeBlock.role !== "background" || !modeBlock.text.includes("COMPOSE")) {
    return status;
  }
  const label = prompt.intent.kind === "rewrite" ? "REWRITE" : "RETAKE";
  return [{ ...modeBlock, text: modeBlock.text.replace("COMPOSE", label) }, ...rest];
}

function actionHint(
  text: string,
  action: KeyAction,
  role: DisplayRole = "chrome",
  rowId?: string
): FrameSegment {
  return segment(text, role, {
    kind: "inline-action",
    action,
    ...(rowId === undefined ? {} : { rowId })
  });
}

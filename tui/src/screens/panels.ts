import type { StoryPayload, StorySummary } from "../../../shared/types.js";
import { nextAgeChange } from "../../../shared/story-model.js";
import type { FrameDeadlineCollector } from "../animation-deadline.js";
import { composerPosition, type ComposerState } from "../composer-model.js";
import {
  commandContext,
  commandPaletteModel,
  commandPaletteWindow,
  retainCommandSelection
} from "../command-model.js";
import {
  libraryAge,
  libraryRows,
  libraryTotals
} from "../library-model.js";
import { type HitRows, type HitTarget } from "../hit.js";
import type { KeyAction } from "../keys.js";
import { canRewriteSelection } from "../selection-projection.js";
import type { OverlayState, StoryScreenState, StreamView } from "../state.js";
import { currentPartActions } from "../story-actions.js";
import { generationBusy } from "../generation-action.js";
import { availableTextActions, TEXT_ACTIONS } from "../text-actions.js";
import { deriveSummaryProgress } from "../summary-model.js";
import { chapterDisplayTitle,
  chapterListModel, chapterWindow } from "../chapter-model.js";
import { createStoryViewModel, rowIndexForNode, rowPart } from "../model.js";
import { formatTokensScaled, formatTokensEstimate } from "../rail.js";
import type { RequestTokenEstimate } from "../request-projection.js";
import {
  dimPage,
  panelContentRows,
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "./overlay.js";
import { renderConnectionBanner } from "./connection-banner.js";
import { commandPaletteLine } from "./command-palette-line.js";
import { tagRole } from "./map-row-labels.js";
import {
  boundedContent,
  cellPad,
  cellPadStart,
  chapterColumns,
  libraryColumns,
  panelRange,
  panelRowWindow,
  type LibraryColumns
} from "./panel-table-layout.js";
import { truncate, truncateTail, visibleWidth, TYPING_CARET, type FrameComposition, type FrameLine } from "./story/frame.js";
import { renderComposerInput } from "./story/composer.js";
import { renderSettingsPanel } from "./settings-panel.js";
import { renderFactsPanel } from "./facts-panel.js";
import { renderSamplingPanel } from "./sampling-panel.js";
import { renderCardImportPanel } from "./card-import-panel.js";
import { renderArchiveImportPanel } from "./archive-import-panel.js";
import { renderProfileTransferPanel } from "./profile-transfer-panel.js";

export { SETTINGS_FOOTER_ACTIONS } from "./settings-panel-footers.js";
export { FACTS_FOOTER_ACTIONS } from "./facts-panel.js";

export const CHAPTERS_FOOTER_ACTIONS = [
  { token: "↵", action: "open-selected" }, { token: "s sum", action: "summarize-chapter" },
  { token: "e rename", action: "rename-item" }, { token: "n break", action: "new-item" },
  { token: "d", action: "delete-item" }, { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;
export const RENAME_FOOTER_ACTIONS = [
  { token: "↵", action: "open-selected" }, { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;
export const LIBRARY_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
  { token: "↵", action: "open-selected" }, { token: "n new", action: "new-item" },
  { token: "e rename", action: "rename-item" }, { token: "/ filter", action: "filter" },
  { token: "d delete", action: "delete-item" }, { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;
export const COMMANDS_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
  { token: "↵ run", action: "open-selected" },
  { token: "esc close", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;
export const ACTIONS_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
  { token: "↵ run", action: "apply" },
  { token: "esc close", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;
const TEXT_ACTIONS_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
  { token: "↵", action: "apply" }, { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;
export const TAGS_FOOTER_ACTIONS = [
  { token: "↑", action: "focus-previous" }, { token: "↓", action: "focus-next" },
  { token: "d delete", action: "delete-item" }, { token: "esc commands", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;
export const CARD_IMPORT_FOOTER_ACTIONS = [
  { token: "tab", action: "complete" }, { token: "↵", action: "apply" },
  { token: "esc", action: "cancel" }
] as const satisfies ReadonlyArray<{ token: string; action: KeyAction }>;
export const ARCHIVE_IMPORT_FOOTER_ACTIONS = CARD_IMPORT_FOOTER_ACTIONS;
type PanelState = Omit<OverlayState, "hitRows"> & {
  mode: StoryScreenState["mode"];
  tag: StoryScreenState["tag"];
  payload: StoryPayload;
  focusIndex: number;
  lineClipboard?: StoryScreenState["lineClipboard"];
  now: number;
  contextWindow?: number | null;
  stream: StreamView | null;
  abort: StoryScreenState["abort"];
};

type PanelRenderState = PanelState & { hitRows: HitRows; requestActive: boolean };

export function renderPanels(
  base: FrameLine[],
  state: PanelState,
  hitRows: HitRows,
  width: number,
  height: number,
  estimate: RequestTokenEstimate,
  deadlines?: FrameDeadlineCollector
): FrameComposition {
  const local: PanelRenderState = {
    ...state,
    hitRows,
    requestActive: generationBusy(state) || state.summary !== null
  };
  let composition: FrameComposition = { lines: base, selectable: null };
  if (state.archive !== null) {
    composition = renderArchiveImportPanel(
      dimPage(base), local, width, height, ARCHIVE_IMPORT_FOOTER_ACTIONS
    );
  }
  else if (local.settings !== null && local.settings.profileTransfer !== null) {
    composition = renderProfileTransferPanel(
      dimPage(base),
      local.settings.profileTransfer,
      local.hitRows,
      width,
      height
    );
  }
  else if (state.card !== null) {
    composition = renderCardImportPanel(
      dimPage(base), local, width, height, CARD_IMPORT_FOOTER_ACTIONS
    );
  }
  else if (state.actions != null) composition = renderActions(dimPage(base), local, width, height);
  else if (state.library !== null) composition = renderLibrary(dimPage(base), local, width, height, deadlines);
  else if (state.facts !== null) {
    composition = renderFactsPanel(dimPage(base), local, width, height, estimate);
  }
  else if (state.commands !== null) composition = renderCommands(dimPage(base), local, width, height);
  else if (state.chapters !== null) composition = renderChapters(dimPage(base), local, width, height, estimate);
  else if (state.settings?.sampling !== null && state.settings !== null) {
    composition = renderSamplingPanel(base, local, width, height);
  }
  else if (state.settings !== null) composition = renderSettingsPanel(base, local, width, height);
  else if (state.summary !== null) composition = renderSummary(dimPage(base), local, width, height);
  if (state.textActions !== null) {
    composition = renderTextActionsPanel(dimPage(composition.lines), local, width, height);
  }
  if (state.connection.down) {
    composition = { ...composition, lines: renderConnectionBanner(composition.lines, local, width, deadlines) };
  }
  return composition;
}

export function renderTextActionsPanel(
  base: FrameLine[],
  state: Pick<OverlayState, "textActions" | "hitRows">,
  width: number,
  height: number
): FrameComposition {
  const overlay = state.textActions!;
  const actions = availableTextActions(overlay);
  const contentWidth = panelHorizontalGeometry(width, 48).contentWidth;
  const leadWidth = Math.min(4, contentWidth);
  const widestName = Math.max(...TEXT_ACTIONS.map((action) => visibleWidth(action.name)));
  const nameWidth = Math.min(widestName + 2, Math.max(0, contentWidth - leadWidth));
  const descriptionWidth = Math.max(0, contentWidth - leadWidth - nameWidth);
  const content: FrameLine[] = actions.map((action, index): FrameLine => [
    raisedSegment(cellPad(index === overlay.cursor ? "  ▸ " : "", leadWidth),
      index === overlay.cursor ? "focus / accent" : "chrome"),
    raisedSegment(cellPad(truncate(action.name, nameWidth), nameWidth),
      index === overlay.cursor ? "prose" : "prose · dim"),
    raisedSegment(truncate(action.description, descriptionWidth), "chrome")
  ]);
  return placePanel(base, "edit actions", content,
    "↑ ↓ ↵ esc", width, height, 48,
    {
      rows: state.hitRows,
      targets: actions.map((_, index): HitTarget => ({ kind: "list", index })),
      footerActions: TEXT_ACTIONS_FOOTER_ACTIONS
    });
}

/** OpenCode-style part menu: right-click a part, or press x. */
function renderActions(
  base: FrameLine[],
  state: PanelRenderState,
  width: number,
  height: number
): FrameComposition {
  const overlay = state.actions!;
  const actions = currentPartActions(state);
  const view = createStoryViewModel(state.payload, state.stream);
  const part = rowPart(view, rowIndexForNode(view, overlay.partId));
  const contentWidth = panelHorizontalGeometry(width, 64).contentWidth;
  const leadWidth = Math.min(4, contentWidth);
  const widestName = Math.max(0, ...actions.map((action) => visibleWidth(action.name)));
  const nameWidth = Math.min(widestName + 2, Math.max(0, contentWidth - leadWidth));
  const descriptionWidth = Math.max(0, contentWidth - leadWidth - nameWidth);
  const content: FrameLine[] = actions.map((action, index): FrameLine => [
    raisedSegment(cellPad(index === overlay.cursor ? "  ▸ " : "", leadWidth),
      index === overlay.cursor ? "focus / accent" : "chrome"),
    raisedSegment(cellPad(truncate(action.name, nameWidth), nameWidth),
      index === overlay.cursor ? "prose" : "prose · dim"),
    raisedSegment(truncate(action.description, descriptionWidth), "chrome")
  ]);
  const title = part === null ? "¶ actions" : `¶ ${part.number} actions`;
  return placePanel(base, title, content,
    "↑↓ move · ↵ run · esc close", width, height, 64,
    { rows: state.hitRows, targets: actions.map((_, index): HitTarget => ({ kind: "list", index })),
      footerActions: ACTIONS_FOOTER_ACTIONS });
}

function renderChapters(
  base: FrameLine[],
  state: OverlayState & { payload: StoryPayload; hitRows: HitRows; contextWindow?: number | null },
  width: number,
  height: number,
  estimate: RequestTokenEstimate
): FrameComposition {
  const overlay = state.chapters!;
  const storyTitle = state.payload.title;
  const model = chapterListModel(state.payload, state.contextWindow ?? null, estimate);
  const contentWidth = panelHorizontalGeometry(width).contentWidth;
  // Chapter numbers are contiguous and one-based, so the final row owns the
  // widest label. Avoid passing a user-sized chapter list as function args.
  const chapterDigits = Math.max(2, String(model.rows.length).length);
  const columns = chapterColumns(contentWidth, chapterDigits);
  const content: FrameLine[] = [];
  const targets: Array<HitTarget | null> = [];
  if (overlay.rename !== null) {
    content.push(promptLine("chapter title", overlay.rename.value, contentWidth));
    targets.push(null);
  }
  // 13, not 11: the context status below costs two content rows. Under-reserving
  // overflows the panel, and placePanel clamps by dropping from the bottom —
  // which is exactly the status this panel moved inside to stop hiding.
  const rowBudget = Math.max(1, height - 13 - (overlay.rename === null ? 0 : 1));
  const window = chapterWindow(model.rows.length, overlay.cursor, rowBudget);
  const range = model.rows.length <= rowBudget ? "" : ` · ${window.start + 1}–${window.end}/${model.rows.length}`;
  content.push([
    raisedSegment(cellPad("", columns.lead), "chrome"),
    raisedSegment(cellPad("ch", columns.chapter), "chrome"),
    raisedSegment(cellPad(`title${range}`, columns.title), "chrome"),
    raisedSegment(cellPad("extent", columns.extent), "chrome"),
    raisedSegment(cellPad("context", columns.status), "chrome"),
    raisedSegment(cellPad("", columns.marker), "chrome")
  ]);
  targets.push(null);
  for (const [offset, row] of model.rows.slice(window.start, window.end).entries()) {
    const index = window.start + offset;
    const selected = index === overlay.cursor;
    const title = chapterDisplayTitle(row.chapter, storyTitle);
    const role = !row.sent ? "dimmed page" : row.stale ? "focus / accent" : selected ? "prose" : "prose · dim";
    content.push([
      raisedSegment(cellPad(selected ? "  ▸ " : "", columns.lead), selected ? "focus / accent" : "chrome"),
      raisedSegment(cellPadStart(String(row.chapter.number), Math.max(0, columns.chapter - 2)) + " ".repeat(Math.min(2, columns.chapter)), "chrome"),
      raisedSegment(cellPad(truncate(title, Math.max(0, columns.title - 1)), columns.title), role),
      raisedSegment(cellPad(row.extent, columns.extent), row.sent ? "chrome" : "dimmed page"),
      raisedSegment(cellPad(row.status, columns.status), role),
      raisedSegment(cellPad(row.biggestFix ? " [!]" : "", columns.marker), "focus / accent")
    ]);
    targets.push({ kind: "list", index });
  }
  if (model.rows.length === 0) {
    content.push([raisedSegment("  write a first part to begin Chapter One", "prose · dim")]);
    targets.push(null);
  }
  const windowLabel = model.contextWindow === null ? "?" : formatTokensScaled(model.contextWindow);
  const over = model.over > 0 ? ` · over ${formatTokensEstimate(model.over)}` : "";
  const fix = model.biggestUnsummarized === null ? "" : ` · [!] summarize ch ${model.biggestUnsummarized.number}`;
  // Context status is state, not keys, so it rides in the panel rather than the
  // footer. Prefixed to the footer it grew with `over`/`fix` and pushed the
  // trailing actions past the measure — truncating a key the footer advertises.
  content.push([], [
    raisedSegment(`  total ${formatTokensScaled(model.totalTokens)} / ${windowLabel}`, "chrome"),
    raisedSegment(over, over.length === 0 ? "chrome" : "danger text"),
    raisedSegment(fix, "accent · deep")
  ]);
  targets.push(null, null);
  const footer = overlay.rename !== null
    ? "↵ saves the title · esc keeps the old one"
    : overlay.deleteArmedId !== null
    ? "↵ jump · s sum · e rename · n break · d confirms · esc keeps"
    : width < 100
      ? "↵ jump · s sum · e rename · n break · d rm · esc"
      : "↵ jump · s summarize · e rename · n break · d remove · esc";
  return placePanel(base, `chapters · ${model.rows.length} on this storyline`, boundedContent(content, contentWidth),
    footer, width, height, 106, { rows: state.hitRows, targets,
      // Renaming accepts only save, cancel and text: advertising the other verbs
      // would register clicks its handler drops on the floor.
      footerActions: overlay.rename === null ? CHAPTERS_FOOTER_ACTIONS : RENAME_FOOTER_ACTIONS });
}

function renderLibrary(
  base: FrameLine[],
  state: OverlayState & { hitRows: HitRows; now: number },
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
): FrameComposition {
  const overlay = state.library!;
  const query = overlay.query;
  const rows = libraryRows(overlay.stories, query);
  const totals = libraryTotals(overlay.stories);
  const contentWidth = panelHorizontalGeometry(width).contentWidth;
  const columns = libraryColumns(contentWidth);
  const folder = state.storyFolder.length === 0 ? "" : ` · ${state.storyFolder}`;
  const content: FrameLine[] = [];
  // C-17: a filter always states `n of m`. Rename and delete prompts are not
  // filters and carry no count.
  const filterCount = `${rows.length} of ${overlay.stories.length}`;
  if (overlay.prompt?.kind === "rename") {
    content.push(renameLine(overlay.prompt.composer, contentWidth));
  }
  else if (overlay.prompt !== null) {
    content.push(promptLine(
      overlay.prompt.kind,
      overlay.prompt.kind === "filter" ? overlay.query : overlay.prompt.value,
      contentWidth,
      overlay.prompt.kind === "filter" ? filterCount : ""
    ));
  }
  else if (query.length > 0) content.push(promptLine("filter", query, contentWidth, filterCount));
  content.push([
    raisedSegment(cellPad("", columns.lead), "chrome"),
    raisedSegment(cellPad("title", columns.title), "chrome"),
    raisedSegment(cellPadStart("words", columns.words), "chrome"),
    raisedSegment(cellPad("  structure", columns.structure), "chrome"),
    ...(columns.updated === 0 ? [] : [raisedSegment(cellPad("updated", columns.updated), "chrome")])
  ]);
  const targets: Array<HitTarget | null> = content.map(() => null);
  const window = panelRowWindow(
    rows.map(() => 1),
    overlay.cursor,
    panelContentRows(height) - content.length
  );
  for (const [offset, story] of rows.slice(window.start, window.end).entries()) {
    const index = window.start + offset;
    targets.push({ kind: "list", index });
    content.push(libraryLine(story, index === overlay.cursor, columns, state.now, deadlines));
  }
  if (rows.length === 0) {
    // C-27 names the key that fixes it, and the empty store is a different
    // sentence from a filter that matched nothing.
    content.push([raisedSegment(overlay.stories.length === 0
      ? "  no stories yet · n starts one"
      : overlay.prompt?.kind === "filter"
        ? "  no story matches · backspace widens the filter"
        : "  no story matches · / reopens the filter", "prose · dim")]);
    targets.push(null);
  }
  const title = `library${folder} · ${totals.stories} stories · ${totals.words.toLocaleString("en-US")} words${panelRange(rows.length, window)}`;
  const prompting = overlay.prompt !== null;
  const footer = prompting ? "↵ apply · esc cancel" : "↑↓ move · ↵ open · n new · e rename · / filter · d delete · esc";
  return placePanel(base, title, boundedContent(content, contentWidth), footer, width, height, 106,
    { rows: state.hitRows, targets, footerActions: prompting ? RENAME_FOOTER_ACTIONS : LIBRARY_FOOTER_ACTIONS });
}

function libraryLine(
  story: StorySummary,
  selected: boolean,
  columns: LibraryColumns,
  now: number,
  deadlines?: FrameDeadlineCollector
): FrameLine {
  if (columns.updated !== 0) {
    const ageDeadline = nextAgeChange(story.updatedAt, now);
    if (ageDeadline !== null) deadlines?.at(ageDeadline);
  }
  const structure = `${story.partCount} parts · ${story.lineCount} lines`;
  return [
    raisedSegment(cellPad(selected ? "  ▸ " : "", columns.lead), selected ? "focus / accent" : "chrome"),
    raisedSegment(cellPad(truncate(story.title, Math.max(0, columns.title - 2)), columns.title), selected ? "prose" : "prose · dim"),
    raisedSegment(cellPadStart(story.words.toLocaleString("en-US"), columns.words), "prose · dim"),
    raisedSegment(`  ${cellPad(truncate(structure, Math.max(0, columns.structure - 4)), Math.max(0, columns.structure - 2))}`, "chrome"),
    ...(columns.updated === 0 ? [] : [
      raisedSegment(cellPad(libraryAge(story.updatedAt, now), columns.updated), "chrome")
    ])
  ];
}

function renameLine(composer: ComposerState, width: number): FrameLine {
  const prefix = truncate("  › rename: ", Math.max(0, width - 1));
  const valueWidth = Math.max(1, width - visibleWidth(prefix));
  return [
    raisedSegment(prefix, "accent · deep"),
    ...renderComposerInput(
      composer, 0, composerPosition(composer).column, valueWidth, "focused", false, ""
    )
  ];
}

function promptLine(kind: string, value: string, width: number, count = ""): FrameLine {
  const label = kind === "delete" ? "retype exact title" : kind;
  const prefix = truncate(`  › ${label}: `, Math.max(0, width - 1));
  const suffix = count.length === 0 ? "" : `  ${count}`;
  const valueWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix) - 1);
  return [
    raisedSegment(prefix, kind === "delete" ? "danger text" : "accent · deep"),
    raisedSegment(truncateTail(value, valueWidth), "streaming"),
    raisedSegment(TYPING_CARET, "focus / accent"),
    ...(suffix.length === 0 ? [] : [raisedSegment(suffix, "chrome")])
  ];
}

function renderCommands(
  base: FrameLine[],
  state: PanelRenderState,
  width: number,
  height: number
): FrameComposition {
  const overlay = state.commands!;
  const horizontal = panelHorizontalGeometry(width, 72);
  const content: FrameLine[] = [commandSearchLine(overlay.query, horizontal.contentWidth)];
  if (overlay.view === "tags") {
    const tags = state.payload.tags;
    const window = panelRowWindow(
      tags.map(() => 1),
      overlay.cursor,
      panelContentRows(height) - content.length
    );
    const targets: Array<HitTarget | null> = [null];
    for (const [offset, tag] of tags.slice(window.start, window.end).entries()) {
      const index = window.start + offset;
      targets.push({ kind: "list", index });
      content.push([
      raisedSegment(index === overlay.cursor ? "  ▸ " : "    ", index === overlay.cursor ? "focus / accent" : "chrome"),
      raisedSegment(cellPad(tag.name, 30), "prose"), raisedSegment(tag.status || "none", tagRole(tag))
      ]);
    }
    if (tags.length === 0) {
      content.push([raisedSegment("  no tags yet · esc, then t names a line", "prose · dim")]);
      targets.push(null);
    }
    return placePanel(base, `tag manager${panelRange(tags.length, window)}`, content,
      "↑↓ move · d delete · esc commands", width, height, 72,
      { rows: state.hitRows, targets, footerActions: TAGS_FOOTER_ACTIONS });
  }
  const model = commandPaletteModel(
    overlay.query,
    state.demo,
    commandContext(state.payload, {
      connectionDown: state.connection.down,
      requestActive: state.requestActive,
      canRewriteSelection: canRewriteSelection(overlay.selection?.spans ?? [])
    })
  );
  const cursor = retainCommandSelection(model.selectable, overlay.selectedId, overlay.cursor).cursor;
  const targets: Array<HitTarget | null> = [null];
  // Search permanently owns one of the rows the panel can paint.
  const rows = commandPaletteWindow(model, cursor, Math.max(1, panelContentRows(height) - 1));
  for (const row of rows) {
    content.push(commandPaletteLine(row, cursor, horizontal.contentWidth));
    targets.push(row.selectableIndex === null ? null : {
      kind: "list", index: row.selectableIndex, selected: row.selectableIndex === cursor
    });
  }
  if (model.selectable.length === 0) {
    content.push([raisedSegment("  no command matches · backspace widens the search", "prose · dim")]);
    targets.push(null);
  }
  return placePanel(base, "commands", content, "↑↓ move · ↵ run · esc close", width, height, 72,
    { rows: state.hitRows, targets, footerActions: COMMANDS_FOOTER_ACTIONS });
}

function commandSearchLine(query: string, width: number): FrameLine {
  const prefix = "  Search  ";
  const valueWidth = Math.max(0, width - visibleWidth(prefix) - 1);
  return [
    raisedSegment(prefix, "chrome"),
    raisedSegment(truncateTail(query, valueWidth), "streaming"),
    { text: " ", role: "background", background: "focus / accent", bold: true }
  ];
}

function renderSummary(base: FrameLine[], state: OverlayState & { hitRows: HitRows }, width: number, height: number): FrameComposition {
  const summary = state.summary!;
  const progress = deriveSummaryProgress(summary.text, summary.totalParts);
  const content: FrameLine[] = [
    summaryProgressLine(progress),
    [raisedSegment("  summarized stretch is locked while this writes", "summary")],
    [raisedSegment("  everything after it stays editable", "chrome")],
    [],
    [raisedSegment(`  ${truncate(summary.text.replace(/\s+/g, " "), 64)}`, "prose · dim")]
  ];
  // Inert, not transparent — see renderKeysOverlay.
  return placePanel(base, `summary take ━ compressing ¶ ${summary.start}–${summary.end} into a continuity record`, content,
    "esc discards", width, height, 78, { rows: state.hitRows, targets: content.map(() => null) });
}

const SUMMARY_BAR_CELLS = 30;
/** The same solid cell filled and dimmed the context meter uses: a hollow
 *  track outshouts the fill it exists to measure. */
const PROGRESS_INK = "▮";

/** C-30 + C-22: a block bar only once the parts consumed are countable. Until
 *  the draft marks a `¶ n of m`, there is no denominator — so this states the
 *  indeterminate form rather than filling a bar against a guess. The old bar
 *  divided the word count by a made-up 240-word total. */
function summaryProgressLine(progress: ReturnType<typeof deriveSummaryProgress>): FrameLine {
  const words = `${progress.words} words so far`;
  if (progress.consumedParts === null) {
    return [raisedSegment(`  ⟳ writing · ${words} · esc stops`, "focus / accent")];
  }
  const filled = Math.round(
    SUMMARY_BAR_CELLS * progress.consumedParts / Math.max(1, progress.totalParts)
  );
  return [
    raisedSegment("  "),
    raisedSegment(PROGRESS_INK.repeat(filled), "focus / accent"),
    raisedSegment(PROGRESS_INK.repeat(SUMMARY_BAR_CELLS - filled), "dimmed page"),
    raisedSegment(`  ¶ ${progress.consumedParts} of ${progress.totalParts} · ${words}`, "focus / accent")
  ];
}

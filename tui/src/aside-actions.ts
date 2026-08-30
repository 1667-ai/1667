/**
 * Open and drive the Aside surface.
 */
import { asideEntryPointsOpen } from "../../shared/aside-release.js";
import type { StoryPayload } from "../../shared/types.js";
import type { ActionTask } from "./action-runtime.js";
import type { StoryApi } from "./api.js";
import { setComposerText } from "./composer-model.js";
import {
  ASIDE_INPUT_PLACEHOLDER,
  ASIDE_SAVED_NOTICE,
  asideNotes,
  asideHeaderLine,
  currentAsideSession,
  currentAsideTurns,
  isAsideV2,
  normalizeAsideAnchor,
  createAsideSurface,
  type AsideSessionAnchor,
  type AsideSessionSurfaceState,
  type AsideAnswerSource,
  type AsideSurfaceState
} from "./aside-surface.js";
import { asideFooterHint, asideV2FooterHeight } from "./aside-footer.js";
import {
  asideChatLayout as renderAsideV2ChatLayout,
  hydrateAsideAnchor,
  asideSessionsFromResponse,
  asideV2HeaderLines,
  type AsideChatRowKind,
  type AsideChatLayout
} from "./aside-v2-layout.js";
import {
  applyAsideV2Settlement,
  reconcileAsidePresence
} from "./aside-v2-settlement.js";
import { noteCursorAfterHistoryScroll } from "./aside-note-scroll.js";
import type { RuntimeState } from "./state.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { createTextPresentation, drainTextPresentation } from "./text-presentation.js";
import { createStoryViewModel, rowPart } from "./model.js";
import { persistablePartId } from "./reading-position.js";
import { truncate } from "./screens/story/frame.js";
import { wrapText, type ProseStyle, type WrapCache } from "./wrap.js";
import type { ReasoningDelta } from "./worker-pending.js";
import { asideHopAnchorIndex } from "./aside-hop.js";

export interface AsideHistoryLayout {
  header: string[];
  body: string[];
  /** First body row for each saved Side Note. */
  noteStarts: readonly number[];
  /** Exclusive end of each note's content rows (separator blank excluded). */
  noteContentEnds: readonly number[];
  /**
   * Note index owning each body row. Null for separator blanks, empty-state
   * rows, and inflight stream rows (not saved notes).
   */
  rowNoteIndex: readonly (number | null)[];
  /** v2 turn equivalents. Empty for the predecessor notes layout. */
  turnStarts: readonly number[];
  turnContentEnds: readonly number[];
  rowTurnIndex: readonly (number | null)[];
  /** Semantic v2 row ownership; prevents answer text from being parsed as chrome. */
  rowKinds: readonly AsideChatRowKind[];
  /** Exact v2 question/answer prefix; empty for predecessor rows and chrome. */
  rowRolePrefixes: readonly string[];
  /** Source ranges for saved answer rows; null for every other row. */
  rowAnswerSources: readonly (AsideAnswerSource | null)[];
}

type AsideWrapCache = WrapCache<ProseStyle>;

/** Keep the open story authoritative after a Side Note mutation. */
function adoptAsidePayload(
  state: RuntimeState,
  payload: StoryPayload,
  cache?: AsideWrapCache
): void {
  if (cache === undefined) {
    // Direct action tests and small embedders may not own a wrap cache.
    if (state.aside?.storyId === payload.id) {
      state.aside.storyTitle = payload.title;
    }
    state.payload = payload;
    return;
  }
  adoptSameStoryPayload(state, payload, cache);
}

function dimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

interface WrappedAsideRow {
  text: string;
  start: number;
  end: number;
}

function wrappedRowsWithOffsets(text: string, width: number, prefix = ""): WrappedAsideRow[] {
  const prefixWidth = prefix.length;
  const wrapped = wrapText(text, [], Math.max(1, width - prefixWidth));
  return wrapped.map((line, index) => ({
    text: `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line.text}`,
    start: line.start,
    end: line.end
  }));
}

function wrappedRows(text: string, width: number, prefix = ""): string[] {
  return wrappedRowsWithOffsets(text, width, prefix).map((line) => line.text);
}

function legacyAsideNotes(value: unknown): { question: string; answer: string }[] {
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.question !== "string" || typeof record.answer !== "string") return [];
  return [{ question: record.question, answer: record.answer }];
}

function presentedAsideText(surface: AsideSurfaceState): string {
  if (surface.streamHidden === true) return "";
  const presentation = surface.presentation;
  return presentation === undefined || presentation.bypassed
    ? surface.streamText
    : presentation.presentedText;
}

function divider(width: number): string {
  return "─".repeat(Math.max(1, Math.min(width, 72)));
}

function asideHeaderLines(surface: AsideSurfaceState, width: number): string[] {
  if (isAsideV2(surface)) return asideV2HeaderLines(surface, width);
  return [
    ...wrappedRows(asideHeaderLine(surface.storyTitle), width),
    ...wrappedRows(ASIDE_SAVED_NOTICE, width),
    divider(width)
  ];
}

function clampAsideNoteCursor(surface: AsideSurfaceState): void {
  if (isAsideV2(surface)) {
    const v2 = surface;
    if (v2.sessions.length === 0) {
      v2.sessionIndex = 0;
      v2.turnCursor = 0;
      if (surface.focus === "turns" || surface.focus === "notes") surface.focus = "composer";
      surface.useMenu = null;
      return;
    }
    v2.sessionIndex = Math.max(0, Math.min(
      v2.sessions.length - 1, v2.sessionIndex
    ));
    const turns = currentAsideTurns(surface);
    v2.turnCursor = Math.max(0, Math.min(
      Math.max(0, turns.length - 1), v2.turnCursor
    ));
    return;
  }
  const notes = surface.notes;
  if (notes.length === 0) {
    surface.noteCursor = 0;
    if (surface.focus === "notes") surface.focus = "composer";
    surface.useMenu = null;
    return;
  }
  surface.noteCursor = Math.max(
    0,
    Math.min(notes.length - 1, surface.noteCursor)
  );
  if (surface.useMenu !== null
    && (surface.useMenu.noteIndex < 0
      || surface.useMenu.noteIndex >= notes.length)) {
    surface.useMenu = null;
  }
}

function clippedTitleRows(titleRows: string[], width: number, limit: number): string[] {
  if (limit <= 0) return [];
  const visible = titleRows.slice(0, limit);
  if (titleRows.length <= limit || visible.length === 0) return visible;
  const last = visible.length - 1;
  const shortened = truncate(visible[last]!, Math.max(1, width - 1));
  visible[last] = shortened.endsWith("…") ? shortened : `${shortened}…`;
  return visible;
}

/** Cap header rows so the full-screen composer always owns the bottom rows. */
export function asideHeaderWindow(
  surface: AsideSurfaceState,
  cols: number,
  maxRows: number
): string[] {
  const width = dimension(cols, 80);
  const capacity = Math.max(0, Math.floor(maxRows));
  if (isAsideV2(surface)) {
    const full = asideHeaderLines(surface, width);
    if (full.length <= capacity) return full;
    return clippedTitleRows(full, width, capacity);
  }
  const titleRows = wrappedRows(asideHeaderLine(surface.storyTitle), width);
  const full = asideHeaderLines(surface, width);
  if (full.length <= capacity) return full;
  if (capacity === 0) return [];
  const trailing = [
    ...wrappedRows(ASIDE_SAVED_NOTICE, width),
    divider(width)
  ];
  // At very small heights, keep a readable title instead of showing a
  // partial notice or rule. Normal heights retain the complete header tail.
  if (capacity <= trailing.length) return clippedTitleRows(titleRows, width, capacity);
  return [
    ...clippedTitleRows(titleRows, width, capacity - trailing.length),
    ...trailing
  ];
}

export function asideHistoryLayout(surface: AsideSurfaceState, cols: number, now?: number): AsideHistoryLayout {
  if (isAsideV2(surface)) {
    const layout = renderAsideV2ChatLayout(surface, cols, presentedAsideText(surface), now);
    return {
      ...layout,
      noteStarts: layout.turnStarts,
      noteContentEnds: layout.turnContentEnds,
      rowNoteIndex: layout.rowTurnIndex
    };
  }
  const width = dimension(cols, 80);
  const body: string[] = [];
  const noteStarts: number[] = [];
  const noteContentEnds: number[] = [];
  const rowNoteIndex: (number | null)[] = [];
  const rowKinds: AsideChatRowKind[] = [];
  const rowRolePrefixes: string[] = [];
  const rowAnswerSources: (AsideAnswerSource | null)[] = [];
  const notes = asideNotes(surface);
  if (notes.length === 0
    && presentedAsideText(surface).length === 0
    && surface.inflightQuestion === null) {
    body.push("(no Side Notes yet)");
    rowNoteIndex.push(null);
    rowKinds.push("plain");
    rowRolePrefixes.push("");
    rowAnswerSources.push(null);
  }
  // Focus-neutral prefixes: wrap never depends on which note is selected.
  // The visible window decorates the first on-screen row of the focused note.
  const questionPrefix = "  Q: ";
  const answerPrefix = "  A: ";
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index]!;
    noteStarts.push(body.length);
    const questionRows = wrappedRows(note.question, width, questionPrefix);
    body.push(...questionRows);
    for (let row = 0; row < questionRows.length; row += 1) {
      rowNoteIndex.push(index);
      rowKinds.push("question");
      rowRolePrefixes.push("");
      rowAnswerSources.push(null);
    }
    let answerOffset = 0;
    for (const paragraph of note.answer.split("\n")) {
      const answerRows = wrappedRowsWithOffsets(paragraph, width, answerPrefix);
      body.push(...answerRows.map((row) => row.text));
      for (const row of answerRows) {
        rowNoteIndex.push(index);
        rowKinds.push("answer");
        rowRolePrefixes.push("");
        rowAnswerSources.push({
          key: `aside-answer:legacy:${index}`,
          text: note.answer,
          start: answerOffset + row.start
        });
      }
      answerOffset += paragraph.length + 1;
    }
    noteContentEnds.push(body.length);
    // Separator blank is not note content for visibility / focus.
    body.push("");
    rowNoteIndex.push(null);
    rowKinds.push("plain");
    rowRolePrefixes.push("");
    rowAnswerSources.push(null);
  }
  const streamText = presentedAsideText(surface);
  if (surface.inflightQuestion !== null || streamText.length > 0) {
    // Same five-cell prefixes as saved notes so stream → save does not rewrap.
    const inflightQ = wrappedRows(surface.inflightQuestion ?? "", width, questionPrefix);
    const inflightA = wrappedRows(streamText, width, answerPrefix);
    body.push(...inflightQ, ...inflightA);
    for (let row = 0; row < inflightQ.length; row += 1) {
      rowNoteIndex.push(null);
      rowKinds.push("question");
      rowRolePrefixes.push("");
      rowAnswerSources.push(null);
    }
    for (let row = 0; row < inflightA.length; row += 1) {
      rowNoteIndex.push(null);
      rowKinds.push("answer");
      rowRolePrefixes.push("");
      rowAnswerSources.push(null);
    }
  }
  return {
    header: asideHeaderLines(surface, width),
    body,
    noteStarts,
    noteContentEnds,
    rowNoteIndex,
    turnStarts: [],
    turnContentEnds: [],
    rowTurnIndex: [],
    rowKinds,
    rowRolePrefixes,
    rowAnswerSources
  };
}

/**
 * Keep the focused Side Note inside the history viewport. Call after note
 * focus moves. Null scrollTop still means follow the newest rows when the
 * focused note already sits in the trailing window.
 */
export function revealAsideFocusedNote(
  surface: AsideSurfaceState,
  cols: number,
  bodyRows: number
): void {
  revealAsideFocusedNoteWithLayout(
    surface,
    asideHistoryLayout(surface, cols),
    bodyRows
  );
}

/** Same as {@link revealAsideFocusedNote} using a layout already computed. */
function revealAsideFocusedNoteWithLayout(
  surface: AsideSurfaceState,
  layout: AsideHistoryLayout,
  bodyRows: number
): void {
  if (isAsideV2(surface)) {
    if (surface.focus !== "turns" && surface.focus !== "notes") return;
    const height = Math.max(0, Math.floor(bodyRows));
    if (height === 0) return;
    const turnStart = layout.turnStarts[surface.turnCursor];
    if (turnStart === undefined) return;
    const turnEnd = layout.turnContentEnds[surface.turnCursor] ?? turnStart;
    const max = Math.max(0, layout.body.length - height);
    const current = surface.scrollTop === null
      ? max
      : Math.max(0, Math.min(max, surface.scrollTop));
    let next = current;
    // Keep the selected turn's useful context together. The prior bottom-edge
    // anchor showed only the first wrapped question row when the next turn was
    // below the viewport. A turn that does not fit must start at its question;
    // a short turn stays put only when its complete content is already visible.
    if (turnStart < current || turnEnd > current + height) next = turnStart;
    next = Math.max(0, Math.min(max, next));
    surface.scrollTop = next === max ? null : next;
    return;
  }
  if (surface.focus !== "notes" || surface.notes.length === 0) return;
  const height = Math.max(0, Math.floor(bodyRows));
  if (height === 0) return;
  const noteStart = layout.noteStarts[surface.noteCursor];
  if (noteStart === undefined) return;
  const max = Math.max(0, layout.body.length - height);
  const current = surface.scrollTop === null
    ? max
    : Math.max(0, Math.min(max, surface.scrollTop));
  let next = current;
  if (noteStart < current) next = noteStart;
  else if (noteStart >= current + height) next = noteStart - height + 1;
  next = Math.max(0, Math.min(max, next));
  surface.scrollTop = next === max ? null : next;
}

export { asideFooterHint, asideV2FooterHeight };

function asideFooterRows(surface: AsideSurfaceState, cols: number): string[] {
  const width = dimension(cols, 80);
  const input = surface.composer.text.length === 0
    ? ASIDE_INPUT_PLACEHOLDER
    : surface.composer.text;
  return [
    divider(width),
    ...wrappedRows(input, width, "> "),
    ...wrappedRows(asideFooterHint(surface), width)
  ];
}

export function asideComposerRows(height: number): number {
  const terminalHeight = dimension(height, 24);
  return Math.min(8, Math.max(4, Math.floor(terminalHeight / 3)));
}

/** Return only the scrollable history rows, padded to the requested viewport. */
export function asideHistoryWindow(
  surface: AsideSurfaceState,
  cols: number,
  bodyRows: number,
  now?: number
): string[] {
  return asideHistoryWindowWithKinds(surface, cols, bodyRows, now).lines;
}

export interface AsideHistoryWindowWithKinds {
  lines: string[];
  rowKinds: readonly AsideChatRowKind[];
  /** First layout-body row shown in `lines`. */
  start: number;
}

export function asideHistoryWindowWithKinds(
  surface: AsideSurfaceState,
  cols: number,
  bodyRows: number,
  now?: number,
  suppliedLayout?: AsideHistoryLayout
): AsideHistoryWindowWithKinds {
  const layout = suppliedLayout ?? asideHistoryLayout(surface, cols, now);
  const height = Math.max(0, Math.floor(bodyRows));
  if (height === 0) return { lines: [], rowKinds: [], start: 0 };
  const max = Math.max(0, layout.body.length - height);
  const start = surface.scrollTop === null
    ? max
    : Math.max(0, Math.min(max, surface.scrollTop));
  const visibleBody = layout.body.slice(start, start + height);
  const visibleKinds = layout.rowKinds.slice(start, start + height);
  // First visible owned content row gets ▸ — labelled Q/A or a wrap continuation.
  if (isAsideV2(surface)
    && (surface.focus === "turns" || surface.focus === "notes")
    && currentAsideTurns(surface).length > 0 && !surface.busy) {
    const focused = surface.turnCursor;
    for (let offset = 0; offset < visibleBody.length; offset += 1) {
      if (layout.rowTurnIndex[start + offset] === focused) {
        visibleBody[offset] = decorateFocusedHistoryRow(visibleBody[offset]!);
        break;
      }
    }
  } else if (!isAsideV2(surface) && surface.focus === "notes"
    && surface.notes.length > 0) {
    const focused = surface.noteCursor;
    for (let offset = 0; offset < visibleBody.length; offset += 1) {
      if (layout.rowNoteIndex[start + offset] === focused) {
        visibleBody[offset] = decorateFocusedHistoryRow(visibleBody[offset]!);
        break;
      }
    }
  }
  const padding = Math.max(0, height - visibleBody.length);
  return {
    lines: [
      ...visibleBody,
      ...Array.from({ length: padding }, () => "")
    ],
    rowKinds: [
      ...visibleKinds,
      ...Array.from({ length: padding }, () => "plain" as const)
    ],
    start
  };
}

/**
 * Swap one pad space for ▸ without reflowing wrap. Labelled rows keep Q:/A:;
 * question continuations keep their four-cell gutter.
 */
function decorateFocusedHistoryRow(line: string): string {
  if (line.startsWith(" ")) return `▸${line.slice(1)}`;
  return line;
}

export function asideBodyHeight(
  surface: AsideSurfaceState,
  cols: number,
  rows: number,
  composerRows?: number,
  toast?: string | null
): number {
  const height = dimension(rows, 24);
  const defaultFooterHeight = composerRows === undefined
    ? asideFooterRows(surface, cols).length
    : Math.max(1, Math.floor(composerRows));
  // V2 turns use a compact one-row composer, one status row, and a standalone
  // keyline. The predecessor-sized composer budget otherwise leaves several
  // phantom rows in the history viewport, so the first scroll keys appear to
  // do nothing until they absorb that gap.
  const footerHeight = isAsideV2(surface)
    && (surface.focus === "turns" || surface.focus === "notes" || surface.busy)
    ? 1 + asideV2FooterHeight(surface, cols, toast) + 1
    : defaultFooterHeight;
  const headerHeight = asideHeaderWindow(surface, cols, height - footerHeight).length;
  return Math.max(1, height - headerHeight - footerHeight);
}

/** Move the history viewport. Null scrollTop means follow the newest rows. */
export function scrollAside(
  surface: AsideSurfaceState,
  delta: number,
  cols: number,
  rows: number,
  composerRows?: number,
  toast?: string | null
): void {
  // One layout + bodyRows for this action: clamp the display-only offset.
  const layout = asideHistoryLayout(surface, cols);
  const bodyRows = asideBodyHeight(surface, cols, rows, composerRows, toast);
  const max = Math.max(0, layout.body.length - bodyRows);
  const current = Math.max(0, Math.min(max, surface.scrollTop ?? max));
  const next = Math.max(0, Math.min(max, current + delta));
  surface.scrollTop = next === max ? null : next;
  // Notes focus: keep the selected Side Note visible, or move selection to a
  // note that is in the new viewport for this scroll direction.
  if (!isAsideV2(surface)
    && surface.focus === "notes" && surface.notes.length > 0 && delta !== 0) {
    const notes = surface.notes;
    const nextCursor = noteCursorAfterHistoryScroll(
      notes.length,
      layout.noteStarts,
      layout.noteContentEnds,
      layout.body.length,
      surface.scrollTop,
      bodyRows,
      surface.noteCursor,
      delta
    );
    if (nextCursor !== surface.noteCursor) {
      surface.noteCursor = nextCursor;
      // Focus-neutral wrap; reveal keeps a ▸ marker in view when selection
      // moved to a note that intersects the viewport only in lower answer rows.
      revealAsideFocusedNoteWithLayout(surface, layout, bodyRows);
    }
  }
}

/** Keep an in-flight Aside ask's restore fence behind display-only scrolling.
 *  A real editor interaction still advances the shared epoch without calling
 *  this helper, so it remains newer than the submitted question. */
export function noteAsideDisplayScroll(state: RuntimeState): void {
  const active = state.abort?.kind === "generation" ? state.abort : null;
  if (active !== null && active.stopInteractionVersion !== null) {
    active.stopInteractionVersion = state.interactionVersion;
    return;
  }
  if (active?.askInteractionVersion !== undefined
    && state.interactionVersion === active.askInteractionVersion + 1) {
    active.askInteractionVersion = state.interactionVersion;
  }
}

export async function openAside(
  state: RuntimeState,
  api: StoryApi,
  options: {
    pendingAsk?: string | null;
    entryPointsOpen?: boolean;
    task?: Pick<ActionTask, "owns" | "storyCurrent" | "interactionCurrent">;
  } = {}
): Promise<boolean> {
  if (!asideEntryPointsOpen(options.entryPointsOpen)) {
    state.toast = "Aside is not available in this release";
    return false;
  }
  const requestedStoryId = state.payload.id;
  const requestedInteractionVersion = state.interactionVersion;
  // Capture before the load await so a focus change while getAside is pending
  // cannot move Placement's initial stop off the Part the writer invoked on.
  // Summary/divider NAV rows have no rowPart; persistablePartId maps them to a
  // chapter Part so Placement still opens on the visible chapter position.
  const view = createStoryViewModel(state.payload, state.stream);
  const openingPartId = persistablePartId(view, state.focusIndex, state.payload);
  const openingPart = rowPart(view, state.focusIndex);
  const openingTakeId = openingPart?.id ?? openingPartId;
  const openingAnchor: AsideSessionAnchor | null = openingTakeId === null
    ? null
    : {
      partId: openingPartId ?? openingTakeId,
      takeId: openingTakeId,
      ...(openingPart === null || openingPart === undefined ? {} : {
        partNumber: openingPart.number,
        takeIndex: openingPart.takeIndex,
        takeCount: openingPart.siblingCount
      })
    };
  const openingAnchorWire = openingAnchor === null
    ? null
    : { partId: openingAnchor.partId, takeId: openingAnchor.takeId };
  const current = () => state.payload.id === requestedStoryId
    && state.interactionVersion === requestedInteractionVersion
    && (options.task?.owns() ?? true)
    && (options.task?.storyCurrent() ?? true)
    && (options.task?.interactionCurrent() ?? true);
  // Prefer the additive v2 read when the transport exposes it. A null v2
  // result means the server is still v1; retain the exact legacy rendering.
  let document: unknown;
  if (api.getAsideV2 !== undefined) {
    const v2 = await api.getAsideV2({
      storyId: requestedStoryId,
      anchor: openingAnchorWire
    });
    document = v2 ?? await api.getAside(requestedStoryId);
  } else {
    // Older embedders may already accept the optional anchor at runtime.
    const getAside = api.getAside as unknown as (
      storyId: string,
      anchor?: AsideSessionAnchor | null
    ) => Promise<unknown>;
    document = await getAside(requestedStoryId, openingAnchorWire);
  }
  if (!current()) return false;
  const responseRecord = document !== null && typeof document === "object"
    ? document as Record<string, unknown> : null;
  const v2Response = responseRecord !== null
    && (responseRecord.schemaVersion === 2
      || Array.isArray(responseRecord.sessions)
      || Array.isArray(responseRecord.anchors));
  if (v2Response) {
    const model = asideSessionsFromResponse(document, openingAnchor);
    const responseAnchor = responseRecord !== null
      && Object.prototype.hasOwnProperty.call(responseRecord, "anchor")
      ? normalizeAsideAnchor(responseRecord.anchor) : openingAnchor;
    const selectedAnchor = hydrateAsideAnchor(responseAnchor, model.anchors, openingAnchor);
    state.aside = createAsideSurface(
      requestedStoryId,
      state.payload.title,
      model.sessions,
      options.pendingAsk ?? null,
      openingPartId,
      {
        sessions: model.sessions,
        anchors: model.anchors,
        anchor: selectedAnchor,
        thoughtsVisible: state.config.asideThoughts === "show",
        v2: true
      }
    );
    if (isAsideV2(state.aside)) {
      state.aside.anchorIndex = asideHopAnchorIndex(state.aside.anchors, state.aside.anchor);
    }
  } else {
    const notes = responseRecord !== null && Array.isArray(responseRecord.notes)
      ? responseRecord.notes.flatMap((entry) => legacyAsideNotes(entry))
      : [];
    state.aside = createAsideSurface(
      requestedStoryId,
      state.payload.title,
      notes,
      options.pendingAsk ?? null,
      openingPartId
    );
  }
  state.mode = "ASIDE";
  state.commands = null;
  return true;
}

export function closeAside(state: RuntimeState): void {
  state.aside = null;
  if (state.mode === "ASIDE") state.mode = "NAV";
}

export interface AsideAskOptions {
  /** The ActionRuntime owner for this presented request. */
  readonly task?: ActionTask;
  /** Repaint after the busy claim and every visible stream delta. */
  readonly repaint?: () => void;
  /** Cache used when adopting the authoritative post-ask story payload. */
  readonly cache?: AsideWrapCache;
}

function asideResultRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown> : null;
}

/** Apply a terminal response without making the renderer know which transport
 * supplied it. Legacy `{ notes }` remains authoritative for v1 surfaces. */
function applyAsideResult(surface: AsideSurfaceState, value: unknown): void {
  const record = asideResultRecord(value);
  if (record === null) return;
  if (isAsideV2(surface)) {
    const payload = record.payload !== null && typeof record.payload === "object"
      ? record.payload as StoryPayload : undefined;
    if (payload !== undefined) reconcileAsidePresence(surface, payload);
    if (applyAsideV2Settlement(surface, record)) {
      if (payload !== undefined) reconcileAsidePresence(surface, payload);
      return;
    }
  }
  if (!isAsideV2(surface) && Array.isArray(record.notes)) {
    const notes = record.notes.flatMap((entry) => legacyAsideNotes(entry));
    surface.notes = notes;
    surface.noteCursor = Math.max(0, notes.length - 1);
  }
}

export function clearAsideStream(surface: AsideSurfaceState): void {
  surface.streamText = "";
  surface.streamThoughts = "";
  surface.streamThoughtTokens = 0;
  surface.streamPhase = null;
  surface.streamHidden = false;
  surface.presentation?.dispose();
  surface.presentation = undefined;
  surface.inflightQuestion = null;
}

/** Remove a synchronous Stop restore when the provider committed the ask.
 * Preserve any newer composer text written while the request was settling. */
function clearAsideStopRestore(
  active: {
    stopInteractionVersion: number | null;
    asideAsk?: {
      composer: AsideSurfaceState["composer"];
      question: string;
      restored: boolean;
    };
  },
  state: RuntimeState,
  surface: AsideSurfaceState
): void {
  const ask = active.asideAsk;
  if (ask?.restored !== true
    || active.stopInteractionVersion !== state.interactionVersion
    || surface.composer !== ask.composer
    || surface.composer.text !== ask.question) return;
  setComposerText(surface.composer, "");
}

export async function sendAsideQuestion(
  state: RuntimeState,
  api: StoryApi,
  question: string,
  options: AsideAskOptions = {}
): Promise<void> {
  const surface = state.aside;
  if (surface === null || surface.busy || state.abort !== null) return;
  const trimmed = question.trim();
  if (trimmed.length === 0) return;
  const owns = options.task?.owns ?? (() => true);
  const storyCurrent = options.task?.storyCurrent ?? (() => true);
  const interactionCurrent = options.task?.interactionCurrent ?? (() => true);
  const repaint = options.repaint ?? (() => undefined);
  const current = () => state.aside === surface && owns() && storyCurrent();
  // Presentation timers can outlive ActionRuntime's task ownership after the
  // provider settles. Keep repaint ownership on the live surface and story;
  // provider callbacks still use `current()` below.
  const presentationCurrent = () => state.aside === surface
    && state.payload.id === surface.storyId;
  surface.busy = true;
  surface.scrollTop = null;
  surface.inflightQuestion = trimmed;
  surface.streamText = "";
  surface.streamThoughts = "";
  surface.streamThoughtTokens = 0;
  surface.streamPhase = "thinking";
  surface.streamHidden = false;
  surface.presentation?.dispose();
  surface.presentation = createTextPresentation({
    onPresented: () => {
      if (presentationCurrent()) repaint();
    }
  });
  setComposerText(surface.composer, "");
  const controller = new AbortController();
  const active = {
    kind: "generation" as const,
    controller,
    stopInteractionVersion: null as number | null,
    askInteractionVersion: state.interactionVersion,
    asideAsk: {
      composer: surface.composer,
      question: trimmed,
      restored: false
    }
  };
  state.abort = active;
  repaint();
  const mayRestore = () => current() && (
    interactionCurrent()
    || active.stopInteractionVersion !== null
      && state.interactionVersion === active.stopInteractionVersion
    || active.askInteractionVersion !== undefined
      && state.interactionVersion === active.askInteractionVersion
  );
  try {
    const onDelta = (text: string) => {
      if (!current()) return;
      surface.streamPhase = "writing";
      surface.streamText += text;
      surface.presentation?.receive(text);
      if (surface.presentation === undefined) repaint();
    };
    const callbacks = {
      onReasoning: (delta: ReasoningDelta) => {
        if (!current()) return;
        surface.streamThoughts += delta.text;
        surface.streamThoughtTokens = Math.max(
          surface.streamThoughtTokens,
          delta.tokenCount
        );
        repaint();
      },
      onReasoningStopped: (text: string) => {
        if (!current()) return;
        surface.streamThoughts += text;
        repaint();
      },
      onPhase: (phase: "thinking" | "writing") => {
        if (!current()) return;
        surface.streamPhase = phase;
        repaint();
      }
    };
    let result: unknown;
    if (isAsideV2(surface)) {
      if (api.askAsideV2 === undefined) {
        throw new Error("This transport cannot write Aside sessions.");
      }
      const session = currentAsideSession(surface);
      result = await api.askAsideV2(
        {
          storyId: surface.storyId,
          question: trimmed,
          anchor: surface.anchor === null ? null : {
            partId: surface.anchor.partId,
            takeId: surface.anchor.takeId
          },
          // Keep an empty persisted session addressable after `/clear`.
          // Client-created ids are also stable mutation inputs, so the first
          // ask can persist that exact id without a second local identity.
          ...(session === null ? {} : { sessionId: session.id })
        },
        onDelta,
        callbacks,
        controller.signal
      );
    } else {
      result = await api.askAside(
        surface.storyId,
        trimmed,
        onDelta,
        controller.signal
      );
    }
    if (!current()) return;
    if (surface.presentation !== undefined) await drainTextPresentation(surface.presentation);
    if (!current()) return;
    if (result === null) {
      // Cancelled or stopped: return the question to the input.
      const restore = mayRestore();
      const preserveScroll = isAsideV2(surface) && surface.scrollTop !== null;
      if (restore && !active.asideAsk.restored) setComposerText(surface.composer, trimmed);
      clearAsideStream(surface);
      if (restore && !preserveScroll) surface.scrollTop = null;
      surface.busy = false;
      return;
    }
    const preserveScroll = isAsideV2(surface) && surface.scrollTop !== null;
    applyAsideResult(surface, result);
    clearAsideStopRestore(active, state, surface);
    if (isAsideV2(surface)) {
      const turns = currentAsideTurns(surface);
      surface.turnCursor = Math.max(0, turns.length - 1);
    } else {
      surface.noteCursor = Math.max(0, surface.notes.length - 1);
    }
    clampAsideNoteCursor(surface);
    clearAsideStream(surface);
    if (!preserveScroll) surface.scrollTop = null;
    surface.busy = false;
    // The Aside result is committed before this refresh. Keep the result
    // visible if the refresh fails; transports invalidate their optimistic
    // version cache and recover lazily on the next mutation.
    try {
      const resultRecord = asideResultRecord(result);
      const payload = resultRecord?.payload !== undefined
        ? resultRecord.payload as StoryPayload
        : await api.loadStory(surface.storyId);
      if (current()) {
        adoptAsidePayload(state, payload, options.cache);
        if (isAsideV2(surface)) reconcileAsidePresence(surface, payload);
      }
    } catch {
      // A committed Side Note must not be hidden by a failed refresh.
    }
    if (controller.signal.aborted) {
      state.toast = "Aside stopped · answer kept";
    }
  } catch (error) {
    if (!current()) return;
    const restore = mayRestore();
    const preserveScroll = isAsideV2(surface) && surface.scrollTop !== null;
    if (restore && !active.asideAsk.restored) setComposerText(surface.composer, trimmed);
    clearAsideStream(surface);
    if (restore && !preserveScroll) surface.scrollTop = null;
    surface.busy = false;
    state.toast = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.abort === active) state.abort = null;
    if (current()) repaint();
  }
}

/**
 * Stop an in-flight Aside answer. Keep received answer text as a Side Note.
 * If no answer text arrived, restore the question. Stay on the Aside surface.
 */
export function stopAsideAsk(state: RuntimeState): boolean {
  const surface = state.aside;
  if (surface === null || !surface.busy) return false;
  const active = state.abort?.kind === "generation" ? state.abort : null;
  if (active === null) return false;
  if (active.controller.signal.aborted) return false;
  // `dispatch` advances interactionVersion before it reaches this handler.
  // Accept only that one Stop interaction. If the writer edited or scrolled
  // first, the later settlement must not reclaim the newer editor state.
  const askInteractionVersion = active.askInteractionVersion;
  if (askInteractionVersion === undefined
    || state.interactionVersion === askInteractionVersion
    || state.interactionVersion === askInteractionVersion + 1) {
    active.stopInteractionVersion = state.interactionVersion;
  }
  const question = surface.inflightQuestion;
  const ask = active.asideAsk;
  if (ask !== undefined
    && active.stopInteractionVersion === state.interactionVersion
    && question !== null
    && question === ask.question
    && surface.composer === ask.composer
    && surface.streamText.trim().length === 0
    && surface.composer.text.length === 0) {
    setComposerText(surface.composer, question);
    ask.restored = true;
    // Match regular story Stop: return control to the draft immediately.
    // The abort fence remains until the provider settles.
    surface.busy = false;
    surface.inflightQuestion = null;
    surface.streamHidden = true;
  }
  active.controller.abort();
  // Keep the visible prefix in place while the stopped answer settles into a
  // saved turn. Provider text that arrives after Stop remains transport-only.
  if (ask?.restored !== true) surface.streamHidden = false;
  surface.presentation?.suspend();
  return true;
}

export async function clearAsideSurface(
  state: RuntimeState,
  api: StoryApi,
  cache?: AsideWrapCache,
  options: {
    task?: Pick<ActionTask, "owns" | "storyCurrent">
  } = {}
): Promise<void> {
  const surface = state.aside;
  if (surface === null || surface.busy || isAsideV2(surface)) return;
  if (!surface.confirmClear) {
    surface.confirmClear = true;
    return;
  }
  const storyId = surface.storyId;
  const current = () => state.aside === surface
    && state.payload.id === storyId
    && (options.task?.owns() ?? true)
    && (options.task?.storyCurrent() ?? true);
  // A confirmed Clear cannot be stopped. Drop the confirmation state before
  // the first await so every repaint shows the non-cancellable operation.
  surface.confirmClear = false;
  surface.busy = true;
  try {
    const payload = await api.clearAside(storyId);
    if (!current() || payload.id !== storyId) return;
    // The receipt replay payload is authoritative even if a follow-up Aside
    // read fails. Adopt its story revision before that fallible refresh so the
    // next optimistic mutation cannot use stale metadata.
    adoptAsidePayload(state, payload, cache);
    if (payload.hasAside === true) {
      const document = await api.getAside(storyId);
      if (!current()) return;
      surface.notes = document.notes.map((note) => ({
        question: note.question,
        answer: note.answer
      }));
    } else {
      surface.notes = [];
    }
    clampAsideNoteCursor(surface);
    surface.scrollTop = null;
    surface.confirmClear = false;
    surface.busy = false;
    state.toast = payload.hasAside === true
      ? "Side Notes refreshed"
      : "Side Notes cleared";
  } catch (error) {
    if (!current()) return;
    surface.busy = false;
    surface.confirmClear = false;
    state.toast = error instanceof Error ? error.message : String(error);
  }
}

export function renderAsideFrame(surface: AsideSurfaceState, cols: number, rows: number): string[] {
  const width = dimension(cols, 80);
  const height = dimension(rows, 24);
  const layout = asideHistoryLayout(surface, width);
  const footer = asideFooterRows(surface, width);
  const header = asideHeaderWindow(surface, width, height - footer.length);
  const bodyHeight = Math.max(0, height - header.length - footer.length);
  return [...header, ...asideHistoryWindow(surface, width, bodyHeight), ...footer]
    .slice(0, height);
}

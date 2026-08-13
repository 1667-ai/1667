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
  asideHeaderLine,
  createAsideSurface,
  type AsideSurfaceState
} from "./aside-surface.js";
import type { RuntimeState } from "./state.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { truncate } from "./screens/story/frame.js";
import { wrapText, type ProseStyle, type WrapCache } from "./wrap.js";

export interface AsideHistoryLayout {
  header: string[];
  body: string[];
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

function wrappedRows(text: string, width: number, prefix = ""): string[] {
  const prefixWidth = prefix.length;
  const wrapped = wrapText(text, [], Math.max(1, width - prefixWidth));
  return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line.text}`);
}

function divider(width: number): string {
  return "─".repeat(Math.max(1, Math.min(width, 72)));
}

function asideHeaderLines(surface: AsideSurfaceState, width: number): string[] {
  return [
    ...wrappedRows(asideHeaderLine(surface.storyTitle), width),
    ...wrappedRows(ASIDE_SAVED_NOTICE, width),
    divider(width)
  ];
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

export function asideHistoryLayout(surface: AsideSurfaceState, cols: number): AsideHistoryLayout {
  const width = dimension(cols, 80);
  const body: string[] = [];
  if (surface.notes.length === 0
    && surface.streamText.length === 0
    && surface.inflightQuestion === null) {
    body.push("(no Side Notes yet)");
  }
  for (const note of surface.notes) {
    body.push(...wrappedRows(note.question, width, "Q: "));
    for (const paragraph of note.answer.split("\n")) {
      body.push(...wrappedRows(paragraph, width, "A: "));
    }
    body.push("");
  }
  if (surface.inflightQuestion !== null || surface.streamText.length > 0) {
    body.push(...wrappedRows(surface.inflightQuestion ?? "", width, "Q: "));
    body.push(...wrappedRows(surface.streamText, width, "A: "));
  }
  return {
    header: asideHeaderLines(surface, width),
    body
  };
}

export function asideFooterHint(surface: AsideSurfaceState): string {
  if (surface.confirmClear) return "Clear all Side Notes? Enter confirms · Esc cancels";
  if (surface.busy && surface.inflightQuestion === null) return "Clearing…";
  if (surface.busy) return "Esc stop · PageUp/PageDown scroll · Shift+Up/Down line scroll";
  return "Esc write · /clear clear · Enter send · Shift+Enter newline · PageUp/PageDown scroll · Shift+Up/Down line scroll";
}

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
  bodyRows: number
): string[] {
  const layout = asideHistoryLayout(surface, cols);
  const height = Math.max(0, Math.floor(bodyRows));
  if (height === 0) return [];
  const max = Math.max(0, layout.body.length - height);
  const start = surface.scrollTop === null
    ? max
    : Math.max(0, Math.min(max, surface.scrollTop));
  const visibleBody = layout.body.slice(start, start + height);
  return [
    ...visibleBody,
    ...Array.from({ length: Math.max(0, height - visibleBody.length) }, () => "")
  ];
}

export function asideBodyHeight(
  surface: AsideSurfaceState,
  cols: number,
  rows: number,
  composerRows?: number
): number {
  const height = dimension(rows, 24);
  const footerHeight = composerRows === undefined
    ? asideFooterRows(surface, cols).length
    : Math.max(1, Math.floor(composerRows));
  const headerHeight = asideHeaderWindow(surface, cols, height - footerHeight).length;
  return Math.max(1, height - headerHeight - footerHeight);
}

function asideMaxScroll(
  surface: AsideSurfaceState,
  cols: number,
  rows: number,
  composerRows?: number
): number {
  const layout = asideHistoryLayout(surface, cols);
  return Math.max(0, layout.body.length - asideBodyHeight(surface, cols, rows, composerRows));
}

/** Move the history viewport. Null scrollTop means follow the newest rows. */
export function scrollAside(
  surface: AsideSurfaceState,
  delta: number,
  cols: number,
  rows: number,
  composerRows?: number
): void {
  const max = asideMaxScroll(surface, cols, rows, composerRows);
  const current = surface.scrollTop ?? max;
  const next = Math.max(0, Math.min(max, current + delta));
  surface.scrollTop = next === max ? null : next;
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
  const current = () => state.payload.id === requestedStoryId
    && state.interactionVersion === requestedInteractionVersion
    && (options.task?.owns() ?? true)
    && (options.task?.storyCurrent() ?? true)
    && (options.task?.interactionCurrent() ?? true);
  const document = await api.getAside(requestedStoryId);
  if (!current()) return false;
  state.aside = createAsideSurface(
    requestedStoryId,
    state.payload.title,
    document.notes,
    options.pendingAsk ?? null
  );
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
  surface.busy = true;
  surface.scrollTop = null;
  surface.inflightQuestion = trimmed;
  surface.streamText = "";
  setComposerText(surface.composer, "");
  const controller = new AbortController();
  const active = {
    kind: "generation" as const,
    controller,
    stopInteractionVersion: null as number | null,
    askInteractionVersion: state.interactionVersion
  };
  state.abort = active;
  repaint();
  const mayRestore = () => current() && (
    interactionCurrent()
    || active.stopInteractionVersion !== null
      && state.interactionVersion === active.stopInteractionVersion
  );
  try {
    const result = await api.askAside(
      surface.storyId,
      trimmed,
      (text) => {
        if (!current()) return;
        surface.streamText += text;
        repaint();
      },
      controller.signal
    );
    if (!current()) return;
    if (result === null) {
      // Cancelled or stopped: return the question to the input.
      const restore = mayRestore();
      if (restore) setComposerText(surface.composer, trimmed);
      surface.streamText = "";
      surface.inflightQuestion = null;
      if (restore) surface.scrollTop = null;
      surface.busy = false;
      return;
    }
    surface.notes = result.notes.map((note) => ({
      question: note.question,
      answer: note.answer
    }));
    surface.streamText = "";
    surface.inflightQuestion = null;
    surface.scrollTop = null;
    surface.busy = false;
    // The Aside result is committed before this refresh. Keep the result
    // visible if the refresh fails; transports invalidate their optimistic
    // version cache and recover lazily on the next mutation.
    try {
      const payload = result.payload ?? await api.loadStory(surface.storyId);
      if (current()) adoptAsidePayload(state, payload, options.cache);
    } catch {
      // A committed Side Note must not be hidden by a failed refresh.
    }
  } catch (error) {
    if (!current()) return;
    const restore = mayRestore();
    if (restore) setComposerText(surface.composer, trimmed);
    surface.streamText = "";
    surface.inflightQuestion = null;
    if (restore) surface.scrollTop = null;
    surface.busy = false;
    state.toast = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.abort === active) state.abort = null;
    if (current()) repaint();
  }
}

/**
 * Stop an in-flight Aside answer. The ask path restores the question when the
 * abort settles. Stays on the Aside surface.
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
  active.controller.abort();
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
  if (surface === null || surface.busy) return;
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

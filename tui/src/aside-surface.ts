/**
 * Aside surface state helpers.
 *
 * The v1 API called one story-wide document a list of Side Notes. Aside v2
 * calls the same exchange a turn and groups turns in an anchored session.
 * Variant state is canonical; selectors adapt v2 turns for old consumers.
 */
import { createComposer, type ComposerState } from "./composer-model.js";
import type { TextPresentation } from "./text-presentation.js";
import { asideHopAnchorIndex } from "./aside-hop.js";
import type { StorySelectionSpan } from "./selection-projection.js";

export interface AsideNoteView {
  readonly question: string;
  readonly answer: string;
}

/** Source range for one painted row of a saved Aside answer. */
export interface AsideAnswerSource {
  readonly key: string;
  readonly text: string;
  readonly start: number;
}

/** A linear v2 exchange. The wire names are deliberately short and stable. */
export interface AsideTurnView {
  readonly id?: string;
  readonly q: string;
  readonly a: string;
  readonly thoughts?: string;
  readonly thoughtTokens?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** Protocol turns normally have no id. Keep their display identity in memory
 * so queued input and semantic selection survive an earlier turn's removal. */
const asideTurnIdentity = new WeakMap<object, string>();
let nextAsideTurnIdentity = 0;

export function asideTurnRowIdentity(turn: AsideTurnView): string {
  if (turn.id !== undefined && turn.id.length > 0) return `id:${turn.id}`;
  const object = turn as object;
  const existing = asideTurnIdentity.get(object);
  if (existing !== undefined) return `ref:${existing}`;
  const identity = `turn-${++nextAsideTurnIdentity}`;
  asideTurnIdentity.set(object, identity);
  return `ref:${identity}`;
}

/** A single-session mutation keeps turn order. Carry an allocated identity to
 * the fresh protocol objects returned by its settlement. */
export function inheritAsideTurnRowIdentities(
  previous: readonly AsideTurnView[],
  next: readonly AsideTurnView[]
): void {
  const length = Math.min(previous.length, next.length);
  for (let index = 0; index < length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (before.id !== undefined || after.id !== undefined) continue;
    const identity = asideTurnIdentity.get(before as object);
    if (identity !== undefined) asideTurnIdentity.set(after as object, identity);
  }
}

export interface AsideSessionAnchor {
  readonly partId: string;
  readonly takeId: string;
  readonly partNumber?: number;
  readonly takeIndex?: number;
  readonly takeCount?: number;
}

export interface AsideSessionView {
  readonly id: string;
  readonly title: string;
  readonly anchor: AsideSessionAnchor | null;
  readonly turns: readonly AsideTurnView[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** One hop-strip entry. `sessions` is optional because the ledger is not a
 * required part of card 12a, while the count is useful to the cycler. */
export interface AsideAnchorView extends AsideSessionAnchor {
  readonly sessionCount: number;
  readonly title?: string;
  readonly unanchored?: boolean;
}

export type AsideFocus = "composer" | "turns" | "notes";

/** Use menu for one complete saved Side Note answer. */
export interface AsideUseMenuState {
  noteIndex: number;
  /** Exact terminal selection, when the menu came from a highlighted answer.
   *  Undefined means the complete saved answer is the target. */
  selectionText?: string;
  /** Semantic answer spans to repaint after the native selection is cleared. */
  selectionSpans?: readonly StorySelectionSpan[];
  /** Index into the stage's use-menu action list. */
  cursor: number;
  /**
   * Fresh identity for this menu open. Hit reconciliation binds list/apply
   * clicks to it so a queued click for note A cannot run after the writer
   * opens note B. Survives repaint and Placement Esc restoration; changes on
   * every openAsideUseMenu.
   */
  sessionId: string;
}

export interface AsideDeleteUndo {
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly turn: AsideTurnView;
}

/** The saved turn and original Ask composer held during Reprompt. */
export interface AsideRetakePromptState {
  readonly sessionId: string;
  readonly turnIndex: number;
  /** Keep the object so its cursor, selection, cut state, and edit history survive. */
  readonly askComposer: ComposerState;
}

export type AsideStreamPhase = "thinking" | "writing" | null;

interface AsideSurfaceBase {
  readonly storyId: string;
  storyTitle: string;
  composer: ComposerState;
  /** Text streaming from the current ask, if any. */
  streamText: string;
  /** Visible prefix controller; `streamText` remains authoritative. */
  presentation?: TextPresentation;
  /** Stop freezes the visible answer prefix until the backend settles. */
  streamHidden?: boolean;
  /** Reasoning channel streamed separately from the answer channel. */
  streamThoughts: string;
  streamThoughtTokens: number;
  streamPhase: AsideStreamPhase;
  /** Question currently being answered; returned to the input on failure. */
  inflightQuestion: string | null;
  /** First wrapped history row; null follows the newest content. */
  scrollTop: number | null;
  busy: boolean;
  /** Seed question from `/aside <question>` after the surface opens. */
  pendingAsk: string | null;
  /** Keyboard focus: the Aside composer or the linear turn list. */
  focus: AsideFocus;
  /** Use menu for one complete saved answer, or null when closed. */
  useMenu: AsideUseMenuState | null;
  /**
   * Story Part id focused when Aside opened. Placement starts here when the
   * Part still exists. Anchors are not used in this stage.
  */
  openingPartId: string | null;
}

export interface LegacyAsideSurfaceState extends AsideSurfaceBase {
  /** Explicit model discriminator for the predecessor document. */
  readonly modelVersion: 1;
  notes: AsideNoteView[];
  noteCursor: number;
  confirmClear: boolean;
}

export interface AsideSessionSurfaceState extends AsideSurfaceBase {
  /** Explicit model discriminator for take-anchored sessions. */
  readonly modelVersion: 2;
  sessions: AsideSessionView[];
  sessionIndex: number;
  turnCursor: number;
  anchors: AsideAnchorView[];
  anchorIndex: number;
  thoughtsVisible: boolean;
  confirmReset: { turnIndex: number } | null;
  /** Stable answer identity armed by the first destructive keypress. */
  confirmDelete: { rowId: string } | null;
  deleteUndo: AsideDeleteUndo | null;
  /** Capital-R Reprompt target. Null means the composer will add a turn. */
  retakePrompt: AsideRetakePromptState | null;
  anchor: AsideSessionAnchor | null;
}

export type AsideSurfaceState = LegacyAsideSurfaceState | AsideSessionSurfaceState;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Normalize one canonical v2 turn. Legacy notes use their own adapter. */
export function normalizeAsideTurn(value: unknown): AsideTurnView | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const q = asString(record.q);
  const a = asString(record.a);
  if (q.length === 0 && a.length === 0) return null;
  const thoughts = asOptionalString(record.thoughts);
  const thoughtTokens = asOptionalNumber(record.thoughtTokens);
  return {
    ...(asOptionalString(record.id) === undefined ? {} : { id: asOptionalString(record.id) }),
    q,
    a,
    ...(thoughts === undefined ? {} : { thoughts }),
    ...(thoughtTokens === undefined ? {} : { thoughtTokens }),
    ...(asOptionalString(record.createdAt) === undefined
      ? {} : { createdAt: asOptionalString(record.createdAt) }),
    ...(asOptionalString(record.updatedAt) === undefined
      ? {} : { updatedAt: asOptionalString(record.updatedAt) })
  };
}

export function normalizeAsideAnchor(value: unknown): AsideSessionAnchor | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const partId = asString(record.partId);
  const takeId = asString(record.takeId);
  if (partId.length === 0 && takeId.length === 0) return null;
  return {
    partId: partId || takeId,
    takeId: takeId || partId,
    ...(asOptionalNumber(record.partNumber) === undefined
      ? {} : { partNumber: asOptionalNumber(record.partNumber) }),
    ...(asOptionalNumber(record.takeIndex) === undefined
      ? {} : { takeIndex: asOptionalNumber(record.takeIndex) }),
    ...(asOptionalNumber(record.takeCount) === undefined
      ? {} : { takeCount: asOptionalNumber(record.takeCount) })
  };
}

/** Normalize one v2 session from API data or a test fixture. */
export function normalizeAsideSession(value: unknown, index = 0): AsideSessionView | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawTurns = Array.isArray(record.turns) ? record.turns : [];
  const turns = rawTurns.flatMap((turn) => {
    const normalized = normalizeAsideTurn(turn);
    return normalized === null ? [] : [normalized];
  });
  const id = asString(record.id, `session-${index + 1}`);
  const title = asString(record.title, turns[0]?.q ?? "new session");
  return {
    id,
    title,
    anchor: normalizeAsideAnchor(record.anchor),
    turns,
    ...(asOptionalString(record.createdAt) === undefined
      ? {} : { createdAt: asOptionalString(record.createdAt) }),
    ...(asOptionalString(record.updatedAt) === undefined
      ? {} : { updatedAt: asOptionalString(record.updatedAt) })
  };
}

/** Build a v2 session from the predecessor's note list. */
export function sessionFromAsideNotes(
  notes: readonly AsideNoteView[],
  anchor: AsideSessionAnchor | null = null,
  id = "legacy"
): AsideSessionView {
  const turns = notes.map((note, index) => ({
    id: `${id}-turn-${index + 1}`,
    q: note.question,
    a: note.answer
  }));
  return {
    id,
    title: turns[0]?.q ?? "new session",
    anchor,
    turns
  };
}

function looksLikeSession(value: unknown): value is AsideSessionView {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.turns);
}

export interface CreateAsideSurfaceOptions {
  readonly sessions?: readonly unknown[];
  readonly anchors?: readonly unknown[];
  readonly anchor?: AsideSessionAnchor | null;
  readonly v2?: boolean;
  readonly thoughtsVisible?: boolean;
  readonly sessionIndex?: number;
}

/** Return the current session's turns as the predecessor note projection. */
export function asideNotes(surface: AsideSurfaceState): readonly AsideNoteView[] {
  if (!isAsideV2(surface)) return surface.notes;
  return (surface.sessions[surface.sessionIndex]?.turns ?? []).map((turn) => ({
    question: turn.q,
    answer: turn.a
  }));
}

/** Return the cursor for the visible note/turn list. */
export function asideCursor(surface: AsideSurfaceState): number {
  return isAsideV2(surface) ? surface.turnCursor : surface.noteCursor;
}

/** Set the cursor for the visible note/turn list. */
export function setAsideCursor(surface: AsideSurfaceState, cursor: number): void {
  if (isAsideV2(surface)) surface.turnCursor = cursor;
  else surface.noteCursor = cursor;
}

/** Read the predecessor Clear confirmation without widening the union. */
export function asideConfirmClear(surface: AsideSurfaceState): boolean {
  return !isAsideV2(surface) && surface.confirmClear;
}

export function createAsideSurface(
  storyId: string,
  storyTitle: string,
  notes?: readonly AsideNoteView[],
  pendingAsk?: string | null,
  openingPartId?: string | null
): LegacyAsideSurfaceState;
export function createAsideSurface(
  storyId: string,
  storyTitle: string,
  sessions: readonly AsideSessionView[],
  pendingAsk: string | null,
  openingPartId: string | null,
  options: CreateAsideSurfaceOptions & { readonly v2: true }
): AsideSessionSurfaceState;
export function createAsideSurface(
  storyId: string,
  storyTitle: string,
  notesOrSessions: readonly AsideNoteView[] | readonly AsideSessionView[] = [],
  pendingAsk: string | null = null,
  openingPartId: string | null = null,
  options: CreateAsideSurfaceOptions = {}
): AsideSurfaceState {
  const raw = notesOrSessions as readonly unknown[];
  const isV2 = options.v2 === true || options.sessions !== undefined
    || raw.some((entry) => looksLikeSession(entry));
  const suppliedSessions = options.sessions ?? (isV2 ? raw : []);
  const sessions = suppliedSessions.flatMap((entry, index) => {
    const normalized = normalizeAsideSession(entry, index);
    return normalized === null ? [] : [normalized];
  });
  const notes = isV2
    ? []
    : raw.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const question = asString(record.question);
      const answer = asString(record.answer);
      return question.length === 0 && answer.length === 0 ? [] : [{ question, answer }];
    });
  const anchors = (options.anchors ?? []).flatMap((entry) => {
    if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const anchor = normalizeAsideAnchor(record);
      if (anchor !== null) {
        return [{
          ...anchor,
          sessionCount: typeof record.sessionCount === "number" ? record.sessionCount : 0,
          title: typeof record.title === "string" ? record.title : undefined,
          unanchored: record.unanchored === true
        } satisfies AsideAnchorView];
      }
    }
    return [];
  });
  const sessionIndex = Math.max(0, Math.min(
    Math.max(0, sessions.length - 1),
    options.sessionIndex ?? (sessions.length > 0 && isV2 ? sessions.length - 1 : 0)
  ));
  const currentTurns = sessions[sessionIndex]?.turns ?? [];
  const anchor = options.anchor !== undefined
    ? options.anchor : sessions[sessionIndex]?.anchor ?? null;
  const common = {
    storyId,
    storyTitle,
    composer: createComposer(),
    streamText: "",
    streamThoughts: "",
    streamThoughtTokens: 0,
    streamPhase: null,
    inflightQuestion: null,
    scrollTop: null,
    busy: false,
    pendingAsk,
    focus: isV2 && currentTurns.length > 0 ? "turns" : "composer",
    useMenu: null,
    openingPartId
  };
  if (isV2) {
    return {
      ...common,
      modelVersion: 2,
      sessions,
      sessionIndex,
      turnCursor: Math.max(0, currentTurns.length - 1),
      anchors,
      anchorIndex: asideHopAnchorIndex(anchors, anchor),
      thoughtsVisible: options.thoughtsVisible ?? false,
      confirmReset: null,
      confirmDelete: null,
      deleteUndo: null,
      retakePrompt: null,
      anchor
    } as AsideSessionSurfaceState;
  }
  return {
    ...common,
    modelVersion: 1,
    notes: notes.map((note) => ({ question: note.question, answer: note.answer })),
    noteCursor: Math.max(0, notes.length - 1),
    confirmClear: false
  } as LegacyAsideSurfaceState;
}

/** Whether the surface has the v2 session model. */
export function isAsideV2(surface: AsideSurfaceState): surface is AsideSessionSurfaceState {
  return surface.modelVersion === 2;
}

export function currentAsideSession(surface: AsideSurfaceState): AsideSessionView | null {
  return isAsideV2(surface)
    ? surface.sessions[surface.sessionIndex] ?? null
    : (
    surface.notes.length === 0
      ? null
      : sessionFromAsideNotes(surface.notes)
    );
}

export function currentAsideTurns(surface: AsideSurfaceState): readonly AsideTurnView[] {
  return currentAsideSession(surface)?.turns ?? [];
}

function asideAnswerOwner(surface: AsideSurfaceState): string {
  if (!isAsideV2(surface)) return "legacy";
  return surface.sessions[surface.sessionIndex]?.id ?? `session-${surface.sessionIndex}`;
}

/** Stable row and selection identity for a saved answer in one Aside session. */
export function asideAnswerRowId(
  surface: AsideSurfaceState,
  noteIndex: number
): string {
  if (!isAsideV2(surface)) {
    return `aside-answer:${asideAnswerOwner(surface)}:${noteIndex}`;
  }
  const turn = currentAsideTurns(surface)[noteIndex];
  if (turn === undefined) return `aside-answer:${asideAnswerOwner(surface)}:unknown`;
  return `aside-answer:${asideAnswerOwner(surface)}:${asideTurnRowIdentity(turn)}`;
}

/** Resolve a saved-answer identity against the current Aside session. */
export function asideAnswerIndexFromRowId(
  rowId: string,
  surface: AsideSurfaceState
): number {
  const prefix = `aside-answer:${asideAnswerOwner(surface)}:`;
  if (!rowId.startsWith(prefix)) return -1;
  const identity = rowId.slice(prefix.length);
  if (!isAsideV2(surface)) {
    const value = Number(identity);
    return Number.isInteger(value) && value >= 0 ? value : -1;
  }
  if (!identity.startsWith("id:") && !identity.startsWith("ref:")) return -1;
  return currentAsideTurns(surface).findIndex(
    (turn) => asideTurnRowIdentity(turn) === identity
  );
}

export function setAsideSessionTurns(
  surface: AsideSurfaceState,
  sessionIndex: number,
  turns: readonly AsideTurnView[]
): void {
  if (!isAsideV2(surface)) return;
  const session = surface.sessions[sessionIndex];
  if (session === undefined) return;
  surface.sessions[sessionIndex] = { ...session, turns: turns.slice() };
  if (sessionIndex === surface.sessionIndex) {
    surface.turnCursor = Math.max(
      0,
      Math.min(Math.max(0, turns.length - 1), surface.turnCursor)
    );
  }
}

/** Any composer edit makes an earlier Clear confirmation stale. */
export function disarmAsideClear(
  surface: object
): void {
  const value = surface as { readonly modelVersion?: 1 | 2; confirmClear?: boolean };
  if (value.modelVersion !== 2 && "confirmClear" in value) value.confirmClear = false;
}

export function asideHeaderLine(storyTitle: string): string {
  return `ASIDE · ${storyTitle} · non-canon`;
}

export const ASIDE_SAVED_NOTICE =
  "Side Notes are saved with this story. They never enter story prompts.";

export const ASIDE_INPUT_PLACEHOLDER = "Ask about this story";

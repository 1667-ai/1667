/** Pure Aside v2 data normalization and chat-row layout. */
import { wrapText } from "./wrap.js";
import { truncate, truncateTail, visibleWidth } from "./screens/story/frame.js";
import { asideHopStripText, UNANCHORED_ASIDE_ID } from "./aside-hop.js";
import {
  asideAnswerRowId,
  currentAsideSession,
  currentAsideTurns,
  normalizeAsideSession,
  sessionFromAsideNotes,
  type AsideAnswerSource,
  type AsideAnchorView,
  type AsideSessionAnchor,
  type AsideSessionSurfaceState,
  type AsideSessionView,
  type AsideTurnView
} from "./aside-surface.js";

export interface AsideChatLayout {
  header: string[];
  body: string[];
  rowKinds: readonly AsideChatRowKind[];
  turnStarts: readonly number[];
  turnContentEnds: readonly number[];
  rowTurnIndex: readonly (number | null)[];
  rowAnswerSources: readonly (AsideAnswerSource | null)[];
}

export type AsideChatRowKind = "question" | "thought" | "status" | "answer" | "plain";

function dimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function sameAnchor(left: AsideSessionAnchor, right: AsideSessionAnchor): boolean {
  return left.partId === right.partId && left.takeId === right.takeId;
}

/** Restore display-only position fields without changing the wire address. */
export function hydrateAsideAnchor(
  anchor: AsideSessionAnchor | null,
  anchors: readonly AsideAnchorView[],
  fallback: AsideSessionAnchor | null = null
): AsideSessionAnchor | null {
  if (anchor === null) return null;
  const presence = anchors.find((entry) =>
    entry.unanchored !== true && sameAnchor(entry, anchor)
  );
  const fallbackMatch = fallback !== null && sameAnchor(fallback, anchor)
    ? fallback : undefined;
  const partNumber = presence?.partNumber ?? fallbackMatch?.partNumber ?? anchor.partNumber;
  const takeIndex = presence?.takeIndex ?? fallbackMatch?.takeIndex ?? anchor.takeIndex;
  const takeCount = presence?.takeCount ?? fallbackMatch?.takeCount ?? anchor.takeCount;
  return {
    ...anchor,
    ...(partNumber === undefined ? {} : { partNumber }),
    ...(takeIndex === undefined ? {} : { takeIndex }),
    ...(takeCount === undefined ? {} : { takeCount })
  };
}

interface WrappedAsideRow {
  text: string;
  start: number;
  end: number;
}

function wrappedRowsWithOffsets(
  text: string,
  width: number,
  prefix = "",
  continuationPrefix = " ".repeat(prefix.length)
): WrappedAsideRow[] {
  const prefixWidth = prefix.length;
  const wrapped = wrapText(text, [], Math.max(1, width - prefixWidth));
  return wrapped.map((line, index) => ({
    text: `${index === 0 ? prefix : continuationPrefix}${line.text}`,
    start: line.start,
    end: line.end
  }));
}

function wrappedRows(
  text: string,
  width: number,
  prefix = "",
  continuationPrefix = " ".repeat(prefix.length)
): string[] {
  return wrappedRowsWithOffsets(text, width, prefix, continuationPrefix)
    .map((line) => line.text);
}

function anchorLabel(anchor: AsideSessionAnchor | null): string {
  if (anchor === null) return "¶ ? · take ?/?";
  const part = anchor.partNumber === undefined ? "?" : String(anchor.partNumber);
  const index = anchor.takeIndex === undefined ? "?" : String(anchor.takeIndex);
  const count = anchor.takeCount === undefined ? "?" : String(anchor.takeCount);
  return `¶ ${part} · take ${index}/${count}`;
}

function relativeTimestamp(value: string | undefined, now: number | undefined): string {
  if (value === undefined || now === undefined) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";
  return `${Math.floor(hours / 24)}d ago`;
}

function turnThoughtTokens(turn: AsideTurnView): number | undefined {
  return turn.thoughtTokens === undefined ? undefined : Math.max(0, turn.thoughtTokens);
}

export function asideSessionsFromResponse(
  response: unknown,
  fallbackAnchor: AsideSessionAnchor | null = null
): { sessions: AsideSessionView[]; anchors: AsideAnchorView[] } {
  if (response === null || typeof response !== "object") return { sessions: [], anchors: [] };
  const value = response as Record<string, unknown>;
  const rawSessions = Array.isArray(value.sessions) ? value.sessions : undefined;
  const canonicalSession = rawSessions === undefined
    && value.schemaVersion === 2 && Array.isArray(value.turns) ? [value] : [];
  const sessionEntries = rawSessions ?? canonicalSession;
  const sessions = sessionEntries.flatMap((entry, index) => {
    const normalized = normalizeAsideSession(entry, index);
    if (normalized === null) return [];
    const hasAnchor = entry !== null && typeof entry === "object"
      && Object.prototype.hasOwnProperty.call(entry, "anchor");
    return [{ ...normalized, anchor: hasAnchor ? normalized.anchor : fallbackAnchor }];
  });
  if (sessions.length === 0 && rawSessions === undefined && canonicalSession.length === 0
    && Array.isArray(value.notes)) {
    const notes = value.notes.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const note = entry as Record<string, unknown>;
      return typeof note.question === "string" && typeof note.answer === "string"
        ? [{ question: note.question, answer: note.answer }] : [];
    });
    if (notes.length > 0) sessions.push(sessionFromAsideNotes(notes, null));
  }
  const anchors: AsideAnchorView[] = Array.isArray(value.anchors)
    ? value.anchors.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const partId = typeof record.partId === "string" ? record.partId : "";
      const takeId = typeof record.takeId === "string" ? record.takeId : partId;
      if (partId.length === 0 && takeId.length === 0) return [];
      return [{
        partId: partId || takeId,
        takeId: takeId || partId,
        partNumber: typeof record.partNumber === "number" ? record.partNumber : undefined,
        takeIndex: typeof record.takeIndex === "number" ? record.takeIndex : undefined,
        takeCount: typeof record.takeCount === "number" ? record.takeCount : undefined,
        sessionCount: typeof record.sessionCount === "number" ? record.sessionCount : 0,
        title: typeof record.title === "string" ? record.title : undefined,
        unanchored: record.unanchored === true
      }];
    })
    : [];
  if (anchors.length === 0 && sessions.length > 0) {
    const grouped = new Map<string, AsideAnchorView>();
    for (const session of sessions) {
      const anchor = session.anchor;
      if (anchor === null) continue;
      const key = `${anchor.partId}:${anchor.takeId}`;
      const current = grouped.get(key);
      grouped.set(key, {
        ...anchor,
        sessionCount: (current?.sessionCount ?? 0) + 1,
        title: current?.title ?? session.title
      });
    }
    anchors.push(...grouped.values());
  }
  const declaredUnanchoredCount = typeof value.unanchoredCount === "number"
    && Number.isFinite(value.unanchoredCount)
    ? Math.max(0, Math.floor(value.unanchoredCount)) : 0;
  const sessionUnanchoredCount = sessions.filter((session) => session.anchor === null).length;
  const unanchoredCount = Math.max(declaredUnanchoredCount, sessionUnanchoredCount);
  if (unanchoredCount > 0 && !anchors.some((anchor) => anchor.unanchored === true)) {
    anchors.push({
      partId: UNANCHORED_ASIDE_ID,
      takeId: UNANCHORED_ASIDE_ID,
      sessionCount: unanchoredCount,
      unanchored: true
    });
  }
  const hydratedSessions = sessions.map((session) => ({
    ...session,
    anchor: hydrateAsideAnchor(session.anchor, anchors, fallbackAnchor)
  }));
  return { sessions: hydratedSessions, anchors };
}

export function asideHopStrip(surface: AsideSessionSurfaceState): string {
  return asideHopStripText(surface.anchors, surface.anchor);
}

function sessionCycler(surface: AsideSessionSurfaceState, includeTitle: boolean): string {
  const count = Math.max(1, surface.sessions.length);
  const index = Math.min(count, surface.sessionIndex + 1);
  const title = currentAsideSession(surface)?.title ?? "new session";
  return includeTitle
    ? `‹ session ${index}/${count} · ${title} ›`
    : `‹ session ${index}/${count} ›`;
}

function headerMain(surface: AsideSessionSurfaceState, width: number): string {
  const anchor = anchorLabel(surface.anchor);
  const full = `aside ━━━ ${surface.storyTitle} ━ ${anchor} ━ ${sessionCycler(surface, true)}`;
  const compact = `aside ━━━ ${anchor} ━ ${sessionCycler(surface, true)}`;
  const noStoryTitle = `aside ━━━ ${anchor} ━ ${sessionCycler(surface, false)}`;
  const anchorAndSession = `${anchor} ━ ${sessionCycler(surface, false)}`;
  const candidates = [full, compact, noStoryTitle, anchorAndSession];
  const available = Math.max(1, width);
  const fit = candidates.find((candidate) => visibleWidth(candidate) <= available);
  if (fit !== undefined) return fit;
  // Keep the anchor and closed-session cycler readable when a very narrow
  // terminal cannot fit the leading chrome or session title.
  return truncateTail(anchorAndSession, available);
}

export function asideV2HeaderLines(surface: AsideSessionSurfaceState, width: number): string[] {
  const badge = "non-canon";
  const available = Math.max(1, width - badge.length - 1);
  const left = headerMain(surface, available);
  const lines = [
    `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - badge.length))}${badge}`
  ];
  const hop = asideHopStripText(surface.anchors, surface.anchor, Math.max(1, width));
  if (hop.length > 0) {
    lines.push(truncate(hop, Math.max(1, width)), "");
  }
  return lines;
}

function questionRows(turn: AsideTurnView, width: number, focused: boolean, now?: number): string[] {
  const prefix = focused ? "▸ › " : "  › ";
  const timestamp = relativeTimestamp(turn.updatedAt ?? turn.createdAt, now);
  // Keep the four-cell question gutter on every visual row. Decoration adds
  // the focus marker to the first visible row after scrolling.
  const rows = wrappedRows(turn.q, width, prefix, "  › ");
  if (timestamp.length === 0 || rows.length !== 1) return rows;
  const available = Math.max(0, width - rows[0]!.length - timestamp.length - 1);
  if (available > 0) rows[0] = `${rows[0]}${" ".repeat(available + 1)}${timestamp}`;
  return rows;
}

function answerRows(turn: AsideTurnView, width: number): WrappedAsideRow[] {
  const rows: WrappedAsideRow[] = [];
  let answerOffset = 0;
  for (const paragraph of turn.a.split("\n")) {
    rows.push(...wrappedRowsWithOffsets(paragraph, width, "  ").map((row) => ({
      ...row,
      start: answerOffset + row.start,
      end: answerOffset + row.end
    })));
    answerOffset += paragraph.length + 1;
  }
  return rows.length > 0 ? rows : [{ text: "  ", start: 0, end: 0 }];
}

function thoughtRows(turn: AsideTurnView, width: number, visible: boolean, focused: boolean): string[] {
  const tokens = turnThoughtTokens(turn);
  if (tokens === undefined && (turn.thoughts ?? "").length === 0) return [];
  const suffix = focused && !visible ? " · t shows" : "";
  const tokenLabel = tokens === undefined ? "" : ` · ${tokens} tok`;
  const head = `  ┊ Thought${tokenLabel}${suffix}`;
  if (!visible || turn.thoughts === undefined || turn.thoughts.length === 0) return [head];
  return [head, ...wrappedRows(turn.thoughts, width, "  ┊ ")];
}

export function asideChatLayout(
  surface: AsideSessionSurfaceState,
  cols: number,
  presentedText: string,
  now?: number
): AsideChatLayout {
  const width = dimension(cols, 80);
  const body: string[] = [];
  const turnStarts: number[] = [];
  const turnContentEnds: number[] = [];
  const rowTurnIndex: (number | null)[] = [];
  const rowKinds: AsideChatRowKind[] = [];
  const rowAnswerSources: (AsideAnswerSource | null)[] = [];
  const turns = currentAsideTurns(surface);
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    const selected = !surface.busy && (surface.focus === "turns" || surface.focus === "notes")
      && index === surface.turnCursor;
    const questions = questionRows(turn, width, selected, now);
    const thoughts = thoughtRows(turn, width, surface.thoughtsVisible, selected);
    const answers = answerRows(turn, width);
    turnStarts.push(body.length);
    const rows = [
      ...questions,
      ...thoughts,
      ...answers.map((row) => row.text)
    ];
    body.push(...rows);
    const questionCount = questions.length;
    const thoughtCount = thoughts.length;
    for (let row = 0; row < rows.length; row += 1) {
      rowTurnIndex.push(index);
      rowKinds.push(
        row < questionCount ? "question"
          : row < questionCount + thoughtCount ? "thought" : "answer"
      );
      rowAnswerSources.push(
        row < questionCount + thoughtCount
          ? null
          : {
            key: asideAnswerRowId(surface, index),
            text: turn.a,
            start: answers[row - questionCount - thoughtCount]!.start
          }
      );
    }
    turnContentEnds.push(body.length);
    body.push("");
    rowTurnIndex.push(null);
    rowKinds.push("plain");
    rowAnswerSources.push(null);
  }
  if (surface.inflightQuestion !== null || presentedText.length > 0 || surface.busy) {
    const question = wrappedRows(surface.inflightQuestion ?? "", width, "▸ › ", "  › ");
    body.push(...question);
    for (let row = 0; row < question.length; row += 1) {
      rowTurnIndex.push(null);
      rowKinds.push("question");
      rowAnswerSources.push(null);
    }
    if (surface.busy) {
      const tokens = surface.streamThoughtTokens > 0 ? ` · ${surface.streamThoughtTokens} tok` : "";
      body.push(`  ⟳ ${surface.streamPhase ?? "thinking"}${tokens} · esc stops`);
      rowTurnIndex.push(null);
      rowKinds.push("status");
      rowAnswerSources.push(null);
      if (surface.thoughtsVisible && surface.streamThoughts.length > 0) {
        const thoughts = wrappedRows(surface.streamThoughts, width, "  ┊ ");
        thoughts[thoughts.length - 1] = `${thoughts[thoughts.length - 1]!}▏`;
        body.push(...thoughts);
        for (let row = 0; row < thoughts.length; row += 1) {
          rowTurnIndex.push(null);
          rowKinds.push("thought");
          rowAnswerSources.push(null);
        }
      }
    }
    if (presentedText.length > 0) {
      const answer = wrappedRows(presentedText, width, "  ");
      body.push(...answer);
      for (let row = 0; row < answer.length; row += 1) {
        rowTurnIndex.push(null);
        rowKinds.push("answer");
        rowAnswerSources.push(null);
      }
    }
  }
  if (body.length === 0) {
    body.push("(ask about this story)");
    rowTurnIndex.push(null);
    rowKinds.push("plain");
    rowAnswerSources.push(null);
  }
  return {
    header: asideV2HeaderLines(surface, width),
    body,
    rowKinds,
    turnStarts,
    turnContentEnds,
    rowTurnIndex,
    rowAnswerSources
  };
}

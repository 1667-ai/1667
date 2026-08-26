/** Apply one typed v2 response to the live session surface. */
import type {
  AsideAskResponse,
  AsideReadResponse,
  AsideSessionMutationResponse
} from "../../shared/aside-transport.js";
import type { StoryAsidePresenceAnchor, StoryPayload } from "../../shared/types.js";
import { asideHopAnchorIndex, UNANCHORED_ASIDE_ID } from "./aside-hop.js";
import {
  currentAsideSession,
  normalizeAsideSession,
  type AsideAnchorView,
  type AsideSessionAnchor,
  type AsideSessionSurfaceState,
  type AsideSessionView
} from "./aside-surface.js";
import { asideSessionsFromResponse, hydrateAsideAnchor } from "./aside-v2-layout.js";

type AsideSingleSessionResponse = AsideAskResponse | AsideSessionMutationResponse;

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function isFullReadResponse(value: unknown): value is AsideReadResponse {
  const record = responseRecord(value);
  return record?.schemaVersion === 2
    && Array.isArray(record.sessions)
    && Array.isArray(record.anchors);
}

function isSingleSessionResponse(value: unknown): value is AsideSingleSessionResponse {
  const record = responseRecord(value);
  return record?.schemaVersion === 2
    && typeof record.id === "string"
    && Array.isArray(record.turns);
}

function clampSessionIndex(length: number, preferred: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(length - 1, preferred));
}

function sessionIndexFor(
  sessions: readonly AsideSessionView[],
  currentId: string | undefined,
  preferred: number
): number {
  if (currentId !== undefined) {
    const matching = sessions.findIndex((session) => session.id === currentId);
    if (matching >= 0) return matching;
  }
  return clampSessionIndex(sessions.length, preferred);
}

function updateAnchorProjection(surface: AsideSessionSurfaceState): void {
  const current = currentAsideSession(surface);
  if (current !== null) surface.anchor = current.anchor;
  surface.anchorIndex = asideHopAnchorIndex(surface.anchors, surface.anchor);
}

function anchorKey(anchor: AsideSessionAnchor): string {
  return `${anchor.partId}\u0000${anchor.takeId}`;
}

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function projectedAnchor(
  entry: StoryAsidePresenceAnchor,
  previous: AsideAnchorView | undefined,
  current: AsideSessionAnchor | null
): AsideAnchorView {
  const currentMatch = current !== null && anchorKey(current) === anchorKey(entry)
    ? current : undefined;
  const partNumber = entry.partNumber ?? previous?.partNumber ?? currentMatch?.partNumber;
  const takeIndex = entry.takeIndex ?? previous?.takeIndex ?? currentMatch?.takeIndex;
  const takeCount = entry.takeCount ?? previous?.takeCount ?? currentMatch?.takeCount;
  return {
    partId: entry.partId,
    takeId: entry.takeId,
    sessionCount: count(entry.sessionCount),
    ...(partNumber === undefined ? {} : { partNumber }),
    ...(takeIndex === undefined ? {} : { takeIndex }),
    ...(takeCount === undefined ? {} : { takeCount }),
    ...(previous?.title === undefined ? {} : { title: previous.title })
  };
}

/** Reconcile the text-free story presence after an ask or local mutation.
 * The payload summary is authoritative for counts. Existing display ordinal
 * fields remain attached when the summary omits them. */
export function reconcileAsidePresence(
  surface: AsideSessionSurfaceState,
  payload: StoryPayload
): void {
  const summary = payload.asidePresence;
  if (summary === undefined) return;
  const previous = new Map<string, AsideAnchorView>();
  for (const anchor of surface.anchors) {
    if (anchor.unanchored !== true) previous.set(anchorKey(anchor), anchor);
  }
  const currentSession = currentAsideSession(surface);
  const currentSessionAnchor = currentSession === null
    ? surface.anchor : currentSession.anchor;
  const anchors: AsideAnchorView[] = summary.anchors.map((entry) => {
    const old = previous.get(anchorKey(entry));
    return projectedAnchor(entry, old, currentSessionAnchor);
  });
  const unanchoredCount = count(summary.unanchoredCount);
  if (unanchoredCount > 0) {
    const oldUnanchored = surface.anchors.find((anchor) => anchor.unanchored === true);
    anchors.push({
      partId: UNANCHORED_ASIDE_ID,
      takeId: UNANCHORED_ASIDE_ID,
      sessionCount: unanchoredCount,
      ...(oldUnanchored?.title === undefined ? {} : { title: oldUnanchored.title }),
      unanchored: true
    });
  }
  surface.anchors = anchors;
  surface.anchorIndex = asideHopAnchorIndex(surface.anchors, surface.anchor);
}

function applyFullRead(
  surface: AsideSessionSurfaceState,
  response: AsideReadResponse
): void {
  const currentId = currentAsideSession(surface)?.id;
  const model = asideSessionsFromResponse(response, response.anchor);
  surface.sessions = model.sessions;
  surface.sessionIndex = sessionIndexFor(surface.sessions, currentId, surface.sessionIndex);
  surface.anchors = model.anchors;
  const current = currentAsideSession(surface);
  surface.anchor = current?.anchor ?? response.anchor;
  surface.anchorIndex = asideHopAnchorIndex(surface.anchors, surface.anchor);
  surface.turnCursor = Math.max(0, (current?.turns.length ?? 0) - 1);
}

function applySingleSession(
  surface: AsideSessionSurfaceState,
  response: AsideSingleSessionResponse
): void {
  const normalized = normalizeAsideSession(response, surface.sessions.length);
  if (normalized === null) return;
  const session: AsideSessionView = {
    ...normalized,
    anchor: hydrateAsideAnchor(normalized.anchor, surface.anchors, surface.anchor)
  };
  const currentIndex = surface.sessionIndex;
  const matching = surface.sessions.findIndex((entry) => entry.id === session.id);
  const sessionIndex = matching >= 0 ? matching : surface.sessions.length;
  if (matching >= 0) surface.sessions[matching] = session;
  else surface.sessions = [...surface.sessions, session];

  // A single-session result never carries the full presence index. Keep the
  // existing anchors and change focus only when the result is current/new.
  if (sessionIndex === currentIndex || matching < 0) {
    surface.sessionIndex = sessionIndex;
    surface.anchor = session.anchor;
    surface.turnCursor = Math.max(0, session.turns.length - 1);
  }
  updateAnchorProjection(surface);
}

/** Return false for a legacy or malformed result. */
export function applyAsideV2Settlement(
  surface: AsideSessionSurfaceState,
  value: unknown
): boolean {
  if (isFullReadResponse(value)) {
    applyFullRead(surface, value);
    return true;
  }
  if (isSingleSessionResponse(value)) {
    applySingleSession(surface, value);
    return true;
  }
  return false;
}

/**
 * Pending Aside objects for one in-memory Story, cleared once encode stores
 * their content-addressed objects. Mirrors the token-probability side table.
 */
import {
  hashAsideSessionDocument,
  type AsideDocument,
  type AsideSessionDocument
} from "../shared/aside.js";
import type { AsideSessionRef } from "../shared/aside-session-index.js";
import type { Story } from "../shared/types.js";
import {
  cloneAsideSessionDocument,
  cloneAsideSessionRef
} from "./aside-session-store.js";

const pendingAside = new WeakMap<Story, AsideDocument>();

/**
 * One pending replacement owns both halves of a v2 session update. Keeping
 * them together prevents a manifest encode from pairing a new object with a
 * stale text-free ref (or the reverse).
 */
export interface PendingAsideSession {
  readonly ref: AsideSessionRef;
  readonly document: AsideSessionDocument;
}

const pendingAsideSession = new WeakMap<Story, Map<string, PendingAsideSession>>();

export function setPendingAsideDocument(story: Story, document: AsideDocument): void {
  pendingAside.set(story, document);
}

export function peekPendingAsideDocument(story: Story): AsideDocument | undefined {
  return pendingAside.get(story);
}

export function clearPendingAsideDocument(story: Story): void {
  pendingAside.delete(story);
}

/** Stage one v2 session reference and its content-addressed document as one
 * aggregate value. The ref identity and document bytes are checked together.
 */
export function setPendingAsideSession(
  story: Story,
  ref: AsideSessionRef,
  document: AsideSessionDocument
): void {
  if (ref.id.length === 0) throw new TypeError("Pending Aside session id is required");
  const documentId = hashAsideSessionDocument(document);
  if (ref.documentId !== documentId) {
    throw new TypeError("Pending Aside session ref does not match its document");
  }
  if (ref.turnCount !== document.turns.length) {
    throw new TypeError("Pending Aside session ref turn count does not match its document");
  }
  const pending = pendingAsideSession.get(story) ?? new Map<string, PendingAsideSession>();
  pending.set(ref.id, {
    ref: cloneAsideSessionRef(ref),
    document: cloneAsideSessionDocument(document)
  });
  pendingAsideSession.set(story, pending);
}

/** Set the pending v2 session bytes consumed by the successor codec. */
export function setPendingAsideSessionDocument(
  story: Story,
  sessionId: string,
  document: AsideSessionDocument
): void {
  setPendingAsideSession(story, {
    id: sessionId,
    documentId: hashAsideSessionDocument(document),
    anchor: document.anchor === null ? null : { ...document.anchor },
    turnCount: document.turns.length
  }, document);
}

/** Read all staged v2 session ref/document pairs without exposing mutable
 * storage. The aggregate encoder consumes each pair after publication. */
export function peekPendingAsideSessions(
  story: Story
): ReadonlyMap<string, PendingAsideSession> {
  return pendingAsideSession.get(story) ?? new Map();
}

export function clearPendingAsideSessionDocument(story: Story, sessionId?: string): void {
  if (sessionId === undefined) {
    pendingAsideSession.delete(story);
    return;
  }
  const pending = pendingAsideSession.get(story);
  if (pending === undefined) return;
  pending.delete(sessionId);
  if (pending.size === 0) pendingAsideSession.delete(story);
}

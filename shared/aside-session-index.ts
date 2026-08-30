/** Text-free v2 session index and READ presence projections. */
import type { AsideAnchor } from "./aside-session.js";

/** A text-free session reference used by an index or hop-strip projection. */
export interface AsideSessionRef {
  /** Stable session target used by API requests and UI hops. */
  readonly id: string;
  /** Content-addressed immutable session document object. */
  readonly documentId: string;
  readonly anchor: AsideAnchor | null;
  /** V1 document id used when this legacy ref was materialized. */
  readonly sourceAsideDocumentId?: string;
  /**
   * Original anchor for a session currently in the unanchored bucket because
   * its take was pruned. This field carries no session text.
   */
  readonly originAnchor?: AsideAnchor | null;
  readonly turnCount: number;
}

/** Clone a text-free session reference before exposing it to mutable state. */
export function cloneAsideSessionRef(ref: AsideSessionRef): AsideSessionRef {
  return {
    id: ref.id,
    documentId: ref.documentId,
    anchor: ref.anchor === null ? null : { partId: ref.anchor.partId, takeId: ref.anchor.takeId },
    ...(ref.sourceAsideDocumentId === undefined
      ? {}
      : { sourceAsideDocumentId: ref.sourceAsideDocumentId }),
    ...(ref.originAnchor === undefined
      ? {}
      : {
          originAnchor: ref.originAnchor === null
            ? null
            : { partId: ref.originAnchor.partId, takeId: ref.originAnchor.takeId }
        }),
    turnCount: ref.turnCount
  };
}

/** Story-level session grouping. Session text remains in per-session objects. */
export interface AsideSessionIndex {
  readonly schemaVersion: 2;
  readonly sessions: readonly AsideSessionRef[];
  readonly unanchored: readonly AsideSessionRef[];
}

/** Text-free counts suitable for StoryPayload presence. */
export interface AsidePresenceSummary {
  readonly anchors: readonly {
    readonly partId: string;
    readonly takeId: string;
    readonly sessionCount: number;
  }[];
  readonly unanchoredCount: number;
}

/** Build a stable summary without loading any session text. */
export function asidePresenceFromIndex(index: AsideSessionIndex): AsidePresenceSummary {
  const counts = new Map<string, { partId: string; takeId: string; sessionCount: number }>();
  for (const ref of index.sessions) {
    if (ref.anchor === null) continue;
    const key = `${ref.anchor.partId}\u0000${ref.anchor.takeId}`;
    const current = counts.get(key);
    if (current === undefined) {
      counts.set(key, {
        partId: ref.anchor.partId,
        takeId: ref.anchor.takeId,
        sessionCount: 1
      });
    } else {
      current.sessionCount += 1;
    }
  }
  return {
    anchors: [...counts.values()],
    unanchoredCount: index.unanchored.length
  };
}

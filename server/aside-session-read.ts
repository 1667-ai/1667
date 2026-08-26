/** Explicit v2 Aside reads. Presence is manifest-only; session text is read
 * only for the requested anchor or unanchored bucket. */
import {
  assertAsideAnchor,
  AsideDocumentError,
  migrateAsideDocumentToUnanchored,
  type AsideAnchor
} from "../shared/aside.js";
import type {
  AsidePresenceAnchorResponse,
  AsideReadResponse,
  AsideSessionResponse
} from "../shared/aside-transport.js";
import { takeIndex, pathTo } from "../shared/story-tree.js";
import type { Story } from "../shared/types.js";
import type { AsideSessionRef } from "../shared/aside-session-index.js";
import { viewAsideSessionDocument } from "./aside-session-http.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import { ServiceError } from "./errors.js";
import {
  allAsideSessionRefs,
  effectiveAsideSessionAnchor,
  visibleLegacyAsideSessionId,
  sameAsideAnchor
} from "./aside-session-store.js";
import type { StoryStore } from "./stories.js";

export async function readAsideSessions(
  stories: StoryStore,
  storyId: string,
  requestedAnchor?: AsideAnchor | null
): Promise<AsideReadResponse> {
  try {
    if (requestedAnchor !== undefined) assertAsideAnchor(requestedAnchor);
  } catch (error) {
    if (error instanceof AsideDocumentError) {
      throw new ServiceError(400, error.message, "invalid_request");
    }
    throw error;
  }
  return await stories.withAggregateSession(storyId, async (session) =>
    await readAsideSessionsInSession(session, requestedAnchor)
  );
}

async function readAsideSessionsInSession(
  session: StoryAggregateSession,
  requestedAnchor?: AsideAnchor | null
): Promise<AsideReadResponse> {
  const story = await session.loadLive();
  const refs = allAsideSessionRefs(story);
  const legacyDocumentId = story.asideDocumentId;
  // Older refs have no source id. Keep the virtual V1 view in that case so a
  // later V1 write cannot disappear behind a materialized legacy ref. When a
  // materialized ref exists, use a hash-qualified target for the virtual view
  // so the two chats cannot resolve to the same first-match id.
  const virtualLegacySessionId = visibleLegacyAsideSessionId(story, refs);

  const sessions: AsideSessionResponse[] = [];
  for (const ref of refs) {
    const effectiveAnchor = effectiveAsideSessionAnchor(story, ref);
    if (!matchesRequestedAnchor(effectiveAnchor, requestedAnchor)) continue;
    const document = await session.readAsideSessionDocument(ref.documentId);
    const view = viewAsideSessionDocument(document, ref.id);
    if (view === null) continue;
    sessions.push({
      ...view,
      anchor: effectiveAnchor
    });
  }

  if (virtualLegacySessionId !== null
    && legacyDocumentId !== undefined
    && legacyDocumentId !== null) {
    const legacy = await session.readAsideDocument(legacyDocumentId);
    const migrated = migrateAsideDocumentToUnanchored(legacy);
    if (migrated !== null && migrated.turns.length > 0
      && matchesRequestedAnchor(null, requestedAnchor)) {
      const view = viewAsideSessionDocument(migrated, virtualLegacySessionId);
      if (view !== null) sessions.push(view);
    }
  }

  const anchors = presenceAnchors(story, refs);
  const unanchoredCount = refs.filter((ref) =>
    effectiveAsideSessionAnchor(story, ref) === null
  ).length + (virtualLegacySessionId === null ? 0 : 1);
  return {
    schemaVersion: 2,
    anchor: requestedAnchor === undefined || requestedAnchor === null
      ? requestedAnchor ?? null
      : { ...requestedAnchor },
    sessions,
    anchors,
    unanchoredCount
  };
}

function matchesRequestedAnchor(
  actual: AsideAnchor | null,
  requested: AsideAnchor | null | undefined
): boolean {
  if (requested === undefined) return true;
  return sameAsideAnchor(actual, requested);
}

function presenceAnchors(
  story: Story,
  refs: readonly AsideSessionRef[]
): readonly AsidePresenceAnchorResponse[] {
  const grouped = new Map<string, {
    partId: string;
    takeId: string;
    sessionCount: number;
  }>();
  for (const ref of refs) {
    const anchor = effectiveAsideSessionAnchor(story, ref);
    if (anchor === null) continue;
    const key = `${anchor.partId}\u0000${anchor.takeId}`;
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, { ...anchor, sessionCount: 1 });
    } else {
      current.sessionCount += 1;
    }
  }
  const entries = [...grouped.values()].map((entry) => {
    const take = story.nodes.find((node) => node.id === entry.takeId);
    const position = take === undefined ? null : takeIndex(story, take.id);
    const partNumber = partNumberFor(story, entry.partId, entry.takeId);
    return {
      ...entry,
      ...(partNumber === null ? {} : { partNumber }),
      ...(position === null ? {} : {
        takeIndex: position.index,
        takeCount: position.count
      })
    };
  });
  entries.sort((left, right) => {
    const partDelta = (left.partNumber ?? Number.MAX_SAFE_INTEGER)
      - (right.partNumber ?? Number.MAX_SAFE_INTEGER);
    if (partDelta !== 0) return partDelta;
    const takeDelta = (left.takeIndex ?? Number.MAX_SAFE_INTEGER)
      - (right.takeIndex ?? Number.MAX_SAFE_INTEGER);
    if (takeDelta !== 0) return takeDelta;
    return left.takeId.localeCompare(right.takeId);
  });
  return entries;
}

function partNumberFor(story: Story, partId: string, takeId: string): number | null {
  const candidate = story.nodes.some((node) => node.id === partId)
    ? partId
    : takeId;
  try {
    return pathTo(story, candidate).length;
  } catch {
    return null;
  }
}

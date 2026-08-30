/**
 * Story-level Aside v2 reference helpers.
 *
 * Session text stays in Aside objects. This module only updates the manifest
 * reference lists and builds text-bearing views after an explicit object read.
 */
import type { AsideAnchor, AsideSessionDocument } from "../shared/aside-session.js";
import { cloneAsideSessionRef, type AsideSessionRef } from "../shared/aside-session-index.js";
import { isChapterSummary } from "../shared/story-tree.js";
import type { Story } from "../shared/types.js";
import { MAX_SESSION_REFS_PER_BUCKET } from "./story-v11-strict.js";

/** Stable id used for a virtual view of the predecessor V1 document. */
export const LEGACY_ASIDE_SESSION_ID = "legacy";
/** Stable transport prefix for a virtual V1 view beside a materialized ref. */
export const LEGACY_ASIDE_VIRTUAL_SESSION_PREFIX = "legacy-v1:";

export function virtualLegacyAsideSessionId(
  documentId: string,
  refs: readonly AsideSessionRef[] = []
): string {
  const base = `${LEGACY_ASIDE_VIRTUAL_SESSION_PREFIX}${documentId}`;
  if (!refs.some((ref) => ref.id === base)) return base;
  let suffix = 1;
  let candidate = `${base}:v${suffix}`;
  while (refs.some((ref) => ref.id === candidate)) {
    suffix += 1;
    candidate = `${base}:v${suffix}`;
  }
  return candidate;
}

export function isLegacyAsideVirtualSessionId(sessionId: string): boolean {
  return /^legacy-v1:[a-f0-9]{64}(?::v[1-9][0-9]*)?$/u.test(sessionId);
}

export function hasLegacyAsideVirtualSessionPrefix(sessionId: string): boolean {
  return sessionId.startsWith(LEGACY_ASIDE_VIRTUAL_SESSION_PREFIX);
}

/** Return the one virtual V1 target that the current story exposes. */
export function visibleLegacyAsideSessionId(
  story: Story,
  refs: readonly AsideSessionRef[] = allAsideSessionRefs(story)
): string | null {
  const documentId = story.asideDocumentId;
  if (documentId === undefined || documentId === null
    || refs.some((ref) => ref.sourceAsideDocumentId === documentId)) {
    return null;
  }
  return refs.some((ref) => ref.id === LEGACY_ASIDE_SESSION_ID)
    ? virtualLegacyAsideSessionId(documentId, refs)
    : LEGACY_ASIDE_SESSION_ID;
}

/** Resolve a virtual V1 target only while it still names the current object. */
export function legacyAsideDocumentIdForSession(
  story: Story,
  sessionId: string
): string | null {
  const documentId = story.asideDocumentId;
  if (documentId === undefined || documentId === null) return null;
  return visibleLegacyAsideSessionId(story) === sessionId ? documentId : null;
}

export interface AsideSessionRefView extends AsideSessionRef {
  /** Effective address for presence and read projections. */
  readonly effectiveAnchor: AsideAnchor | null;
}

export function allAsideSessionRefs(story: Story): AsideSessionRef[] {
  const refs = [
    ...(story.asideSessionRefs ?? []).map(cloneAsideSessionRef),
    ...(story.asideUnanchoredSessionRefs ?? []).map((ref) => ({
      ...cloneAsideSessionRef(ref),
      anchor: null
    }))
  ];
  return refs.map((ref) => {
    const anchor = effectiveAsideSessionAnchor(story, ref);
    const originAnchor = ref.originAnchor !== undefined
      ? ref.originAnchor
      : ref.anchor !== null && anchor === null
        ? ref.anchor
        : undefined;
    return {
      ...ref,
      anchor,
      ...(originAnchor === undefined
        ? {}
        : { originAnchor: cloneAnchor(originAnchor) })
    };
  });
}

export function asideSessionRefById(
  story: Story,
  sessionId: string
): AsideSessionRef | null {
  return allAsideSessionRefs(story).find((ref) => ref.id === sessionId) ?? null;
}

/**
 * Resolve a stored ref for the current tree. A ref whose take was pruned is
 * exposed in the unanchored bucket without changing the immutable document.
 */
export function effectiveAsideSessionAnchor(
  story: Story,
  ref: AsideSessionRef,
  documentAnchor?: AsideAnchor | null
): AsideAnchor | null {
  // `originAnchor` survives the move to the unanchored bucket. Resolve it
  // against the current tree without loading the session object.
  const candidate = ref.anchor !== null
    ? ref.anchor
    : ref.originAnchor !== undefined
      ? ref.originAnchor
      : documentAnchor ?? null;
  if (candidate === null) return null;
  const take = story.nodes.find((node) => node.id === candidate.takeId);
  return take === undefined || isChapterSummary(take)
    ? null
    : cloneAnchor(candidate);
}

export function asideSessionRefView(
  story: Story,
  ref: AsideSessionRef,
  documentAnchor?: AsideAnchor | null
): AsideSessionRefView {
  return {
    ...cloneAsideSessionRef(ref),
    effectiveAnchor: effectiveAsideSessionAnchor(story, ref, documentAnchor)
  };
}

type AsideSessionBucket = "anchored" | "unanchored";

/** Keep an existing ref in its stored bucket when the effective bucket is full. */
export function retainAsideSessionBucket(
  next: AsideSessionRef,
  current: AsideSessionRef | undefined,
  currentBucket: AsideSessionBucket | undefined,
  anchoredCount: number,
  unanchoredCount: number
): AsideSessionRef {
  if (current === undefined || currentBucket === undefined) return next;
  const targetBucket: AsideSessionBucket = next.anchor === null ? "unanchored" : "anchored";
  if (targetBucket === currentBucket) return next;
  const destinationCount = targetBucket === "anchored"
    ? anchoredCount
    : unanchoredCount;
  if (destinationCount < MAX_SESSION_REFS_PER_BUCKET) {
    if (targetBucket === "unanchored"
      && (next.originAnchor === undefined || next.originAnchor === null)
      && current.anchor !== null) {
      return { ...next, originAnchor: cloneAnchor(current.anchor) };
    }
    return next;
  }
  if (currentBucket === "anchored" && current.anchor !== null) {
    return {
      ...next,
      anchor: cloneAnchor(current.anchor),
      ...(next.originAnchor === undefined || next.originAnchor === null
        ? { originAnchor: cloneAnchor(current.anchor) }
        : {})
    };
  }
  const fallbackAnchor = next.anchor ?? current.originAnchor ?? null;
  return {
    ...next,
    anchor: null,
    ...((next.originAnchor === undefined || next.originAnchor === null)
      && fallbackAnchor !== null
      ? { originAnchor: cloneAnchor(fallbackAnchor) }
      : {})
  };
}

/** Replace one ref while preserving its anchored/unanchored list placement. */
export function setAsideSessionRef(
  story: Story,
  ref: AsideSessionRef
): void {
  const anchored = (story.asideSessionRefs ?? []).filter((candidate) => candidate.id !== ref.id);
  const unanchored = (story.asideUnanchoredSessionRefs ?? [])
    .filter((candidate) => candidate.id !== ref.id);
  const current = (story.asideSessionRefs ?? []).find((candidate) => candidate.id === ref.id)
    ?? (story.asideUnanchoredSessionRefs ?? []).find((candidate) => candidate.id === ref.id);
  const currentBucket = current === undefined
    ? undefined
    : (story.asideSessionRefs ?? []).some((candidate) => candidate.id === ref.id)
      ? "anchored"
      : "unanchored";
  const next = retainAsideSessionBucket(
    cloneAsideSessionRef(ref),
    current,
    currentBucket,
    anchored.length,
    unanchored.length
  );
  if (next.anchor === null) unanchored.push(next);
  else anchored.push(next);
  story.asideSessionRefs = anchored;
  story.asideUnanchoredSessionRefs = unanchored;
}

export function removeAsideSessionRef(
  story: Story,
  sessionId: string
): boolean {
  const anchored = story.asideSessionRefs ?? [];
  const unanchored = story.asideUnanchoredSessionRefs ?? [];
  const nextAnchored = anchored.filter((ref) => ref.id !== sessionId);
  const nextUnanchored = unanchored.filter((ref) => ref.id !== sessionId);
  const changed = nextAnchored.length !== anchored.length
    || nextUnanchored.length !== unanchored.length;
  if (changed) {
    story.asideSessionRefs = nextAnchored;
    story.asideUnanchoredSessionRefs = nextUnanchored;
  }
  return changed;
}

/** Move refs for missing takes to the unanchored manifest list. */
export function reanchorPrunedAsideSessions(story: Story): boolean {
  const anchored = story.asideSessionRefs ?? [];
  const kept: AsideSessionRef[] = [];
  const moved: Array<{ original: AsideSessionRef; unanchored: AsideSessionRef }> = [];
  for (const ref of anchored) {
    if (ref.anchor !== null
      && !story.nodes.some((node) => node.id === ref.anchor!.takeId)) {
      const original = cloneAsideSessionRef(ref);
      moved.push({
        original,
        unanchored: {
          ...original,
          anchor: null,
          originAnchor: ref.originAnchor ?? cloneAnchor(ref.anchor)
        }
      });
    } else {
      kept.push(cloneAsideSessionRef(ref));
    }
  }
  const unanchored: AsideSessionRef[] = [];
  const reattached: AsideSessionRef[] = [];
  const reattachCandidates: Array<{ ref: AsideSessionRef; anchor: AsideAnchor }> = [];
  for (const ref of story.asideUnanchoredSessionRefs ?? []) {
    const anchor = effectiveAsideSessionAnchor(story, ref);
    if (ref.originAnchor !== undefined && anchor !== null) {
      reattachCandidates.push({ ref: cloneAsideSessionRef(ref), anchor });
    } else {
      unanchored.push(cloneAsideSessionRef(ref));
    }
  }
  let changed = false;
  for (const candidate of reattachCandidates) {
    if (kept.length + reattached.length >= MAX_SESSION_REFS_PER_BUCKET) {
      unanchored.push(candidate.ref);
      continue;
    }
    const { originAnchor: _originAnchor, ...withoutOrigin } = candidate.ref;
    reattached.push({
      ...withoutOrigin,
      anchor: candidate.anchor
    });
    changed = true;
  }
  for (const candidate of moved) {
    if (unanchored.length >= MAX_SESSION_REFS_PER_BUCKET) {
      kept.push(candidate.original);
      continue;
    }
    unanchored.push(candidate.unanchored);
    changed = true;
  }
  if (!changed) return false;
  story.asideSessionRefs = [...kept, ...reattached];
  story.asideUnanchoredSessionRefs = unanchored;
  return true;
}

export function sameAsideAnchor(
  left: AsideAnchor | null,
  right: AsideAnchor | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.partId === right.partId && left.takeId === right.takeId;
}

export function cloneAnchor(anchor: AsideAnchor | null): AsideAnchor | null {
  return anchor === null ? null : { partId: anchor.partId, takeId: anchor.takeId };
}

export { cloneAsideSessionRef };

export function cloneAsideSessionDocument(
  document: AsideSessionDocument,
  anchor: AsideAnchor | null = document.anchor
): AsideSessionDocument {
  return {
    schemaVersion: 2,
    anchor: cloneAnchor(anchor),
    title: document.title,
    turns: document.turns.map((turn) => ({
      q: turn.q,
      a: turn.a,
      ...(turn.thoughts === undefined ? {} : { thoughts: turn.thoughts }),
      ...(turn.thoughtTokens === undefined ? {} : { thoughtTokens: turn.thoughtTokens })
    }))
  };
}

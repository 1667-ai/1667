import type { AsideAnchor } from "../../../shared/aside-anchor.js";
import {
  UNANCHORED_ASIDE_ID,
  asideHopEntries,
  asideHopTarget,
  orderAsideAnchors,
  type AsideAnchorView,
  type AsideHopEntry
} from "../../../shared/aside-hop-model.js";
import type { AsidePresenceAnchorResponse } from "../../../shared/aside-transport.js";
import type { StoryPart } from "../../../shared/manuscript-model.js";
import { isChapterSummary } from "../../../shared/story-tree.js";
import type { StoryPayload } from "../../../shared/types.js";
import type { AsideAnchorLabel, AsideSurface } from "./state.js";

/** The anchor of a part: the web's part id is its take id, and the TUI anchors
 * a part row on that same id for both fields. */
export function anchorOfPart(partId: string): AsideAnchor {
  return { partId, takeId: partId };
}

export function labelOfPart(part: Pick<StoryPart, "number" | "takeIndex" | "siblingCount">): AsideAnchorLabel {
  return { partNumber: part.number, takeIndex: part.takeIndex, takeCount: part.siblingCount };
}

type Counts = {
  readonly anchors: readonly AsidePresenceAnchorResponse[];
  readonly unanchoredCount: number;
};

/** The hop anchors: every take with sessions, then the unanchored bucket. */
export function anchorViews(presence: Counts): AsideAnchorView[] {
  const views: AsideAnchorView[] = presence.anchors.map((entry) => ({
    partId: entry.partId,
    takeId: entry.takeId,
    sessionCount: entry.sessionCount,
    ...(entry.partNumber === undefined ? {} : { partNumber: entry.partNumber }),
    ...(entry.takeIndex === undefined ? {} : { takeIndex: entry.takeIndex }),
    ...(entry.takeCount === undefined ? {} : { takeCount: entry.takeCount })
  }));
  if (presence.unanchoredCount > 0) {
    views.push({
      partId: UNANCHORED_ASIDE_ID,
      takeId: UNANCHORED_ASIDE_ID,
      sessionCount: presence.unanchoredCount,
      unanchored: true
    });
  }
  return views;
}

/** The wire anchor a hop entry stands for. The unanchored entry is `null`. */
export function anchorOfView(view: AsideAnchorView): AsideAnchor | null {
  return view.unanchored === true ? null : { partId: view.partId, takeId: view.takeId };
}

/** The label of an anchor from the presence list, when it knows the numbers. */
export function labelFromViews(views: readonly AsideAnchorView[], anchor: AsideAnchor | null): AsideAnchorLabel | null {
  if (anchor === null) return null;
  const match = views.find((view) => view.unanchored !== true && view.partId === anchor.partId && view.takeId === anchor.takeId);
  if (match === undefined || match.partNumber === undefined) return null;
  return {
    partNumber: match.partNumber,
    ...(match.takeIndex === undefined ? {} : { takeIndex: match.takeIndex }),
    ...(match.takeCount === undefined ? {} : { takeCount: match.takeCount })
  };
}

/** "Part 2 · take 1/2", "Part 2" (one take), "Unanchored", or "Part ?" when
 * the anchor's numbers are not known. */
export function surfaceHeading(surface: AsideSurface): string {
  if (surface.anchor === null) return "Unanchored";
  const { partNumber, takeIndex, takeCount } = surface.label;
  const part = `Part ${partNumber ?? "?"}`;
  if (takeIndex === undefined || takeCount === undefined || takeCount <= 1) return part;
  return `${part} · take ${takeIndex}/${takeCount}`;
}

export function hopEntries(surface: AsideSurface): AsideHopEntry[] {
  return asideHopEntries(surface.anchors, surface.anchor);
}

/** The entry `[` or `]` leads to from the current anchor, or `null` when the
 * current anchor is the only one. The list wraps. */
export function neighbourEntry(surface: AsideSurface, delta: 1 | -1): AsideAnchorView | null {
  const ordered = orderAsideAnchors(surface.anchors);
  if (ordered.length === 0) return null;
  const current = hopEntries(surface).findIndex((entry) => entry.current);
  if (ordered.length === 1 && current === 0) return null;
  const base = current >= 0 ? current : delta > 0 ? -1 : 0;
  return asideHopTarget(surface.anchors, (base + delta + ordered.length) % ordered.length);
}

/** What the manuscript shows about asides on one part. */
export interface PartPresence {
  /** Sessions on this take. */
  readonly here: number;
  /** The first other take of the part that has sessions (one-based). */
  readonly elsewhereTake: number | null;
}

/** Take ids of the part's siblings, in take order. */
function siblingIds(payload: StoryPayload, part: StoryPart): readonly string[] {
  const parentId = part.node.parentId;
  const ids = payload.nodes
    .filter((node) => node.parentId === parentId && !isChapterSummary(node))
    .map((node) => node.id);
  return ids.length === 0 ? [part.id] : ids;
}

export function presenceOfPart(payload: StoryPayload, part: StoryPart): PartPresence {
  const anchors = payload.asidePresence?.anchors;
  if (anchors === undefined || anchors.length === 0) return { here: 0, elsewhereTake: null };
  const ids = siblingIds(payload, part);
  let here = 0;
  let elsewhere = Number.POSITIVE_INFINITY;
  for (const entry of anchors) {
    if (entry.sessionCount <= 0) continue;
    const index = ids.indexOf(entry.takeId);
    if (index < 0) continue;
    if (entry.takeId === part.id) here += entry.sessionCount;
    else elsewhere = Math.min(elsewhere, index + 1);
  }
  return { here, elsewhereTake: Number.isFinite(elsewhere) ? elsewhere : null };
}

/** The presence summary a payload carries, as hop anchors. */
export function anchorViewsOfPayload(payload: StoryPayload): AsideAnchorView[] | null {
  const summary = payload.asidePresence;
  return summary === undefined ? null : anchorViews(summary);
}

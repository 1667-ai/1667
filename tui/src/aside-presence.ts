import type { StoryPart } from "./model.js";
import type {
  StoryAsidePresence,
  StoryAsidePresenceAnchor,
  StoryPayload
} from "../../shared/types.js";
import { isChapterSummary } from "../../shared/story-tree.js";
import {
  segment,
  visibleWidth,
  type FrameLine
} from "./screens/story/frame.js";
import { takeStrip } from "./screens/story/density.js";

export interface AsidePresence {
  readonly currentCount: number;
  /** One presence bit/count per sibling take, in take order. */
  readonly siblingCounts: readonly number[];
  readonly hasSiblingPresence: boolean;
  readonly siblingLabelTake: number | null;
  /** 13+ sibling gauges drop the tick row and keep the label. */
  readonly showTicks: boolean;
}

export interface PresenceSummary {
  readonly anchors: readonly StoryAsidePresenceAnchor[];
  readonly unanchoredCount: number;
}

function siblingIds(payload: StoryPayload | unknown, part: StoryPart): readonly string[] {
  if (payload === null || typeof payload !== "object") return [part.id];
  const raw = (payload as { nodes?: unknown }).nodes;
  if (!Array.isArray(raw)) return [part.id];
  const parentId = part.node.parentId;
  const ids = raw.flatMap((node) => {
    if (node === null || typeof node !== "object") return [];
    const item = node as {
      id?: unknown;
      parentId?: unknown;
      chapterBreakId?: string;
    };
    return item.parentId === parentId
      && !isChapterSummary(item)
      && typeof item.id === "string"
      ? [item.id]
      : [];
  });
  return ids.length === 0 ? [part.id] : ids;
}

/** Read the canonical optional summary. Older payloads omit this field. */
export function asidePresenceSummary(payload: StoryPayload | unknown): PresenceSummary {
  if (payload === null || typeof payload !== "object") {
    return { anchors: [], unanchoredCount: 0 };
  }
  const summary = (payload as { asidePresence?: StoryAsidePresence }).asidePresence;
  if (summary === undefined || !Array.isArray(summary.anchors)) {
    return { anchors: [], unanchoredCount: 0 };
  }
  return {
    anchors: summary.anchors,
    unanchoredCount: Number.isFinite(summary.unanchoredCount)
      ? Math.max(0, Math.floor(summary.unanchoredCount))
      : 0
  };
}

function entryTakeIndex(
  entry: StoryAsidePresenceAnchor,
  ids: readonly string[]
): number | null {
  const index = ids.indexOf(entry.takeId);
  return index < 0 ? null : index;
}

/** Derive take-scoped presence for one rendered story part. */
export function asidePresenceForPart(
  payload: StoryPayload | unknown,
  part: StoryPart
): AsidePresence {
  const ids = siblingIds(payload, part);
  const counts = Array.from({ length: Math.max(1, part.siblingCount, ids.length) }, () => 0);
  const summary = asidePresenceSummary(payload);
  for (const entry of summary.anchors) {
    const count = Number.isFinite(entry.sessionCount)
      ? Math.max(0, Math.floor(entry.sessionCount))
      : 0;
    const index = entryTakeIndex(entry, ids);
    if (index === null || index >= counts.length) continue;
    counts[index] = (counts[index] ?? 0) + count;
  }
  const currentIndex = Math.max(0, Math.min(
    counts.length - 1,
    Math.max(0, ids.indexOf(part.id) >= 0 ? ids.indexOf(part.id) : part.takeIndex - 1)
  ));
  const currentCount = counts[currentIndex] ?? 0;
  const siblingLabelTake = counts.findIndex((count, index) => index !== currentIndex && count > 0);
  return {
    currentCount,
    siblingCounts: counts,
    hasSiblingPresence: siblingLabelTake >= 0,
    siblingLabelTake: siblingLabelTake >= 0 ? siblingLabelTake + 1 : null,
    showTicks: part.siblingCount <= 12
  };
}

function asideLabel(count: number): string {
  return `${count} aside${count === 1 ? "" : "s"}`;
}

function asideAction(): FrameLine {
  return [segment("a", "accent · deep", { kind: "inline-action", action: "open-aside" })];
}

/** Focused-part rows: sibling ticks (when they fit), then the live label. */
export function asidePresenceGutterRows(
  part: Pick<StoryPart, "siblingCount" | "takeIndex">,
  presence: AsidePresence
): FrameLine[] {
  if (presence.currentCount === 0 && !presence.hasSiblingPresence) return [];
  const rows: FrameLine[] = [];
  if (part.siblingCount > 1 && presence.showTicks) {
    const strip = takeStrip(part.takeIndex, part.siblingCount);
    const spacing = strip.density === "spaced" ? " " : "";
    const tickText = strip.cells.map((_, index) =>
      `${index === 0 ? "" : spacing}${(presence.siblingCounts[index] ?? 0) > 0 ? "·" : " "}`
    ).join("");
    // The story gutter is right-aligned. Match the take counter width so the
    // tick for each sibling stays under the same strip, instead of moving
    // right when this row has fewer glyphs than the counter above it.
    const pad = visibleWidth(strip.counter) - visibleWidth(tickText);
    rows.push([
      segment(tickText, "chrome"),
      ...(pad > 0 ? [segment(" ".repeat(pad), "chrome")] : [])
    ]);
  }
  const label = presence.currentCount > 0
    ? `${asideLabel(presence.currentCount)} here · `
    : `asides on take ${presence.siblingLabelTake ?? 1} · `;
  rows.push([segment(label, "prose · dim"), ...asideAction()]);
  return rows;
}

/** Unfocused waymark. Legacy payloads produce no row because their summary is
 * absent, preserving the predecessor rendering exactly. */
export function asideGhostGutterLine(
  presence: AsidePresence,
  siblingCount = 1
): FrameLine {
  if (presence.currentCount <= 0) return [];
  const fork = siblingCount > 1 ? [segment(`×${siblingCount} · `, "chrome")] : [];
  return [...fork, segment(asideLabel(presence.currentCount), "prose · dim")];
}

export function asideBoundaryLabel(presence: AsidePresence): string | null {
  return presence.currentCount > 0 ? asideLabel(presence.currentCount) : null;
}

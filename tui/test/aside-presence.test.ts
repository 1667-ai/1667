import { expect, test } from "bun:test";
import type { StoryPart } from "../src/model.js";
import { createStoryViewModel } from "../src/model.js";
import { createDemoController } from "../src/demo.js";
import type { StoryPayload } from "../../shared/types.js";
import {
  asideBoundaryLabel,
  asideGhostGutterLine,
  asidePresenceForPart,
  asidePresenceGutterRows
} from "../src/aside-presence.js";
import {
  asideHopEntries,
  asideHopStripText,
  asideHopWindow,
  moveAsideHopIndex,
  orderAsideAnchors
} from "../src/aside-hop.js";
import type { AsideAnchorView } from "../src/aside-surface.js";
import { frameText, visibleWidth } from "../src/screens/story/frame.js";
import { takeStrip } from "../src/screens/story/density.js";

function part(
  id: string,
  takeIndex: number,
  siblingCount: number
): StoryPart {
  return {
    kind: "part",
    id,
    number: 14,
    pathIndex: 13,
    chapterNumber: 1,
    node: { id, parentId: "slot" } as StoryPart["node"],
    stub: {} as StoryPart["stub"],
    siblingCount,
    takeIndex,
    takeSubtakes: [],
    isSummary: false,
    instruction: "",
    humanSpans: [],
    rewrittenSpans: [],
    words: 1
  };
}

function payload(
  ids: readonly string[],
  anchors: readonly { takeId: string; sessionCount: number }[]
): StoryPayload {
  return {
    id: "story",
    title: "story",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: ids.map((id) => ({ id, parentId: "slot" })) as StoryPayload["nodes"],
    path: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    asidePresence: {
      anchors: anchors.map(({ takeId, sessionCount }) => ({
        partId: "slot",
        takeId,
        sessionCount
      })),
      unanchoredCount: 3
    }
  };
}

test("Aside READ presence is take-scoped and uses immutable sibling ids", () => {
  const current = part("take-b", 2, 3);
  const summary = payload(["take-a", "take-b", "take-c"], [
    { takeId: "take-a", sessionCount: 1 },
    { takeId: "take-b", sessionCount: 2 }
  ]);
  const presence = asidePresenceForPart(summary, current);

  expect(presence.siblingCounts).toEqual([1, 2, 0]);
  expect(presence.currentCount).toBe(2);
  expect(presence.hasSiblingPresence).toBeTrue();
  expect(presence.siblingLabelTake).toBe(1);
  expect(frameText([asidePresenceGutterRows(current, presence)[1]!]))
    .toContain("2 asides here · a");
  expect(asideBoundaryLabel(presence)).toBe("2 asides");
});

test("legacy or ordinal-only fields do not create v2 presence", () => {
  const current = part("take-b", 2, 3);
  const { asidePresence: _asidePresence, ...legacyBase } = payload(
    ["take-a", "take-b", "take-c"], []
  );
  const oldPayload = {
    ...legacyBase,
    asideSummary: { anchors: [{ partNumber: 14, sessionCount: 9 }] }
  } as unknown as StoryPayload;
  const presence = asidePresenceForPart(oldPayload, current);

  expect(presence.currentCount).toBe(0);
  expect(presence.hasSiblingPresence).toBeFalse();
  expect(asidePresenceGutterRows(current, presence)).toEqual([]);
});

test("presence drops ticks for gauge siblings and keeps the fork waymark", () => {
  const ids = Array.from({ length: 13 }, (_, index) => `take-${index + 1}`);
  const current = part("take-1", 1, ids.length);
  const presence = asidePresenceForPart(
    payload(ids, [{ takeId: "take-1", sessionCount: 1 }]),
    current
  );

  expect(presence.showTicks).toBeFalse();
  expect(asidePresenceGutterRows(current, presence)).toHaveLength(1);
  expect(frameText([asideGhostGutterLine(presence, 13)])).toBe("×13 · 1 aside");
});

test("focused sibling ticks keep the take-counter width", () => {
  const current = part("take-b", 2, 3);
  const presence = asidePresenceForPart(
    payload(["take-a", "take-b", "take-c"], [{ takeId: "take-b", sessionCount: 1 }]),
    current
  );
  const tickRow = asidePresenceGutterRows(current, presence)[0]!;
  const tickText = frameText([tickRow]);
  const counterWidth = visibleWidth(takeStrip(2, 3).counter);

  expect(visibleWidth(tickText)).toBe(counterWidth);
  expect(tickText).toBe("  ·  " + " ".repeat(counterWidth - visibleWidth("  ·  ")));
});

test("chapter summaries do not consume a take position in presence ticks", () => {
  const base = createDemoController().switchTo("p3-alt");
  const chapterSummary = base.nodes.find((node) => node.chapterBreakId !== undefined);
  expect(chapterSummary === undefined).toBeFalse();
  const summarySibling: StoryPayload["nodes"][number] = {
    ...chapterSummary!,
    id: "chapter-summary-sibling",
    parentId: "p2",
    chapterBreakId: "chapter-break-sibling"
  };
  const withSummarySibling: StoryPayload = {
    ...base,
    nodes: [...base.nodes, summarySibling],
    asidePresence: {
      anchors: [{ partId: "p3-alt", takeId: "p3-alt", sessionCount: 1 }],
      unanchoredCount: 0
    }
  };
  const current = createStoryViewModel(withSummarySibling).parts.find(
    (candidate) => candidate.id === "p3-alt"
  )!;
  expect(current).toMatchObject({ takeIndex: 2, siblingCount: 2 });

  const presence = asidePresenceForPart(withSummarySibling, current);
  expect(presence.siblingCounts).toEqual([0, 1]);
  const rows = asidePresenceGutterRows(current, presence);
  expect(frameText([rows[0]!])).toContain("·");
  expect(frameText([rows[1]!])).toContain("1 aside here · a");
});

function anchor(
  partId: string,
  takeId: string,
  partNumber: number,
  takeIndex: number,
  sessionCount: number,
  unanchored = false
): AsideAnchorView {
  return {
    partId,
    takeId,
    partNumber,
    takeIndex,
    takeCount: 3,
    sessionCount,
    ...(unanchored ? { unanchored: true } : {})
  };
}

test("hop entries use story order, repeated-part take qualifiers, and unanchored last", () => {
  const anchors = [
    anchor("p14", "p14-t3", 14, 3, 1),
    anchor("p3", "p3-t1", 3, 1, 1),
    anchor("p14", "p14-t2", 14, 2, 2),
    anchor("orphan", "orphan", 0, 0, 3, true)
  ];
  const ordered = orderAsideAnchors(anchors);
  expect(ordered.map((entry) => entry.takeId)).toEqual([
    "p3-t1", "p14-t2", "p14-t3", "orphan"
  ]);
  const entries = asideHopEntries(anchors, anchors[2]!);
  expect(entries.map((entry) => entry.label)).toEqual([
    "¶ 3 ×1", "¶ 14 · t2 ×2", "¶ 14 · t3 ×1", "· unanchored ×3"
  ]);
  expect(entries[1]!.current).toBeTrue();
});

test("hop windows and cycling do not move the story cursor", () => {
  const anchors = Array.from({ length: 7 }, (_, index) =>
    anchor(`p${index + 1}`, `take-${index + 1}`, index + 1, 1, 1)
  );
  const entries = asideHopEntries(anchors, anchors[4]!);
  const window = asideHopWindow(entries, 4, 5);
  expect(window.entries.map((entry) => entry.anchor.takeId)).toEqual([
    "take-3", "take-4", "take-5", "take-6", "take-7"
  ]);
  expect(window.hiddenBefore).toBe(2);
  expect(window.hiddenAfter).toBe(0);
  expect(moveAsideHopIndex(0, -1, anchors.length)).toBe(6);
  expect(moveAsideHopIndex(6, 1, anchors.length)).toBe(0);
  const text = asideHopStripText(anchors, anchors[4]!, 40, 5);
  expect(visibleWidth(text) <= 40).toBeTrue();
  expect(text).toContain("[ ¶ 5 ×1 ]");
});

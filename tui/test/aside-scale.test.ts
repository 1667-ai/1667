import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import {
  createAsideSurface,
  isAsideV2,
  type AsideAnchorView,
  type AsideSessionAnchor,
  type AsideSessionSurfaceState,
  type AsideSessionView
} from "../src/aside-surface.js";
import { cycleAsideSession } from "../src/aside-v2-actions.js";
import { applyAsideV2Settlement, reconcileAsidePresence } from "../src/aside-v2-settlement.js";
import {
  asideHopEntries,
  asideHopStripText,
  asideHopWindow,
  moveAsideHopIndex,
  orderAsideAnchors
} from "../src/aside-hop.js";
import { asideHistoryLayout } from "../src/aside-actions.js";
import { renderAsideScreen } from "../src/screens/story/aside-screen.js";
import { frameText, visibleWidth } from "../src/screens/story/frame.js";

const SMALL_VIEW = { width: 12, height: 6 } as const;
const NORMAL_VIEW = { width: 80, height: 24 } as const;

function anchor(index: number, sessionCount = 1): AsideAnchorView {
  return {
    partId: `part-${index}`,
    takeId: `take-${index}`,
    partNumber: index + 1,
    takeIndex: 0,
    takeCount: 1,
    sessionCount
  };
}

function session(index: number, target: AsideSessionAnchor): AsideSessionView {
  return {
    id: `session-${index}`,
    title: `session title ${index}`,
    anchor: target,
    turns: [{
      id: `turn-${index}`,
      q: `question-${index}`,
      a: `answer-${index}`
    }]
  };
}

function asideFixture(
  sessions: readonly AsideSessionView[],
  anchors: readonly AsideAnchorView[],
  sessionIndex: number,
  currentAnchor: AsideSessionAnchor | null
): {
  state: ReturnType<typeof initialState>;
  surface: AsideSessionSurfaceState;
} {
  const source = demoAppSource();
  const state = initialState(source, false);
  const surface = createAsideSurface(
    state.payload.id,
    state.payload.title,
    sessions,
    null,
    null,
    { v2: true, anchors, anchor: currentAnchor, sessionIndex }
  );
  if (!isAsideV2(surface)) throw new Error("expected an Aside session surface");
  state.aside = surface;
  state.mode = "ASIDE";
  return { state, surface };
}

function assertFrameIsBounded(
  frame: ReturnType<typeof renderAsideScreen>,
  width: number,
  height: number
): void {
  expect(frame.lines).toHaveLength(height);
  expect(frame.derived.hitRows).toHaveLength(height);
  const cells = frame.lines.reduce(
    (total, line) => total + visibleWidth(line.map((part) => part.text).join("")),
    0
  );
  expect(cells <= width * height).toBeTrue();
}

function renderAtSizes(
  state: ReturnType<typeof initialState>,
  surface: AsideSessionSurfaceState
): void {
  for (const size of [SMALL_VIEW, NORMAL_VIEW]) {
    const frame = renderAsideScreen(state, surface, size.width, size.height);
    assertFrameIsBounded(frame, size.width, size.height);
  }
}

describe("Aside v2 bounded scale", () => {
  test("renders and cycles hundreds of sessions on one take", () => {
    const sessionCount = 512;
    const sameTake = anchor(7, sessionCount);
    const sessions = Array.from({ length: sessionCount }, (_, index) =>
      session(index, sameTake)
    );
    const { state, surface } = asideFixture(
      sessions,
      [sameTake],
      sessionCount - 1,
      sameTake
    );

    renderAtSizes(state, surface);
    const initialText = frameText(renderAsideScreen(
      state, surface, NORMAL_VIEW.width, NORMAL_VIEW.height
    ).lines);
    expect(initialText).toContain(`session ${sessionCount}/${sessionCount}`);
    expect(initialText).toContain("¶ 8");
    expect(initialText).toContain(`answer-${sessionCount - 1}`);

    expect(cycleAsideSession(surface, 1)).toBeTrue();
    expect(surface.sessionIndex).toBe(0);
    expect(frameText(renderAsideScreen(
      state, surface, NORMAL_VIEW.width, NORMAL_VIEW.height
    ).lines)).toContain("session 1/512");
    expect(cycleAsideSession(surface, -1)).toBeTrue();
    expect(surface.sessionIndex).toBe(sessionCount - 1);
  });

  test("keeps thousands of anchors and sessions bounded across render, navigation, and reconciliation", () => {
    const itemCount = 2_048;
    const anchors = Array.from({ length: itemCount }, (_, index) => anchor(index));
    const sessions = anchors.map((entry, index) => session(index, entry));
    const currentIndex = 1_024;
    const currentAnchor = anchors[currentIndex]!;
    const { state, surface } = asideFixture(
      sessions,
      anchors,
      currentIndex,
      currentAnchor
    );

    renderAtSizes(state, surface);
    const normalFrame = renderAsideScreen(
      state, surface, NORMAL_VIEW.width, NORMAL_VIEW.height
    );
    const normalText = frameText(normalFrame.lines);
    expect(normalText).toContain(`session ${currentIndex + 1}/${itemCount}`);
    expect(normalText).toContain("[ ¶ 1025 ×1 ]");
    expect(asideHopStripText(anchors, currentAnchor, NORMAL_VIEW.width)).toContain(
      "[ ¶ 1025 ×1 ]"
    );

    const entries = asideHopEntries(anchors, currentAnchor);
    expect(entries).toHaveLength(itemCount);
    const window = asideHopWindow(entries, surface.anchorIndex, 5);
    expect(window.entries).toHaveLength(5);
    expect(window.entries.some((entry) => entry.current)).toBeTrue();
    expect(moveAsideHopIndex(surface.anchorIndex, 1, entries.length)).toBe(
      surface.anchorIndex + 1
    );
    expect(moveAsideHopIndex(entries.length - 1, 1, entries.length)).toBe(0);
    expect(orderAsideAnchors(anchors)[0]?.partNumber).toBe(1);

    const beforeId = surface.sessions[surface.sessionIndex]?.id;
    const reversedRead = {
      schemaVersion: 2 as const,
      anchor: currentAnchor,
      sessions: [...sessions].reverse(),
      anchors: [...anchors].reverse(),
      unanchoredCount: 0
    };
    expect(applyAsideV2Settlement(surface, reversedRead)).toBeTrue();
    expect(surface.sessions[surface.sessionIndex]?.id).toBe(beforeId);
    expect(surface.anchorIndex).toBe(orderAsideAnchors(surface.anchors).findIndex(
      (entry) => entry.takeId === currentAnchor.takeId
    ));

    const refreshedPresence = {
      ...state.payload,
      asidePresence: {
        anchors: [...anchors].reverse().map((entry) => ({
          ...entry,
          sessionCount: entry.takeId === currentAnchor.takeId ? 2 : 1
        })),
        unanchoredCount: 0
      }
    };
    reconcileAsidePresence(surface, refreshedPresence);
    expect(surface.anchors).toHaveLength(itemCount);
    expect(surface.anchors.find((entry) => entry.takeId === currentAnchor.takeId)?.sessionCount)
      .toBe(2);
    expect(surface.anchorIndex).toBe(orderAsideAnchors(surface.anchors).findIndex(
      (entry) => entry.takeId === currentAnchor.takeId
    ));

    expect(cycleAsideSession(surface, 1)).toBeTrue();
    expect(surface.sessionIndex).toBe(itemCount - currentIndex);
    expect(cycleAsideSession(surface, -1)).toBeTrue();
    expect(surface.sessions[surface.sessionIndex]?.id).toBe(beforeId);
  });

  test("keeps protocol-bound session counters exact in anchor labels", () => {
    const maximum = 20_001;
    const anchored = anchor(0, maximum);
    const unanchored: AsideAnchorView = {
      ...anchored,
      partId: "__aside_unanchored__",
      takeId: "__aside_unanchored__",
      sessionCount: maximum,
      unanchored: true
    };

    expect(asideHopEntries([anchored], anchored)[0]?.label).toBe("¶ 1 ×20001");
    expect(asideHopEntries([unanchored], null)[0]?.label).toBe("· unanchored ×20001");
  });

  test("does not rebuild the full history layout once per visible answer row", () => {
    const trackedAnchors = Array.from({ length: 2_048 }, (_, index) => anchor(index));
    const sameTake = trackedAnchors[3]!;
    const longAnswer = Array.from({ length: 320 }, (_, index) => `answer-word-${index}`).join(" ");
    const sessions = [{
      ...session(0, sameTake),
      turns: [{ q: "long question", a: longAnswer }]
    }];
    const { state, surface } = asideFixture(sessions, trackedAnchors, 0, sameTake);
    let anchorReads = 0;
    const trackedSurface = new Proxy(surface, {
      get(target, property, receiver) {
        if (property === "anchors") anchorReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    state.aside = trackedSurface;

    const renderAndCount = (height: number): number => {
      anchorReads = 0;
      const frame = renderAsideScreen(state, trackedSurface, NORMAL_VIEW.width, height);
      assertFrameIsBounded(frame, NORMAL_VIEW.width, height);
      return anchorReads;
    };
    const shortFrameReads = renderAndCount(8);
    const normalFrameReads = renderAndCount(NORMAL_VIEW.height);
    expect(shortFrameReads).toBeGreaterThan(0);
    expect(normalFrameReads).toBe(shortFrameReads);
    expect(asideHistoryLayout(trackedSurface, NORMAL_VIEW.width).body.length)
      .toBeGreaterThan(NORMAL_VIEW.height);
  });
});

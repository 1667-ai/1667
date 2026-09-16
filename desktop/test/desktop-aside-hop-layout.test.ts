import assert from "node:assert/strict";
import test from "node:test";
import { asideHopStripLayout, type AsideHopStripSegment } from "../renderer-aside-hop.js";
import { hopStripSegments } from "../renderer-aside-popover-view.js";
import type { AsideState } from "../renderer-model.js";
import type { AsidePresenceAnchorResponse } from "../../shared/aside-transport.js";

// No Electron here: both sides of the comparison are pure functions.

function anchor(overrides: Partial<AsidePresenceAnchorResponse>): AsidePresenceAnchorResponse {
  return { partId: "p", takeId: "t", sessionCount: 1, ...overrides };
}

function asideFixture(overrides: Partial<AsideState> = {}): AsideState {
  return {
    question: "",
    answer: "",
    notes: [],
    busy: false,
    sessions: [],
    anchors: [],
    unanchoredCount: 0,
    selectedSessionId: null,
    anchor: null,
    bucket: "current",
    v2: true,
    ...overrides
  };
}

function summarize(segments: readonly AsideHopStripSegment[]) {
  return segments.map((segment) => ({
    text: segment.text,
    current: segment.entry?.current ?? null,
    hasEntry: segment.entry !== undefined
  }));
}

test("the popover's hop-strip segments equal asideHopStripLayout for the same anchors", () => {
  const anchors: AsidePresenceAnchorResponse[] = [
    anchor({ partId: "p1", takeId: "t1", partNumber: 1, takeIndex: 1, takeCount: 1, sessionCount: 1 }),
    anchor({ partId: "p9", takeId: "t9", partNumber: 9, takeIndex: 1, takeCount: 1, sessionCount: 2 })
  ];
  const aside = asideFixture({ anchors, anchor: { partId: "p1", takeId: "t1" } });

  const viaPopover = hopStripSegments(aside, 80);

  const expectedAnchorViews = anchors.map((entry) => ({
    partId: entry.partId,
    takeId: entry.takeId,
    sessionCount: entry.sessionCount,
    ...(entry.partNumber === undefined ? {} : { partNumber: entry.partNumber }),
    ...(entry.takeIndex === undefined ? {} : { takeIndex: entry.takeIndex }),
    ...(entry.takeCount === undefined ? {} : { takeCount: entry.takeCount })
  }));
  const direct = asideHopStripLayout(expectedAnchorViews, { partId: "p1", takeId: "t1" }, 80);

  assert.deepEqual(summarize(viaPopover), summarize(direct.segments));
  assert.ok(viaPopover.some((segment) => segment.entry?.current === true && segment.text.includes("¶ 1")), "the current entry names ¶ 1");
});

test("hidden counts appear once the window is narrower than the anchor list", () => {
  const anchors: AsidePresenceAnchorResponse[] = Array.from({ length: 8 }, (_, index) =>
    anchor({ partId: `p${index}`, takeId: `t${index}`, partNumber: index + 1, takeIndex: 1, takeCount: 1, sessionCount: 1 }));
  const aside = asideFixture({ anchors, anchor: { partId: "p0", takeId: "t0" } });
  const segments = hopStripSegments(aside, 40);
  const shownEntries = segments.filter((segment) => segment.entry !== undefined).length;
  assert.ok(shownEntries < anchors.length, `expected fewer than ${anchors.length} entries drawn, got ${shownEntries}`);
  const chrome = segments.filter((segment) => segment.entry === undefined).map((segment) => segment.text).join("");
  assert.match(chrome, /[‹›]/u, `expected a hidden-count marker in: ${JSON.stringify(chrome)}`);
});

test("the unanchored bucket appends as its own entry when present", () => {
  const aside = asideFixture({ anchors: [anchor({ partId: "p1", takeId: "t1", partNumber: 1 })], unanchoredCount: 3, anchor: null });
  const segments = hopStripSegments(aside, 200);
  assert.ok(segments.some((segment) => segment.text.includes("unanchored")));
});

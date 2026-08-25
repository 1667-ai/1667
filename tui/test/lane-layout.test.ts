import { describe, expect, test } from "bun:test";
import {
  CONSOLE_REPORT,
  assertWithinBudget,
  budgetTimeout,
  cpuBudget,
  startTiming
} from "../../test/performance-budget.js";
import type { Tag, NodeStub, StoryNode, StoryPayload } from "../../shared/types.js";
import {
  createLaneLayout,
  followLane,
  laneSelectable,
  moveLaneCursorAcross,
  LANE_BUDGET,
  type LaneLayout,
  type LaneRow
} from "../src/lane-layout.js";
import { createDemoController } from "../src/demo.js";
import type { HitRows } from "../src/hit.js";
import { renderMapScreen, type MapScreenFrame } from "../src/screens/map.js";
import { renderLaneRow } from "../src/screens/map-lane-row.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";
import type { StoryScreenState } from "../src/state.js";

const NOW = 1_667_000_000_000;
const FANOUT_RENDER_BUDGET = cpuBudget(150);

function renderTree(
  payload: StoryPayload, cursorId: string, showSketches: boolean, width = 120, height = 36
): { frame: MapScreenFrame; hits: HitRows; text: string } {
  const hits: HitRows = [];
  const state = { payload, now: NOW, stream: null } as StoryScreenState;
  const frame = renderMapScreen(state, {
    view: "tree", pathCursorId: payload.path.at(-1)?.id ?? cursorId, pathShowAllTakes: true,
    treeCursorId: cursorId, rowIds: [], showSketches, openedColdFolds: new Set(), massSort: "size"
  }, width, height, hits);
  return { frame, hits, text: frameText(frame.lines) };
}

describe("lane layout model", () => {
  test("the demo story draws a fixed lane picture, sketches folded, at 120×36", () => {
    const demo = createDemoController();
    const payload = demo.payload();
    const cursorId = payload.path.at(-1)!.id;
    const layout = createLaneLayout(payload, { now: NOW, cursorId, showSketches: false });

    // Lane 0 lists p1…p13 in order.
    const trunkIds = layout.allRows.filter((row) => row.kind === "node").map((row) => row.id);
    expect(trunkIds).toEqual(Array.from({ length: 13 }, (_, index) => `p${index + 1}`));
    expect(layout.laneCount).toBe(3);
    expect(layout.cursorId).toBe("p13");

    // p2, p4, p7, p10, p11 each fork; p7 opens two lanes at once (a line and a
    // folded sketch lane); lane 1 is reused across the other four.
    const forks = layout.allRows.filter((row): row is Extract<LaneRow, { kind: "fork" }> => row.kind === "fork");
    expect(forks.map((row) => row.node.id).sort()).toEqual(["p10", "p11", "p2", "p4", "p7"]);
    const p7Fork = forks.find((row) => row.node.id === "p7")!;
    expect(p7Fork.toLanes).toEqual([1, 2]);
    expect(forks.filter((row) => row.toLanes.includes(1)).length).toBeGreaterThan(1);

    const active = layout.allRows.find((row) => row.id === "p13");
    expect(active).toMatchObject({ kind: "node", active: true, lane: 0 });

    const { frame, hits, text } = renderTree(payload, cursorId, false);
    expect(text).toContain("├─╮");
    expect(text).toContain("├─┬─╮");
    expect(text).toContain("╵");
    expect(text).toContain("⚑ canon-storm");
    // Cumulative from the root, same number the mass view gives this line —
    // not the 13/18 words along the off-path segment alone.
    expect(text).toContain("✕ burned · 103w");
    expect(text).toContain("⌇ 2 sketches");
    // `tagGlyph` (tag-presentation.ts) gives Alt status the default `⚑`, same
    // as Canon — only Draft, Discarded, and Summary get their own glyph.
    expect(text).toContain("⚑ alt-quiet-inn · 179w");
    expect(text).toContain("⋯ ×1 line · cold 8 wks");
    expect(text).toContain("⌇ 4 sketches");
    const cursorLine = frame.lines.find((line) => plainLine(line).includes("⚑ canon-storm"));
    expect(cursorLine).toBeDefined();
    expect(plainLine(cursorLine!)).toContain("◉");
    for (const line of frame.lines) expect(visibleWidth(plainLine(line)) <= 120).toBeTrue();

    for (const hit of hits) {
      if (hit === null || hit.target.kind !== "list") continue;
      expect(frame.derived.rowIds[hit.target.index]).toBe(hit.target.mapRow?.id);
    }
  });

  test("revealing sketches replaces the folds with quoted rows; lane count is unchanged", () => {
    const demo = createDemoController();
    const payload = demo.payload();
    const cursorId = payload.path.at(-1)!.id;
    const layout = createLaneLayout(payload, { now: NOW, cursorId, showSketches: true });
    expect(layout.laneCount).toBe(3);
    expect(layout.allRows.filter((row) => row.kind === "sketch")).toHaveLength(7);
    const { text } = renderTree(payload, cursorId, true);
    expect(text).not.toContain("⌇ 2 sketches");
    expect(text).not.toContain("⌇ 4 sketches");
    expect(text).toContain("‥”");
  });

  test("rows sort by depth: an off-path end sits between the trunk rows at its own depth", () => {
    const payload = deepOffPathFixture();
    const layout = createLaneLayout(payload, { now: NOW });
    const ids = layout.allRows.map((row) => row.id);
    expect(ids.indexOf("s8")).toBeGreaterThan(ids.indexOf("t8"));
    expect(ids.indexOf("s8")).toBeLessThan(ids.indexOf("t9"));
    expect(layout.allRows.find((row) => row.id === "s8")).toMatchObject({ kind: "end", depth: 8 });
  });

  test("a stopped line reads on: the trunk continues below ◉ down the first line child", () => {
    const payload = fixture([
      ["root", null], ["stopped", "root"], ["below", "stopped"],
      ["other", "root"], ["other-leaf", "other"]
    ], ["root", "stopped"], ["below", "other-leaf"]);
    const layout = createLaneLayout(payload, { now: NOW });
    expect(layout.allRows.find((row) => row.id === "stopped")).toMatchObject({ kind: "node", active: true });
    expect(layout.allRows.find((row) => row.id === "below")).toMatchObject({ kind: "node", active: false, lane: 0 });
    expect(layout.allRows.find((row) => row.id === "other-leaf")).toMatchObject({ kind: "end" });
  });

  test("a streaming lane row draws ⟳ in the glyph's pad cell without moving the label", () => {
    const demo = createDemoController();
    const payload = demo.payload();
    const layout = createLaneLayout(payload, { now: NOW, cursorId: "p13" });
    const row = layout.allRows.find((candidate) => candidate.id === "p13")!;
    const settled = plainLine(renderLaneRow(row, layout, 120, null));
    const streaming = plainLine(renderLaneRow(row, layout, 120, "p13"));
    expect(settled).toContain("◉ ");
    expect(streaming).toContain("◉⟳");
    expect(streaming.indexOf("⚑")).toBe(settled.indexOf("⚑"));
  });

  test("a branch whose node id is 'trunk' is not mistaken for lane 0", () => {
    const base = fixture([
      ["root", null], ["stopped", "root"], ["below", "stopped"],
      ["other", "root"], ["trunk", "other"]
    ], ["root", "stopped"], ["below", "trunk"]);
    const payload = { ...base, nodes: base.nodes.map((node) =>
      node.id === "stopped" ? { ...node, activeChildId: null } : node) };
    const layout = createLaneLayout(payload, { now: NOW, cursorId: "stopped" });
    const trunkNamedRow = layout.allRows.find((row) => row.id === "trunk")!;
    expect(trunkNamedRow.kind).toBe("end");
    expect(trunkNamedRow.lane).not.toBe(0);
    expect(followLane(layout)).toBe("below");
    expect(followLane(layout)).not.toBe("trunk");
  });

  test("a lane budget parks the extras past LANE_BUDGET", () => {
    const payload = eightConcurrentLines();
    const layout = createLaneLayout(payload, { now: NOW });
    expect(layout.overflow).toBeTrue();
    expect(layout.laneCount).toBe(LANE_BUDGET);
    const parkedRows = layout.allRows.filter((row) => row.lane === -1);
    expect(parkedRows).toHaveLength(2);
    for (const row of parkedRows) expect(laneSelectable(row)).toBeTrue();
    const fork = layout.allRows.find((row): row is Extract<LaneRow, { kind: "fork" }> => row.kind === "fork")!;
    expect(fork.parkedCount).toBe(2);
    const { frame, text } = renderTree(payload, "c1", false, 80, 24);
    expect(text).toMatch(/⋯2/);
    for (const line of frame.lines) expect(visibleWidth(plainLine(line)) <= 80).toBeTrue();
  });

  test("moveLaneCursorAcross jumps to the nearest row on the next lane", () => {
    const demo = createDemoController();
    const payload = demo.payload();
    const toP8AltThree = createLaneLayout(payload, { now: NOW, showSketches: true, cursorId: "p8" });
    expect(moveLaneCursorAcross(toP8AltThree, 1)).toBe("p8-alt-3");

    const toSketchLane = createLaneLayout(payload, { now: NOW, showSketches: true, cursorId: "p8-alt-3" });
    const acrossToSketch = moveLaneCursorAcross(toSketchLane, 1);
    expect(acrossToSketch).toBe("p8-alt-1");

    const back = createLaneLayout(payload, { now: NOW, showSketches: true, cursorId: "p8-alt-1" });
    expect(moveLaneCursorAcross(back, -1)).toBe("p8-alt-3");

    const noNeighbour = createLaneLayout(payload, { now: NOW, cursorId: "p1" });
    expect(moveLaneCursorAcross(noNeighbour, -1)).toBeNull();
  });

  test("followLane walks the trunk down and stays put off it", () => {
    const demo = createDemoController();
    const payload = demo.payload();
    const fromP8 = createLaneLayout(payload, { now: NOW, cursorId: "p8" });
    expect(followLane(fromP8)).toBe("p9");
    const fromAlt = createLaneLayout(payload, { now: NOW, cursorId: "p8-alt-3" });
    expect(followLane(fromAlt)).toBe("p8-alt-3");
  });

  test("cold-folds only past the threshold and never on the active line; a fold opens with openedColdFolds", () => {
    const demo = createDemoController();
    const payload = demo.payload();
    const activeIds = new Set(payload.path.map((node) => node.id));
    const closed = createLaneLayout(payload, { now: NOW });
    expect(closed.allRows.find((row) => row.id === "p5-alt")?.kind).toBe("cold");
    expect(closed.allRows.filter((row) => row.kind === "cold").every((row) => !activeIds.has(row.id))).toBeTrue();
    const opened = createLaneLayout(payload, { now: NOW, openedColdFolds: new Set(["p5-alt"]) });
    expect(opened.allRows.find((row) => row.id === "p5-alt")?.kind).toBe("end");
  });

  test("80×24 windows both markers and never exceeds the frame height", () => {
    const { frame, text } = renderTree(createDemoController().payload(), "p7", false, 80, 24);
    expect(frame.lines).toHaveLength(24);
    expect(text).toContain("▲");
    expect(text).toContain("▼");
  });

  test("extra root lines fork from a virtual root at depth 0", () => {
    const payload = twoExtraRootsFixture();
    const folded = createLaneLayout(payload, { now: NOW });
    expect(folded.allRows[0]).toMatchObject({ kind: "fork", id: "virtual-root:fork", lane: 0, depth: 0 });
    const fork = folded.allRows[0] as Extract<LaneRow, { kind: "fork" }>;
    expect(fork.node.id).toBe("t1");
    expect(fork.toLanes).toEqual([1, 2]);
    expect(folded.allRows.find((row) => row.id === "r-line")).toMatchObject({ kind: "end", lane: 1, depth: 1 });
    expect(folded.allRows.find((row) => row.kind === "sketches")).toMatchObject({ lane: 2 });

    const revealed = createLaneLayout(payload, { now: NOW, showSketches: true });
    expect(revealed.allRows.find((row) => row.id === "r-sketch")).toMatchObject({ kind: "sketch", lane: 2 });

    const { frame } = renderTree(payload, "t1", false, 80, 24);
    for (const line of frame.lines) expect(visibleWidth(plainLine(line)) <= 80).toBeTrue();
  });

  test("a parked chain that forks parks all of its children", () => {
    const payload = parkedForkFixture();
    const layout = createLaneLayout(payload, { now: NOW });
    const c7Fork = layout.allRows.find(
      (row): row is Extract<LaneRow, { kind: "fork" }> => row.kind === "fork" && row.node.id === "c7"
    )!;
    expect(c7Fork.lane).toBe(-1);
    expect(c7Fork.toLanes).toEqual([]);
    expect(c7Fork.parkedCount).toBe(1);
    expect(layout.allRows.find((row) => row.id === "c7a")).toMatchObject({ kind: "end", lane: -1 });
    expect(layout.allRows.find((row) => row.id === "c7b")).toMatchObject({ kind: "end", lane: -1 });
    // A parked chain has no column to anchor a connector on, so its own fork
    // draws no glyphs at all — not even `├` on lane 0.
    const rendered = plainLine(renderLaneRow(c7Fork, layout, 120, null));
    expect(rendered).not.toContain("┼");
    expect(rendered).not.toContain("├");
  });

  test("a 200-child fork renders only the visible window in linear time", () => {
    const edges: Array<[string, string | null]> = [["root", null]];
    const tags: string[] = [];
    for (let index = 1; index <= 200; index += 1) {
      edges.push([`c${index}`, "root"]);
      if (index > 1) tags.push(`c${index}`);
    }
    const payload = fixture(edges, ["root", "c1"], tags);
    const read = startTiming();
    const layout = createLaneLayout(payload, { now: NOW, maxRows: 24 });
    const rendered = layout.rows.map((row) => renderLaneRow(row, layout, 120, null));
    const timing = read();

    expect(layout.rows).toHaveLength(24);
    expect(layout.overflow).toBeTrue();
    expect(Math.max(...rendered.map((line) => plainLine(line).length))).toBeLessThan(120);
    assertWithinBudget(CONSOLE_REPORT, "200-child lane layout and render", FANOUT_RENDER_BUDGET, timing);
  }, budgetTimeout([FANOUT_RENDER_BUDGET]));
});

function deepOffPathFixture(): StoryPayload {
  const edges: Array<[string, string | null]> = [["t1", null]];
  for (let index = 2; index <= 9; index += 1) edges.push([`t${index}`, `t${index - 1}`]);
  edges.push(["s2", "t1"]);
  for (let index = 3; index <= 8; index += 1) edges.push([`s${index}`, `s${index - 1}`]);
  const active = Array.from({ length: 9 }, (_, index) => `t${index + 1}`);
  return fixture(edges, active, ["s8"]);
}

/** The trunk root `t1` plus two extra roots: `r-line` (tagged, so a real
 * line) and `r-sketch` (untagged and childless, so a lone sketch) — the
 * virtual-root fork's own `sketches-on-one-lane` rule applies to root-level
 * lines exactly like any other fork. */
function twoExtraRootsFixture(): StoryPayload {
  return fixture([
    ["t1", null], ["r-line", null], ["r-sketch", null]
  ], ["t1"], ["r-line"]);
}

/** `root` forks into `c1` (the reading line) plus six tagged alternates —
 * one more than the five free lanes past lane 0, so `c7` parks. `c7` itself
 * forks into `c7a` (its own continuation) and `c7b`, which must park too. */
function parkedForkFixture(): StoryPayload {
  const edges: Array<[string, string | null]> = [["root", null], ["c1", "root"]];
  const tagged: string[] = [];
  for (let index = 2; index <= 7; index += 1) {
    edges.push([`c${index}`, "root"]);
    tagged.push(`c${index}`);
  }
  edges.push(["c7a", "c7"], ["c7b", "c7"]);
  tagged.push("c7a", "c7b");
  return fixture(edges, ["root", "c1"], tagged);
}

function eightConcurrentLines(): StoryPayload {
  const edges: Array<[string, string | null]> = [["root", null]];
  const tagged: string[] = [];
  for (let index = 1; index <= 8; index += 1) {
    edges.push([`c${index}`, "root"]);
    if (index > 1) tagged.push(`c${index}`);
  }
  return fixture(edges, ["root", "c1"], tagged);
}

/** Ported from `atlas-layout.test.ts`: an edge list plus which ids are on the
 * active path and which are tagged. `lastTouched` defaults recent, so a
 * fixture only goes cold when a test calls `touch`. */
function fixture(edges: Array<[string, string | null]>, activeIds: string[], tagged: string[]): StoryPayload {
  const children = new Map<string, string[]>();
  for (const [id, parent] of edges) if (parent !== null) children.set(parent, [...children.get(parent) ?? [], id]);
  const leaves = new Map<string, number>();
  for (const [id] of [...edges].reverse()) {
    const descendants = children.get(id) ?? [];
    leaves.set(id, descendants.length === 0 ? 1 : descendants.reduce((sum, child) => sum + leaves.get(child)!, 0));
  }
  const activeNext = new Map(activeIds.slice(0, -1).map((id, index) => [id, activeIds[index + 1]!]));
  const nodes: NodeStub[] = edges.map(([id, parent]) => ({
    id, parentId: parent, preview: `opening ${id}`, words: 10, tokens: 12,
    childCount: children.get(id)?.length ?? 0, leafCount: leaves.get(id)!, lastTouched: "2022-10-25T09:00:00.000Z",
    hasInstruction: false, activeChildId: activeNext.get(id) ?? null
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: StoryNode[] = activeIds.map((id) => {
    const node = byId.get(id)!;
    return { id, parentId: node.parentId, instruction: "", text: node.preview, model: "test",
      createdAt: node.lastTouched, activeChildId: node.activeChildId };
  });
  const tags: Tag[] = tagged.map((nodeId) => ({
    nodeId, name: nodeId, status: "Canon", color: "", createdAt: "2022-10-25T09:00:00.000Z"
  }));
  return { id: "lanes", title: "lanes", createdAt: "", updatedAt: "", nodes, path,
    activeRootId: activeIds[0] ?? null, tags, recentNodeIds: [], facts: [], chapterBreaks: [] };
}

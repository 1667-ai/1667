import { describe, expect, test } from "bun:test";
import type { Tag, NodeStub, StoryNode, StoryPayload } from "../../shared/types.js";
import { createFrameDeadlineCollector } from "../src/animation-deadline.js";
import { createAtlasLayout, followAtlasRail, type AtlasLayout } from "../src/atlas-layout.js";
import { createDemoController } from "../src/demo.js";
import type { HitRows } from "../src/hit.js";
import { createPathLayout } from "../src/path-layout.js";
import { renderMapScreen } from "../src/screens/map.js";
import { renderMapTreeRow } from "../src/screens/map-tree-row.js";
import { frameText, plainLine } from "../src/screens/story/frame.js";
import type { StoryScreenState } from "../src/state.js";
const NOW = 1_667_000_000_000;

function renderTree(layout: AtlasLayout, streamTargetId: string | null = null): string[] {
  return layout.rows.map((row) => plainLine(renderMapTreeRow(row, 120, streamTargetId)));
}

function renderTreeMap(payload: StoryPayload, cursorId: string, showSketches: boolean): string {
  const hits: HitRows = [];
  const state = { payload, now: NOW, stream: null } as StoryScreenState;
  return frameText(renderMapScreen(state, {
    view: "tree",
    pathCursorId: payload.path.at(-1)?.id ?? cursorId,
    pathShowAllTakes: true,
    treeCursorId: cursorId,
    rowIds: [],
    showSketches,
    openedColdFolds: new Set(),
    massSort: "size"
  }, 120, 36, hits).lines);
}

describe("atlas layout model", () => {
  test("the active leaf is always a visible line, even when uncontinued", () => {
    const demo = createDemoController();
    let payload = demo.payload();
    const leafId = payload.path.at(-1)!.id;
    const parentId = payload.nodes.find((node) => node.id === leafId)!.parentId;
    payload = demo.createChild(parentId, "another ending", "The shutters gave all at once.");
    const activeLeafId = payload.path.at(-1)!.id;
    const layout = createAtlasLayout(payload, { now: NOW });
    expect(layout.allRows.find((row) => row.id === activeLeafId)).toMatchObject({ kind: "node", lineEnd: true });
    expect(layout.allRows.some((row) => row.active)).toBeTrue();
  });
  test("the reading line is the trunk; every other line hangs off it as one stub", () => {
    const demo = createDemoController();
    const payload = demo.payload();
    const layout = createAtlasLayout(payload, { now: NOW });
    // Trunk nodes are the active reading line and never wear a branch connector.
    const trunk = layout.allRows.filter((row) => row.kind === "node" && !row.branch);
    expect(trunk.every((row) => !row.branch)).toBeTrue();
    expect(trunk.some((row) => row.active && row.lineEnd)).toBeTrue();
    // Alternate lines each appear once, as an indented `branch` stub.
    const stubs = layout.allRows.filter((row) => row.branch);
    expect(stubs.length).toBeGreaterThan(0);
    // Doc 20c: depth is indentation and one soft `↳`. No box-drawing survives,
    // so the graph cannot accumulate a rail per line in the first place.
    expect(renderTree(layout).every((line) => !/[│├└─┼]/.test(line))).toBeTrue();
    for (const [index, row] of layout.rows.entries()) {
      if (row.branch) expect(renderTree(layout)[index]!.slice(2, 8)).toBe("    ↳ ");
    }
  });
  test("the supplied two-sketch fork repro remains represented", () => {
    const demo = createDemoController();
    demo.createChild("p8-alt-1", "one", "First dead end.");
    const payload = demo.createChild("p8-alt-1", "two", "Second dead end.");
    const layout = createAtlasLayout(payload, { now: NOW });
    expect(layout.allRows.some((row) => row.id === "p8-alt-1")).toBeTrue();
  });
  test("a fork terminus remains when every visible child is a folded sketch", () => {
    const demo = createDemoController();
    demo.createChild("p8-alt-1", "one", "First dead end.");
    demo.createChild("p8-alt-1", "two", "Second dead end.");
    const payload = demo.switchTo("p13");
    const layout = createAtlasLayout(payload, { now: NOW, openedColdFolds: new Set(["p8-alt-1"]) });
    expect(layout.allRows.find((row) => row.id === "p8-alt-1")?.kind).toBe("node");
  });
  test("collapses runs with depth-minus-anchor arithmetic", () => {
    const payload = arithmeticTree();
    const runs = createAtlasLayout(payload, { now: NOW }).allRows
      .filter((row) => row.kind === "run").map((row) => row.run);
    // Only the trunk collapses runs now; alternate lines are single stubs.
    expect(runs).toEqual([5, 3, 8]);
  });
  test("branch stubs stay one column right of an unbroken trunk", () => {
    const payload = fixture([
      ["root", null], ["active", "root"], ["inner", "active"], ["active-leaf", "inner"],
      ["nested-leaf", "inner"], ["sibling", "root"], ["sibling-fork", "sibling"],
      ["sibling-leaf", "sibling-fork"], ["late-leaf", "sibling-fork"]
    ], ["root", "active", "inner", "active-leaf"], ["active-leaf", "nested-leaf", "sibling-leaf", "late-leaf"]);
    const layout = createAtlasLayout(payload, { now: NOW });
    const rendered = renderTree(layout);
    // Doc 20c: the reading line owns column 2 as `●`/`◉`, its runs step in one
    // indent, and a stub steps in again behind a single `↳`.
    for (const [index, row] of layout.rows.entries()) {
      const text = rendered[index]!;
      if (row.kind === "node" && !row.branch) expect("●◉○").toContain(text[2]!);
      if (row.kind === "run") expect(text.slice(2, 5)).toBe("  ⋯");
      if (row.branch) expect(text.slice(2, 8)).toBe("    ↳ ");
    }
    // Alternate lines are still every line: the four leaves each own a stub row.
    const stubs = layout.rows.filter((row) => row.branch).map((row) => row.id);
    expect(stubs).toEqual(["sibling-leaf", "late-leaf", "nested-leaf"]);
    expect(rendered.every((line) => !line.includes("┼"))).toBeTrue();
  });
  test("a streaming active leaf keeps ◉ and gains ⟳ without moving its rails", () => {
    const payload = fixture([
      ["root", null], ["active", "root"], ["active-leaf", "active"], ["other", "root"]
    ], ["root", "active", "active-leaf"], []);
    const layout = createAtlasLayout(payload, { now: NOW });
    const render = (target: string | null): string => {
      const rendered = renderTree(layout, target);
      return rendered[layout.rows.findIndex((row) => row.id === "active-leaf")]!;
    };
    const settled = render(null);
    const streaming = render("active-leaf");
    expect(settled).toContain("◉ ");
    expect(streaming).toContain("◉⟳");
    // The suffix rides in the glyph's pad column, so nothing to its right moves.
    expect(streaming.indexOf("¶")).toBe(settled.indexOf("¶"));
  });

  test("a line stopped above its continuation is one mass line, not two", () => {
    // The stop row wears `◉ you` and ends the reading line, but the leaf below
    // is the same logical line — counting both drew two bars for one.
    const payload = fixture([
      ["root", null], ["stopped", "root"], ["below", "stopped"],
      ["other", "root"], ["other-leaf", "other"]
    ], ["root", "stopped"], ["below", "other-leaf"]);
    const mass = createAtlasLayout(payload, { now: NOW, sort: "size" });
    expect(new Set(mass.allRows.filter((row) => row.kind === "node").map((row) => row.id))).toEqual(new Set(["below", "other-leaf"]));
    expect(mass.totalLines).toBe(2);
    // The graph still draws the stop row, so `◉ you` never disappears.
    const graph = createAtlasLayout(payload, { now: NOW });
    expect(graph.allRows.some((row) => row.id === "stopped" && row.lineEnd)).toBeTrue();
  });

  test("a stopped line keeps ◉ and the cursor on its remembered endpoint in mass", () => {
    const base = fixture([
      ["root", null], ["stopped", "root"], ["below", "stopped"],
      ["other", "root"], ["other-leaf", "other"]
    ], ["root", "stopped"], ["below", "other-leaf"]);
    // Real stop-at-node state: `switchToNode({ stopAtNode: true })` CLEARS the
    // endpoint's activeChildId, so there is no remembered continuation to
    // follow. Restoring one here would have masked the defect entirely.
    const payload = { ...base, nodes: base.nodes.map((node) =>
      node.id === "stopped" ? { ...node, activeChildId: null } : node) };
    const mass = createAtlasLayout(payload, { now: NOW, sort: "size" });
    const active = mass.allRows.filter((row) => row.kind === "node" && row.active);
    expect(active.map((row) => row.id)).toEqual(["below"]);
    // Without this the cursor falls back to whatever sorted first, and Enter
    // reroutes to an unrelated line.
    expect(mass.cursorId).toBe("below");
  });

  test("revealing sketches never drops a stopped line from the mass view", () => {
    // The stopped line's only descendants are lone takes, which become `sketch`
    // children the moment `a` reveals them. Treating that as "continues below"
    // discarded the current line — and nothing on its rail could carry it.
    const base = fixture([
      ["root", null], ["stopped", "root"], ["s1", "stopped"], ["s2", "stopped"],
      ["other", "root"], ["other-leaf", "other"]
    ], ["root", "stopped"], ["other-leaf"]);
    const payload = { ...base, nodes: base.nodes.map((node) =>
      node.id === "stopped" ? { ...node, activeChildId: null } : node) };
    for (const showSketches of [false, true]) {
      const mass = createAtlasLayout(payload, { now: NOW, sort: "size", showSketches });
      expect(mass.allRows.filter((row) => row.kind === "node" && row.active).map((row) => row.id)).toEqual(["stopped"]);
      expect(mass.cursorId).toBe("stopped");
    }
  });

  test("revealed sketches at a fork read as branch stubs, not a stem of their own", () => {
    const payload = fixture([
      ["root", null], ["kept", "root"], ["kept-leaf", "kept"],
      ["fork", "root"], ["s1", "fork"], ["s2", "fork"]
    ], ["root", "kept", "kept-leaf"], ["kept-leaf"]);
    const revealed = createAtlasLayout(payload, { now: NOW, showSketches: true });
    const rendered = renderTree(revealed);
    // Nothing dangles below the final row, and no rails are drawn at all.
    expect(rendered.every((line) => !/[│├└─┼]/.test(line))).toBeTrue();
    const sketches = revealed.rows.filter((row) => row.kind === "sketch");
    expect(sketches.map((row) => row.id)).toEqual(["s1", "s2"]);
    // Every sketch reads as a branch off the fork: the branch indent, one `↳`.
    for (const [index, row] of revealed.rows.entries()) {
      if (row.kind === "sketch") expect(rendered[index]!.slice(2, 8)).toBe("    ↳ ");
    }
  });

  test("revealing a fork's sketches keeps the incoming line it ends", () => {
    // `stub` is a line whose only takes are lone dead ends. Folded, it shows as
    // one stub; revealed, its sketches must hang below it, never replace it.
    const payload = fixture([
      ["root", null], ["kept", "root"], ["kept-leaf", "kept"],
      ["stub", "root"], ["d1", "stub"], ["d2", "stub"]
    ], ["root", "kept", "kept-leaf"], ["kept-leaf"]);
    const folded = createAtlasLayout(payload, { now: NOW });
    const revealed = createAtlasLayout(payload, { now: NOW, showSketches: true });
    const lineIds = (layout: AtlasLayout): string[] => layout.allRows.filter((row) => row.lineEnd).map((row) => row.id);

    expect(lineIds(folded)).toContain("stub");
    expect(lineIds(revealed)).toContain("stub");
    // Every line the totals count owns a selectable row in both states.
    expect(lineIds(folded)).toHaveLength(folded.totalLines);
    expect(lineIds(revealed)).toHaveLength(revealed.totalLines);
    expect(revealed.allRows.filter((row) => row.kind === "sketch").map((row) => row.id)).toEqual(["d1", "d2"]);
  });

  test("a cold subtree under a fork does not invent a line at the fork", () => {
    // `alt` reaches a fork whose outgoing subtrees are all stale. The lines live
    // inside the cold folds; `alt` itself is not a line and must get no stub.
    const payload = touch(fixture([
      ["root", null], ["kept", "root"], ["kept-leaf", "kept"],
      ["alt", "root"], ["c1", "alt"], ["c1-leaf", "c1"], ["c2", "alt"], ["c2-leaf", "c2"]
    ], ["root", "kept", "kept-leaf"], ["kept-leaf", "c1-leaf", "c2-leaf"]), "c1", "2022-08-01T09:00:00.000Z");
    const withCold = touch(payload, "c2", "2022-08-01T09:00:00.000Z");
    const layout = createAtlasLayout(withCold, { now: NOW });
    expect(layout.allRows.some((row) => row.kind === "cold")).toBeTrue();
    expect(layout.allRows.filter((row) => row.lineEnd).map((row) => row.id)).not.toContain("alt");
    // Exactly the counted lines get a row: the reading line plus the two folds.
    expect(layout.allRows.filter((row) => row.lineEnd).length + layout.allRows.filter((row) => row.kind === "cold")
      .reduce((sum, row) => sum + (row.cold?.lineCount ?? 0), 0)).toBe(layout.totalLines);
  });

  test("a branch whose node id is 'trunk' is not mistaken for the trunk", () => {
    // Node ids are arbitrary strings; identity must come from the branch flag,
    // not a rail-id label a real node could equal.
    const base = fixture([
      ["root", null], ["stopped", "root"], ["below", "stopped"],
      ["other", "root"], ["trunk", "other"]
    ], ["root", "stopped"], ["below", "trunk"]);
    const payload = { ...base, nodes: base.nodes.map((node) =>
      node.id === "stopped" ? { ...node, activeChildId: null } : node) };
    const mass = createAtlasLayout(payload, { now: NOW, sort: "size" });
    // The stopped reading line's mass row is its own continuation (`below`),
    // never the identically-named alternate leaf.
    expect(mass.allRows.find((row) => row.active && row.kind === "node")?.id).toBe("below");
    expect(mass.cursorId).toBe("below");
    // Following the trunk from its stop lands on the continuation, not `trunk`.
    const graph = createAtlasLayout(payload, { now: NOW, cursorId: "stopped" });
    expect(followAtlasRail(graph)).not.toBe("trunk");
  });

  test("a stub off a terminal fork stays attached to the trunk", () => {
    // The reading line stops at a fork whose only takes are dead ends; once
    // revealed, those stubs hang *below* the current node at the branch indent.
    const base = fixture([
      ["root", null], ["stopped", "root"], ["d1", "stopped"], ["d2", "stopped"]
    ], ["root", "stopped"], []);
    const payload = { ...base, nodes: base.nodes.map((node) =>
      node.id === "stopped" ? { ...node, activeChildId: null } : node) };
    const layout = createAtlasLayout(payload, { now: NOW, showSketches: true });
    const rendered = renderTree(layout);
    for (const [index, row] of layout.rows.entries()) {
      if (row.branch) expect(rendered[index]!.slice(2, 8)).toBe("    ↳ ");
    }
  });

  test("revealing sketches never widens the graph past two rail columns", () => {
    const payload = fixture([
      ["root", null], ["kept", "root"], ["kept-leaf", "kept"],
      ["s1", "root"], ["s2", "root"], ["s3", "root"], ["s4", "root"]
    ], ["root", "kept", "kept-leaf"], ["kept-leaf"]);
    const revealed = createAtlasLayout(payload, { now: NOW, showSketches: true });
    expect(revealed.sketchCount).toBe(4);
    // Four sketches cost four stub rows, never four permanent columns.
    for (const line of renderTree(revealed)) {
      expect((line.match(/│/g) ?? []).length <= 1).toBeTrue();
    }
  });

  test("zero-length runs vanish while positive runs receive one spacer", () => {
    const payload = fixture([
      ["root", null], ["active", "root"], ["continued", "root"], ["continued-leaf", "continued"]
    ], ["root", "active"], ["active", "continued-leaf"]);
    const rows = createAtlasLayout(payload, { now: NOW }).allRows;
    const active = rows.findIndex((row) => row.id === "active");
    expect(rows[active]?.kind).toBe("node");
    const run = rows.findIndex((row) => row.kind === "run" && row.node.id === "continued-leaf");
    expect(run).toBe(-1);
  });
  test("a continued or tagged fork child is a line; a lone take is a sketch", () => {
    const payload = fixture([
      ["root", null], ["continued", "root"], ["continued-leaf", "continued"],
      ["sketch", "root"], ["named", "root"]
    ], ["root", "continued", "continued-leaf"], ["continued-leaf", "named"]);
    const folded = createAtlasLayout(payload, { now: NOW });
    expect(folded.sketchCount).toBe(1);
    expect(folded.allRows.filter((row) => row.lineEnd).map((row) => row.id)).toEqual(["named", "continued-leaf"]);
    const revealed = createAtlasLayout(payload, { now: NOW, showSketches: true });
    expect(revealed.allRows.find((row) => row.id === "sketch")?.kind).toBe("sketch");
  });
  test("root takes lead as stubs and childless inactive roots fold as sketches", () => {
    const payload = fixture([
      ["active-root", null], ["active-leaf", "active-root"],
      ["root-sketch-a", null], ["root-sketch-b", null]
    ], ["active-root", "active-leaf"], ["active-leaf"]);
    const folded = createAtlasLayout(payload, { now: NOW });
    expect(folded.sketchCount).toBe(2);
    expect(folded.forkCount).toBe(1);
    expect(folded.allRows.filter((row) => row.lineEnd).map((row) => row.id)).toEqual(["active-leaf"]);
    const revealed = createAtlasLayout(payload, { now: NOW, showSketches: true });
    expect(revealed.allRows.filter((row) => row.lineEnd || row.kind === "sketch").map((row) => row.id)).toEqual([
      "root-sketch-a", "root-sketch-b", "active-leaf"
    ]);
    for (const line of renderTree(revealed)) {
      expect((line.match(/│/g) ?? []).length <= 1).toBeTrue();
    }
  });
  test("cold-folds only after 21 days and never folds the active line", () => {
    const base = fixture([
      ["root", null], ["active", "root"], ["active-leaf", "active"],
      ["old", "root"], ["old-fork", "old"], ["old-a", "old-fork"], ["old-b", "old-fork"]
    ], ["root", "active", "active-leaf"], ["active-leaf", "old-a", "old-b"]);
    const atThreshold = touch(base, "old", new Date(NOW - 21 * 86_400_000).toISOString());
    const thresholdDeadlines = createFrameDeadlineCollector(NOW);
    expect(createAtlasLayout(atThreshold, {
      now: NOW,
      deadlines: thresholdDeadlines
    }).allRows.some((row) => row.kind === "cold")).toBeFalse();
    expect(thresholdDeadlines.next()).toBe(NOW + 86_400_000);
    const old = touch(base, "old", new Date(NOW - 22 * 86_400_000).toISOString());
    const coldDeadlines = createFrameDeadlineCollector(NOW);
    const layout = createAtlasLayout(old, { now: NOW, deadlines: coldDeadlines });
    expect(layout.allRows.find((row) => row.id === "old")?.kind).toBe("cold");
    expect(layout.allRows.find((row) => row.id === "old")?.cold?.lineCount).toBe(2);
    expect(coldDeadlines.next()).toBe(NOW + 6 * 86_400_000);
    expect(layout.allRows.find((row) => row.id === "active-leaf")?.kind).toBe("node");
    const selected = createAtlasLayout(old, { now: NOW, cursorId: "old" });
    const frame = frameText(renderTree(selected).map((text) => [{ text, role: "prose" as const }]));
    const coldRow = frame.split("\n").find((line) => line.includes("cold 3 wks"));
    expect(coldRow).toMatch(/▸ .*cold 3 wks/);
  });
  test("cold deadlines keep offscreen transitions but skip offscreen weekly labels", () => {
    const base = fixture([
      ["root", null], ["active", "root"], ["active-leaf", "active"],
      ["old", "root"], ["old-leaf", "old"]
    ], ["root", "active", "active-leaf"], ["active-leaf", "old-leaf"]);
    const threshold = touch(base, "old", new Date(NOW - 21 * 86_400_000).toISOString());
    const transitionDeadlines = createFrameDeadlineCollector(NOW);
    createAtlasLayout(threshold, {
      now: NOW, cursorId: "active-leaf", maxRows: 1, deadlines: transitionDeadlines
    });
    expect(transitionDeadlines.next()).toBe(NOW + 86_400_000);

    const cold = touch(base, "old", new Date(NOW - 22 * 86_400_000).toISOString());
    const offscreenDeadlines = createFrameDeadlineCollector(NOW);
    const offscreen = createAtlasLayout(cold, {
      now: NOW, cursorId: "active-leaf", maxRows: 1, deadlines: offscreenDeadlines
    });
    expect(offscreen.rows.map((row) => row.id)).toEqual(["active-leaf"]);
    expect(offscreenDeadlines.next()).toBe(null);

    const visibleDeadlines = createFrameDeadlineCollector(NOW);
    const visible = createAtlasLayout(cold, {
      now: NOW, cursorId: "old", maxRows: 1, deadlines: visibleDeadlines
    });
    expect(visible.rows.map((row) => row.id)).toEqual(["old"]);
    expect(visibleDeadlines.next()).toBe(NOW + 6 * 86_400_000);
  });
  test("mass schedules the repaint that sinks a line's bar when it turns cold", () => {
    // Mass never folds, so nothing else asks for that frame; without it a map
    // left open keeps a cold line bright until some unrelated key redraws it.
    const base = fixture([
      ["root", null], ["active", "root"], ["active-leaf", "active"],
      ["old", "root"], ["old-leaf", "old"]
    ], ["root", "active", "active-leaf"], ["active-leaf", "old-leaf"]);
    const payload = touch(base, "old-leaf", new Date(NOW - 20 * 86_400_000).toISOString());
    const deadlines = createFrameDeadlineCollector(NOW);
    const layout = createAtlasLayout(payload, { now: NOW, sort: "size", deadlines });
    expect(layout.allRows.find((row) => row.id === "old-leaf")?.stale).toBeFalse();
    expect(deadlines.next()).toBe(NOW + 2 * 86_400_000);

    // Once it is already cold there is no transition left to wait for.
    const settled = createFrameDeadlineCollector(NOW);
    createAtlasLayout(touch(base, "old-leaf", new Date(NOW - 22 * 86_400_000).toISOString()),
      { now: NOW, sort: "size", deadlines: settled });
    expect(settled.next()).toBe(null);
  });
  test("cold folds retain the same global sketch and line totals in every view", () => {
    const base = fixture([
      ["root", null], ["active", "root"], ["active-leaf", "active"],
      ["old", "root"], ["old-fork", "old"], ["old-line", "old-fork"],
      ["old-leaf", "old-line"], ["old-sketch", "old-fork"]
    ], ["root", "active", "active-leaf"], ["old-leaf"]);
    const payload = touch(base, "old", new Date(NOW - 22 * 86_400_000).toISOString());
    const path = createPathLayout(payload, "active-leaf");
    const tree = createAtlasLayout(payload, { now: NOW });
    const mass = createAtlasLayout(payload, { now: NOW, sort: "size" });

    expect(tree.allRows.some((row) => row.kind === "cold")).toBeTrue();
    expect([path.sketchCount, tree.sketchCount, mass.sketchCount]).toEqual([1, 1, 1]);
    expect([path.totalLines, tree.totalLines, mass.totalLines]).toEqual([2, 2, 2]);
  });
  test("uses leaf-count and fork-count rollups", () => {
    const demo = createDemoController().payload();
    const layout = createAtlasLayout(demo, { now: NOW });
    expect(layout.forkCount).toBe(5);
    expect(layout.allRows.find((row) => row.kind === "cold")?.cold?.lineCount).toBe(1);
  });
  test("numbered sketch prose is never mistaken for a paragraph depth", () => {
    const payload = fixture([
      ["root", null], ["active", "root"], ["active-leaf", "active"], ["sketch", "root"]
    ], ["root", "active", "active-leaf"], ["active-leaf"]);
    payload.nodes.find((node) => node.id === "sketch")!.preview = "He counted 23 steps to the door.";
    const layout = createAtlasLayout(payload, { now: NOW, showSketches: true, cursorId: "sketch" });
    const sketch = layout.allRows.find((row) => row.id === "sketch")!;
    expect(sketch).toMatchObject({ depth: 2, fragment: "“He counted 23 steps to the‥”" });
    const frame = renderTreeMap(payload, "sketch", true);
    const sketchRow = frame.split("\n").find((line) => line.includes("He counted 23 steps"));
    // Doc 20c took `¶N` off the rows, so the row carries prose and nothing that
    // could read as a depth; the depth the cursor is on comes from the preview
    // and the breadcrumb, where the sketch's own numbers cannot reach it.
    expect(sketchRow).toMatch(/▸ {5}↳ “He counted 23 steps/);
    expect(frame).toContain("¶ 2 · 10 w");
    expect(frame).not.toContain("¶ 2 · 20 w");
    expect(frame).not.toContain("¶23");
  });
  test("chapter summaries never interrupt a prose continuation", () => {
    const payload = fixture([
      ["root", null], ["continued", "root"], ["active-leaf", "continued"]
    ], ["root", "continued", "active-leaf"], ["active-leaf"]);
    const continued = payload.nodes.find((node) => node.id === "continued")!;
    payload.nodes.splice(1, 0, {
      ...continued, id: "chapter-summary", parentId: "root", preview: "Previously.",
      childCount: 0, leafCount: 0, role: "summary", text: "Previously.", instruction: "Use this summary.",
      chapterBreakId: "chapter-1", activeChildId: null
    });
    const layout = createAtlasLayout(payload, { now: NOW, showSketches: true });
    expect(layout.allRows.some((row) => row.id === "active-leaf" && row.active)).toBeTrue();
    expect(layout.allRows.some((row) => row.id === "chapter-summary")).toBeFalse();
    expect(layout.allRows.some((row) => row.node.chapterBreakId !== undefined)).toBeFalse();
  });
  test("revealed sketches sort below continued lines at an inactive fork", () => {
    const payload = fixture([
      ["root", null], ["active", "root"], ["active-leaf", "active"],
      ["inactive-fork", "root"], ["older-sketch", "inactive-fork"],
      ["continued", "inactive-fork"], ["continued-leaf", "continued"]
    ], ["root", "active", "active-leaf"], ["active-leaf", "continued-leaf"]);
    const ids = createAtlasLayout(payload, { now: NOW, showSketches: true }).allRows.map((row) => row.id);
    expect(ids.indexOf("continued-leaf")).toBeLessThan(ids.indexOf("older-sketch"));
  });
  test("a line stopped before its structural child still owns a row", () => {
    // `u` (undo take switch) and stopping a generation both switch with
    // stopAtNode, leaving the line on a node that still has a child. Collapsing
    // that node into the run erased the reader's position from the map.
    const payload = createDemoController().switchTo("p12", { stopAtNode: true });
    const layout = createAtlasLayout(payload, { now: NOW });
    const active = layout.allRows.find((row) => row.id === "p12");
    expect(active?.active).toBeTrue();
    expect(active).toMatchObject({ kind: "node", lineEnd: true });
    expect(layout.cursorId).toBe("p12");
    // the unfollowed continuation stays on the map, hanging beneath it
    expect(layout.allRows.map((row) => row.id)).toContain("p13");
  });
  test("opening a cold fold reveals lines past its inner forks, not more folds", () => {
    // The opened set names one node; everything under it must stay open, or a
    // subtree with an inner fork answers `l` with another rank of cold rows.
    const payload = touch(fixture([
      ["r", null], ["rc", "r"],
      ["o1", null], ["o2", "o1"], ["o3", "o2"], ["o3l", "o3"], ["o4", "o2"], ["o4l", "o4"]
    ], ["r", "rc"], []), "o1", "2022-08-01T09:00:00.000Z");
    const opened = createAtlasLayout(payload, { now: NOW, openedColdFolds: new Set(["o1"]) });
    expect(opened.allRows.filter((row) => row.kind === "cold")).toHaveLength(0);
    expect(opened.allRows.map((row) => row.id)).toContain("o3l");
    expect(opened.allRows.map((row) => row.id)).toContain("o4l");
  });
  test("a cold root subtree is a single stub off the trunk", () => {
    const payload = touch(fixture([
      ["r1", null], ["r1-leaf", "r1"],
      ["r2", null], ["r2-a", "r2"], ["r2-b", "r2"]
    ], ["r1", "r1-leaf"], []), "r2", "2022-08-01T09:00:00.000Z");
    const layout = createAtlasLayout(payload, { now: NOW });
    const cold = layout.allRows.find((row) => row.kind === "cold")!;
    expect(cold.branch).toBeTrue();
    const rendered = renderTree(layout);
    expect(rendered.every((line) => !/[│├└─┼]/.test(line))).toBeTrue();
  });

  test("high-fanout layouts render only terminal-visible cells in linear time", () => {
    const branches = 1_000;
    const edges: Array<[string, string | null]> = [];
    const tags: string[] = [];
    for (let index = 0; index < branches; index += 1) {
      const root = `root-${index}`;
      const leaf = `leaf-${index}`;
      edges.push([root, null], [leaf, root]);
      tags.push(leaf);
    }
    const payload = fixture(edges, ["root-0", "leaf-0"], tags);
    const started = performance.now();
    const layout = createAtlasLayout(payload, { now: NOW, maxRows: 24 });
    const rendered = layout.rows.map((row) => renderMapTreeRow(row, 120, null));
    const elapsed = performance.now() - started;

    expect(layout.rows).toHaveLength(24);
    expect(layout.totalLines).toBe(branches);
    expect(Math.max(...rendered.map((line) => plainLine(line).length))).toBeLessThan(120);
    expect(elapsed).toBeLessThan(150);
  });

  test("a 19,999-node forked line does not consume the JavaScript call stack", () => {
    const depth = 10_000;
    const edges: Array<[string, string | null]> = [];
    const active: string[] = [];
    const tags: string[] = [];
    for (let index = 0; index < depth; index += 1) {
      const trunk = `trunk-${index}`;
      edges.push([trunk, index === 0 ? null : `trunk-${index - 1}`]);
      active.push(trunk);
      if (index + 1 === depth) continue;
      const side = `side-${index}`;
      edges.push([side, trunk]);
      tags.push(side);
    }

    const layout = createAtlasLayout(fixture(edges, active, tags), { now: NOW, maxRows: 24 });

    expect(layout.totalParts).toBe(19_999);
    expect(layout.totalRows).toBe(19_999);
    expect(layout.totalLines).toBe(10_000);
    expect(layout.cursorId).toBe("trunk-9999");
    expect(layout.rows).toHaveLength(24);
  });

  test("mass maximum stays stack-safe across 70k hot root lines", () => {
    const count = 70_000;
    const touched = "2022-10-25T09:00:00.000Z";
    const nodes: NodeStub[] = Array.from({ length: count }, (_, index) => ({
      id: `root-${index}`, parentId: null, preview: `root ${index}`, words: 1, tokens: 1,
      childCount: 0, leafCount: 1, lastTouched: touched, hasInstruction: false, activeChildId: null
    }));
    const payload: StoryPayload = {
      id: "wide-mass", title: "wide mass", createdAt: touched, updatedAt: touched, nodes,
      path: [{ id: "root-0", parentId: null, instruction: "", text: "root 0", model: "test",
        createdAt: touched, activeChildId: null }],
      activeRootId: "root-0",
      tags: nodes.map((node) => ({
        nodeId: node.id, name: node.id, status: "Canon", color: "", createdAt: touched
      })),
      recentNodeIds: [], facts: [], chapterBreaks: []
    };

    const layout = createAtlasLayout(payload, { now: NOW, sort: "size", maxRows: 24 });

    expect(layout.totalLines).toBe(count);
    expect(layout.massMaximum).toBe(1);
    expect(layout.rows).toHaveLength(24);
  });
});
function arithmeticTree(): StoryPayload {
  const edges: Array<[string, string | null]> = [["a1", null]];
  chain(edges, "a", 2, 6, "a1");
  chain(edges, "b", 7, 10, "a6");
  chain(edges, "c", 11, 19, "b10");
  chain(edges, "d", 11, 13, "b10");
  chain(edges, "e", 7, 8, "a6");
  chain(edges, "f", 9, 13, "e8");
  edges.push(["g9", "e8"]);
  const active = ["a1", "a2", "a3", "a4", "a5", "a6", "b7", "b8", "b9", "b10",
    "c11", "c12", "c13", "c14", "c15", "c16", "c17", "c18", "c19"];
  return fixture(edges, active, ["c19", "d13", "f13", "g9"]);
}
function chain(edges: Array<[string, string | null]>, prefix: string, from: number, to: number, parent: string): void {
  let previous = parent;
  for (let depth = from; depth <= to; depth += 1) {
    const id = `${prefix}${depth}`;
    edges.push([id, previous]);
    previous = id;
  }
}
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
  return { id: "atlas", title: "atlas", createdAt: "", updatedAt: "", nodes, path,
    activeRootId: activeIds[0] ?? null, tags, recentNodeIds: [], facts: [], chapterBreaks: [] };
}
function touch(payload: StoryPayload, rootId: string, lastTouched: string): StoryPayload {
  const descendants = new Set([rootId]);
  for (const node of payload.nodes) if (node.parentId !== null && descendants.has(node.parentId)) descendants.add(node.id);
  return { ...payload, nodes: payload.nodes.map((node) => descendants.has(node.id) ? { ...node, lastTouched } : node) };
}

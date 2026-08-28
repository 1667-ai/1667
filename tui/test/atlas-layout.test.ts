import { describe, expect, test } from "bun:test";
import type { Tag, NodeStub, StoryNode, StoryPayload } from "../../shared/types.js";
import { createFrameDeadlineCollector } from "../src/animation-deadline.js";
import { createAtlasLayout, type AtlasLayout } from "../src/atlas-layout.js";
import { createDemoController } from "../src/demo.js";
import { createPathLayout } from "../src/path-layout.js";
const NOW = 1_667_000_000_000;

describe("atlas layout model", () => {
  test("the active leaf is always a visible line, even when uncontinued", () => {
    const demo = createDemoController();
    let payload = demo.payload();
    const leafId = payload.path.at(-1)!.id;
    const parentId = payload.nodes.find((node) => node.id === leafId)!.parentId;
    payload = demo.createChild(parentId, "another ending", "The shutters gave all at once.");
    const activeLeafId = payload.path.at(-1)!.id;
    const layout = createAtlasLayout(payload, { now: NOW, sort: "size" });
    expect(layout.allRows.find((row) => row.id === activeLeafId)).toMatchObject({ kind: "node", lineEnd: true });
    expect(layout.allRows.some((row) => row.active)).toBeTrue();
  });
  test("a fork terminus remains when every visible child is a folded sketch", () => {
    const demo = createDemoController();
    demo.createChild("p8-alt-1", "one", "First dead end.");
    demo.createChild("p8-alt-1", "two", "Second dead end.");
    const payload = demo.switchTo("p13");
    const layout = createAtlasLayout(payload, { now: NOW, sort: "size" });
    expect(layout.allRows.find((row) => row.id === "p8-alt-1")?.kind).toBe("node");
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

  test("revealing a fork's sketches keeps the incoming line it ends", () => {
    // `stub` is a line whose only takes are lone dead ends. Folded, it shows as
    // one stub; revealed, its sketches must hang below it, never replace it.
    const payload = fixture([
      ["root", null], ["kept", "root"], ["kept-leaf", "kept"],
      ["stub", "root"], ["d1", "stub"], ["d2", "stub"]
    ], ["root", "kept", "kept-leaf"], ["kept-leaf"]);
    const folded = createAtlasLayout(payload, { now: NOW, sort: "size" });
    const revealed = createAtlasLayout(payload, { now: NOW, sort: "size", showSketches: true });
    const lineIds = (layout: AtlasLayout): string[] => layout.allRows.filter((row) => row.lineEnd).map((row) => row.id);

    expect(lineIds(folded)).toContain("stub");
    expect(lineIds(revealed)).toContain("stub");
    // Every line the totals count owns a selectable row in both states.
    expect(lineIds(folded)).toHaveLength(folded.totalLines);
    expect(lineIds(revealed)).toHaveLength(revealed.totalLines);
    expect(revealed.allRows.filter((row) => row.kind === "sketch").map((row) => row.id)).toEqual(["d1", "d2"]);
  });

  test("a branch whose node id is 'trunk' is not mistaken for the trunk", () => {
    // Node ids are arbitrary strings; identity must come from the branch flag,
    // not a rail-id label a real node could equal. The tree-graph half of this
    // (following the trunk from a stop) lives in lane-layout.test.ts now, since
    // the mass sort below is the only atlas-layout behaviour left to guard.
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
  });

  test("a continued or tagged fork child is a line; a lone take is a sketch", () => {
    const payload = fixture([
      ["root", null], ["continued", "root"], ["continued-leaf", "continued"],
      ["sketch", "root"], ["named", "root"]
    ], ["root", "continued", "continued-leaf"], ["continued-leaf", "named"]);
    const folded = createAtlasLayout(payload, { now: NOW, sort: "size" });
    expect(folded.sketchCount).toBe(1);
    // Mass sorts by size; both lines carry the fixture's default word count,
    // so the tie preserves draw order — the trunk's own line first, its
    // off-path sibling after.
    expect(folded.allRows.filter((row) => row.lineEnd).map((row) => row.id)).toEqual(["continued-leaf", "named"]);
    const revealed = createAtlasLayout(payload, { now: NOW, sort: "size", showSketches: true });
    expect(revealed.allRows.find((row) => row.id === "sketch")?.kind).toBe("sketch");
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

  test("uses fork-count rollups", () => {
    const demo = createDemoController().payload();
    const layout = createAtlasLayout(demo, { now: NOW, sort: "size" });
    expect(layout.forkCount).toBe(5);
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
    const layout = createAtlasLayout(payload, { now: NOW, sort: "size", showSketches: true });
    expect(layout.allRows.some((row) => row.id === "active-leaf" && row.active)).toBeTrue();
    expect(layout.allRows.some((row) => row.id === "chapter-summary")).toBeFalse();
    expect(layout.allRows.some((row) => row.node.chapterBreakId !== undefined)).toBeFalse();
  });

  test("cold folds retain the same global sketch and line totals across path and mass", () => {
    // Cold folding is the lane tree's own concern now (`lane-layout.test.ts`);
    // path and mass never fold, so their totals only need to agree with each
    // other.
    const base = fixture([
      ["root", null], ["active", "root"], ["active-leaf", "active"],
      ["old", "root"], ["old-fork", "old"], ["old-line", "old-fork"],
      ["old-leaf", "old-line"], ["old-sketch", "old-fork"]
    ], ["root", "active", "active-leaf"], ["old-leaf"]);
    const payload = touch(base, "old", new Date(NOW - 22 * 86_400_000).toISOString());
    const path = createPathLayout(payload, "active-leaf");
    const mass = createAtlasLayout(payload, { now: NOW, sort: "size" });

    expect([path.sketchCount, mass.sketchCount]).toEqual([1, 1]);
    expect([path.totalLines, mass.totalLines]).toEqual([2, 2]);
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

    const layout = createAtlasLayout(fixture(edges, active, tags), { now: NOW, sort: "size", maxRows: 24 });

    expect(layout.totalParts).toBe(19_999);
    // 9,999 tagged side leaves plus the trunk's own final mass line — mass
    // never folds, but it also never draws the 9,998 intermediate trunk rows
    // a fork-every-step trunk collapses to nothing (each is a fork with
    // children, not a line end).
    expect(layout.totalRows).toBe(10_000);
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

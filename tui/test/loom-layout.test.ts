import { describe, expect, test } from "bun:test";
import { createDemoController } from "../src/demo.js";
import { createAtlasLayout } from "../src/atlas-layout.js";
import { createLoomLayout, initialLoomCursor, moveLoomCursor, resolveRerouteTarget } from "../src/loom-layout.js";

describe("loom layout model", () => {
  test("builds depth rows and sibling cells for the demo tree", () => {
    const payload = createDemoController().payload();
    const cursor = initialLoomCursor(payload, 11)!;
    const layout = createLoomLayout(payload, cursor, 13, 5, true);
    expect(layout.totalDepth).toBe(13);
    expect(layout.rows).toHaveLength(13);
    const compass = layout.rows.find((row) => row.depth === 12)!;
    expect(compass.cells.map((cell) => cell.node.id)).toEqual(["p12-t1", "p12-t2", "p12", "p12-t4", "p12-t5"]);
    expect(compass.cells.find((cell) => cell.cursor)?.take).toBe(3);
    expect(layout.rows.some((row) => row.cells.some((cell) => cell.node.chapterBreakId !== undefined))).toBeFalse();
  });

  test("windows twenty takes around the cursor with exact hidden counts", () => {
    const payload = createDemoController(true).payload();
    const layout = createLoomLayout(payload, "p12", 13, 5, true);
    const row = layout.rows.find((candidate) => candidate.depth === 12)!;
    expect(row.cells.map((cell) => cell.take)).toEqual([10, 11, 12, 13, 14]);
    expect({ before: row.hiddenBefore, after: row.hiddenAfter }).toEqual({ before: 9, after: 6 });
  });

  test("resolves sibling navigation and reroute target", () => {
    const payload = createDemoController().payload();
    const sibling = moveLoomCursor(payload, "p12", 0, 1, true);
    expect(sibling).toBe("p12-t4");
    expect(resolveRerouteTarget(payload, sibling)).toBe("p12-t4");
    expect(moveLoomCursor(payload, sibling, -1, 0, true)).toBe("p11");
  });

  test("folds only lone sketches and shares line totals with tree and mass", () => {
    const payload = createDemoController().payload();
    const folded = createLoomLayout(payload, "p13");
    const revealed = createLoomLayout(payload, "p13", 13, 5, true);

    // Active/continued and bookmarked takes remain; only bare leaves disappear.
    expect(folded.rows.find((row) => row.depth === 8)!.cells.map((cell) => cell.node.id))
      .toEqual(["p8", "p8-alt-3"]);
    expect(revealed.rows.find((row) => row.depth === 8)!.cells.map((cell) => cell.node.id))
      .toEqual(["p8", "p8-alt-1", "p8-alt-2", "p8-alt-3"]);
    expect(folded.rows.find((row) => row.depth === 12)!.cells.map((cell) => cell.node.id))
      .toEqual(["p12"]);

    expect(moveLoomCursor(payload, "p8", 0, 1)).toBe("p8-alt-3");
    expect(moveLoomCursor(payload, "p8", 0, 1, true)).toBe("p8-alt-1");
    const tree = createAtlasLayout(payload, { now: 1_667_000_000_000 });
    const mass = createAtlasLayout(payload, { now: 1_667_000_000_000, sort: "size" });
    expect([folded.totalLines, revealed.totalLines, tree.totalLines, mass.totalLines])
      .toEqual([4, 4, 4, 4]);
    expect([folded.sketchCount, revealed.sketchCount, tree.sketchCount, mass.sketchCount])
      .toEqual([7, 7, 7, 7]);
  });
});

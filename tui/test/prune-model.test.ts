import { describe, expect, test } from "bun:test";
import { createDemoController } from "../src/demo.js";
import { createPrunePlan, createUnusedTakesPrunePlan, pruneConfirmText } from "../src/prune-model.js";
import { subtreeIds } from "../../shared/story-tree.js";

describe("prune rollups", () => {
  test("matches shared subtree part/line rollups and names every bookmark", () => {
    const payload = createDemoController().payload();
    const plan = createPrunePlan(payload, "p7")!;
    const stub = payload.nodes.find((node) => node.id === "p7")!;
    expect(plan.parts).toBe(subtreeIds(payload, "p7").length);
    expect(plan.lines).toBe(stub.leafCount);
    expect(plan.bookmarks.sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: "alt-quiet-inn", label: "Alt" },
      { name: "burned", label: "Discarded" },
      { name: "canon-storm", label: "Canon" }
    ]);
    expect(pruneConfirmText(plan)).toContain("⚑ alt-quiet-inn, ✕ burned, ⚑ canon-storm");
  });

  test("focused demo take includes its continuation and canon leaf", () => {
    const payload = createDemoController().payload();
    expect(createPrunePlan(payload, "p12")).toMatchObject({
      part: 12,
      take: 3,
      takeCount: 5,
      parts: 2,
      lines: 1,
      bookmarks: [{ name: "canon-storm", label: "Canon" }]
    });
  });

  test("unused-take cleanup keeps continuations, named lines, and one leaf at each fork", () => {
    const plan = createUnusedTakesPrunePlan(createDemoController().payload())!;
    expect(plan).toEqual({
      kind: "unused-takes",
      storyRevision: createDemoController().payload().updatedAt,
      takes: 5,
      parts: 5
    });
    expect(pruneConfirmText(plan)).toContain("keeps continuations, named lines + one leaf/fork");
  });
});

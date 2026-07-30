import { describe, expect, test } from "bun:test";
import { createDemoController } from "../src/demo.js";
import { createPrunePlan, createUnusedTakesPrunePlan, pruneConfirmText } from "../src/prune-model.js";
import { subtreeIds } from "../../shared/story-tree.js";

describe("prune rollups", () => {
  test("deleting a subtree takes the tags that pointed into it", () => {
    const demo = createDemoController();
    const before = demo.payload();
    const doomed = before.tags[0]!;
    // Every tag names a leaf. Deleting the branch it hangs from must take the
    // tag with it, or the payload keeps a bookmark to a part that is gone.
    const owner = subtreeIds(before, before.path[1]!.id).includes(doomed.nodeId)
      ? before.path[1]!.id
      : doomed.nodeId;
    const removed = subtreeIds(before, owner);
    const after = demo.deleteNode(owner, removed.length);
    for (const tag of after.tags) {
      expect(removed.includes(tag.nodeId)).toBeFalse();
    }
  });

  test("matches shared subtree part/line rollups and names every tag", () => {
    const payload = createDemoController().payload();
    const plan = createPrunePlan(payload, "p7")!;
    const stub = payload.nodes.find((node) => node.id === "p7")!;
    expect(plan.parts).toBe(subtreeIds(payload, "p7").length);
    expect(plan.lines).toBe(stub.leafCount);
    expect(plan.tags.sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: "alt-quiet-inn", status: "Alt" },
      { name: "burned", status: "Discarded" },
      { name: "canon-storm", status: "Canon" }
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
      tags: [{ name: "canon-storm", status: "Canon" }]
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

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

  test("deleting a subtree removes an anchored Fact state and its empty Fact", () => {
    const demo = createDemoController();
    const before = demo.createFact({
      name: "branch keeper",
      tag: "people",
      text: "Only true on this branch.",
      anchorPartId: "p12"
    });
    expect(before.facts.some((fact) => fact.name === "branch keeper")).toBeTrue();

    const removed = subtreeIds(before, "p12");
    const after = demo.deleteNode("p12", removed.length);

    expect(after.facts.some((fact) => fact.name === "branch keeper")).toBeFalse();
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

  test("deletion receipt names dying states and Facts that lose their last state", () => {
    const payload = createDemoController().payload();
    const source = payload.facts[0]!;
    const stamp = "2026-01-01T00:00:00.000Z";
    payload.facts = [
      {
        ...source,
        id: "signaler",
        name: "the-signaler",
        states: [{ id: "signaler-state", anchorPartId: "p12", text: "Only here.", createdAt: stamp, updatedAt: stamp }]
      },
      {
        ...source,
        id: "ama-evolving",
        name: "ama",
        states: [
          { id: "ama-old", anchorPartId: "p11", text: "Old.", createdAt: stamp, updatedAt: stamp },
          { id: "ama-new", anchorPartId: "p12", text: "New.", createdAt: stamp, updatedAt: stamp }
        ]
      },
      {
        ...source,
        id: "branch-only",
        name: "branch-only",
        states: [
          { id: "branch-old", anchorPartId: "p12", text: "Old branch.", createdAt: stamp, updatedAt: stamp },
          { id: "branch-new", anchorPartId: "p13", text: "New branch.", createdAt: stamp, updatedAt: stamp }
        ]
      }
    ];

    const plan = createPrunePlan(payload, "p12")!;
    const text = pruneConfirmText(plan);

    expect(plan.dyingStates).toEqual([
      { factName: "the-signaler", stateOrdinal: 1, stateCount: 1 },
      { factName: "ama", stateOrdinal: 2, stateCount: 2 },
      { factName: "branch-only", stateOrdinal: 1, stateCount: 2 },
      { factName: "branch-only", stateOrdinal: 2, stateCount: 2 }
    ]);
    expect(plan.factsLosingLastStateNames).toEqual(["the-signaler", "branch-only"]);
    expect(text).toContain("the-signaler st.1/1");
    expect(text).toContain("ama st.2/2");
    expect(text).toContain("branch-only st.1/2");
    expect(text).toContain("branch-only st.2/2");
    expect(text).toContain("lose their last state (the-signaler, branch-only)");
    expect(text).toContain("never re-anchored · scope never widens silently");
  });

  test("unused-take cleanup keeps continuations, named lines, and one leaf at each fork", () => {
    const plan = createUnusedTakesPrunePlan(createDemoController().payload())!;
    expect(plan).toEqual({
      kind: "unused-takes",
      storyRevision: createDemoController().payload().updatedAt,
      takes: 5,
      parts: 5,
      states: 0,
      factsLosingLastState: 0
    });
    expect(pruneConfirmText(plan)).toContain("keeps continuations, named lines + one leaf/fork");
  });
});

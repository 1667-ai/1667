import { describe, expect, test } from "bun:test";
import type { NodeStub, StoryPayload } from "../../shared/types.js";
import { createDemoController } from "../src/demo.js";
import {
  APPARATUS_LABELS,
  deriveApparatusSeam,
  resolveApparatusLabel,
  visibleApparatusDoorways
} from "../src/apparatus-model.js";
import { createStoryViewModel } from "../src/model.js";

describe("apparatus seam model", () => {
  test("keeps the active take out and exposes sibling doorways in order", () => {
    const payload = createDemoController().payload();
    const part = createStoryViewModel(payload).parts.find(({ id }) => id === "p12");
    if (part === undefined) throw new Error("demo p12 part is missing");

    const seam = deriveApparatusSeam(payload, part);
    if (seam.kind !== "not-yet") throw new Error("demo p12 must have a seam");

    expect(seam.takeCount).toBe(5);
    expect(seam.doorways.map(({ label }) => label)).toEqual(["b", "d", "e", "f"]);
    expect(seam.doorways.map(({ preview }) => preview))
      .not.toContain(part.stub.preview);

    const first = seam.doorways[0]!;
    const firstStub = payload.nodes.find(({ id }) => id === "p12-t1")!;
    expect(first).toEqual({
      label: "b",
      preview: firstStub.preview,
      takeIndex: 1,
      childCount: firstStub.childCount
    });
    expect(resolveApparatusLabel(seam.doorways, "b")).toBe(first);
    expect(resolveApparatusLabel(seam.doorways, "c")).toBeNull();
  });

  test("returns an explicit empty state when the focused part has one take", () => {
    const payload = createDemoController().payload();
    const part = createStoryViewModel(payload).parts.find(({ id }) => id === "p6");
    if (part === undefined) throw new Error("demo p6 part is missing");

    expect(deriveApparatusSeam(payload, part)).toEqual({
      kind: "empty",
      doorways: []
    });
  });

  test("keeps every doorway after the label set is exhausted", () => {
    const base = createDemoController().payload();
    const extra: NodeStub[] = Array.from({ length: 26 }, (_, offset) => ({
      id: `p12-extra-${offset + 1}`,
      parentId: "p11",
      preview: `extra doorway ${offset + 1}`,
      words: offset + 1,
      tokens: (offset + 1) * 2,
      childCount: offset % 2,
      leafCount: offset % 2 === 0 ? 1 : 2,
      lastTouched: "2026-07-20T00:00:00Z",
      hasInstruction: false,
      activeChildId: null
    }));
    const payload: StoryPayload = { ...base, nodes: [...base.nodes, ...extra] };
    const part = createStoryViewModel(payload).parts.find(({ id }) => id === "p12");
    if (part === undefined) throw new Error("demo p12 part is missing");

    const seam = deriveApparatusSeam(payload, part);
    if (seam.kind !== "not-yet") throw new Error("31 siblings must have a seam");

    expect(seam.takeCount).toBe(31);
    expect(seam.doorways).toHaveLength(30);
    expect(seam.doorways.slice(0, APPARATUS_LABELS.length).map(({ label }) => label))
      .toEqual(APPARATUS_LABELS);
    expect(seam.doorways.slice(APPARATUS_LABELS.length).every(({ label }) => label === null))
      .toBeTrue();
    expect(seam.doorways.at(-1)).toMatchObject({
      preview: "extra doorway 26",
      takeIndex: 31,
      childCount: 1,
      label: null
    });
    expect(visibleApparatusDoorways(seam, true)).toEqual(seam.doorways.slice(0, 2));
    expect(visibleApparatusDoorways(seam, false)).toEqual(seam.doorways.slice(0, 4));
    expect(resolveApparatusLabel(seam.doorways, "z"))
      .toEqual(seam.doorways[APPARATUS_LABELS.length - 1]);
    expect(resolveApparatusLabel(seam.doorways, "a")).toBeNull();
    expect(resolveApparatusLabel(seam.doorways, "c")).toBeNull();
    expect(resolveApparatusLabel(seam.doorways, "unused")).toBeNull();
  });
});

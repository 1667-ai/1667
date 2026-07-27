import { describe, expect, test } from "bun:test";
import { countWords } from "../../shared/story-text.js";
import { createDemoController } from "../src/demo.js";
import { createStoryViewModel, popUndo, pushUndo, resolveSwitchTarget } from "../src/model.js";
import type { StreamView } from "../src/state.js";
import { storyLines } from "../../shared/story-model.js";

const STREAM_STARTED_AT = "2026-07-22T00:00:00.000Z";

describe("story view model", () => {
  test("derives the active line in order", () => {
    const payload = createDemoController().payload();
    const model = createStoryViewModel(payload);
    expect(model.parts.map((part) => part.id)).toEqual(Array.from({ length: 13 }, (_, offset) => `p${offset + 1}`));
    expect(model.activeLeafId).toBe("p13");
    expect(payload.nodes).toHaveLength(24);
    expect(model.rows.map((row) => row.kind)).toEqual([
      "part", "part", "part", "part", "part", "chapter-summary", "chapter-divider",
      "part", "part", "part", "part", "part", "chapter-divider", "part", "part", "part"
    ]);
    expect(payload.bookmarks).toHaveLength(4);
    expect(storyLines(payload).lines).toHaveLength(5);
  });

  test("resolves adjacent siblings with wrap-around", () => {
    const payload = createDemoController().payload();
    expect(resolveSwitchTarget(payload, "p6", -1)).toBe(null);
    expect(resolveSwitchTarget(payload, "p6", 1)).toBe(null);
    expect(resolveSwitchTarget(payload, "p12", -1)).toEqual({ id: "p12-t2", index: 2, count: 5 });
    expect(resolveSwitchTarget(payload, "p12", 1)).toEqual({ id: "p12-t4", index: 4, count: 5 });
    expect(resolveSwitchTarget(payload, "p12-t1", -1)).toEqual({ id: "p12-t5", index: 5, count: 5 });
    expect(resolveSwitchTarget(payload, "p12-t5", 1)).toEqual({ id: "p12-t1", index: 1, count: 5 });
    const part = createStoryViewModel(payload).parts.find((candidate) => candidate.id === "p12");
    expect(resolveSwitchTarget(payload, "p12", 1)?.count).toBe(part?.siblingCount);
  });

  test("records and consumes undo entries", () => {
    const payload = createDemoController().payload();
    const stack = pushUndo([], payload, "p12");
    expect(stack).toEqual([{ kind: "switch", leafId: "p13", nodeId: "p12" }]);
    expect(popUndo(stack)).toEqual({ entry: { kind: "switch", leafId: "p13", nodeId: "p12" }, rest: [] });
    expect(popUndo([])).toEqual({ entry: null, rest: [] });
  });

  test("reports exact take position for the 20-take debug part", () => {
    const model = createStoryViewModel(createDemoController(true).payload());
    const part = model.parts.find((candidate) => candidate.id === "p12");
    expect(part?.takeIndex).toBe(12);
    expect(part?.siblingCount).toBe(20);
  });

  test("derives pending retake identity from the canonical stream projection", () => {
    const payload = createDemoController().payload();
    const stream: StreamView = {
      targetId: "pending-retake",
      parentId: "p11",
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "retake the confrontation",
      text: "A newly claimed line",
      partNumber: 12
    };

    const model = createStoryViewModel(payload, stream);
    const pending = model.parts.at(-1);

    expect(pending).toMatchObject({
      id: "pending-retake",
      number: 12,
      pathIndex: 11,
      siblingCount: 6,
      takeIndex: 6,
      node: {
        parentId: "p11",
        instruction: "retake the confrontation",
        text: "A newly claimed line",
        createdAt: STREAM_STARTED_AT
      },
      stub: {
        words: 4,
        lastTouched: STREAM_STARTED_AT,
        hasInstruction: true
      }
    });
    expect(model.activeLeafId).toBe("pending-retake");
  });

  test("counts an appended stream once in its part and story totals", () => {
    const payload = createDemoController().payload();
    const leaf = payload.path.at(-1)!;
    const continuation = " APPEND_ONCE_MARKER arrives now";
    const stream: StreamView = {
      targetId: leaf.id,
      parentId: leaf.parentId,
      append: true,
      startedAt: STREAM_STARTED_AT,
      instruction: "continue",
      text: continuation
    };

    const model = createStoryViewModel(payload, stream);
    const appended = model.parts.at(-1)!;
    const expectedText = `${leaf.text}${continuation}`;
    const expectedTotal = payload.path.reduce((sum, node) =>
      sum + countWords(node.id === leaf.id ? expectedText : node.text), 0);

    expect(appended.node.text).toBe(expectedText);
    expect(appended.node.text.match(/APPEND_ONCE_MARKER/g)).toHaveLength(1);
    expect(appended.words).toBe(countWords(expectedText));
    expect(model.totalWords).toBe(expectedTotal);
  });

  test("keeps a whitespace-only pending take visible while streaming", () => {
    const payload = createDemoController().payload();
    const leaf = payload.path.at(-1)!;
    const stream: StreamView = {
      targetId: "pending-empty-take",
      parentId: leaf.id,
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "continue",
      text: " \n\t "
    };

    const model = createStoryViewModel(payload, stream);
    const pending = model.parts.at(-1);

    expect(pending).toMatchObject({
      id: "pending-empty-take",
      number: 14,
      siblingCount: 1,
      takeIndex: 1,
      node: { text: "", createdAt: STREAM_STARTED_AT },
      stub: { words: 0, lastTouched: STREAM_STARTED_AT }
    });
    expect(model.activeLeafId).toBe("pending-empty-take");
  });
});

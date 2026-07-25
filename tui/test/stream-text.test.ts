import { describe, expect, test } from "bun:test";
import type { StreamView } from "../src/state.js";
import {
  appendStreamText,
  emptyStreamText,
  streamHasSubstantiveText,
  streamTrimBounds,
  streamTrimmedText
} from "../src/stream-text.js";

function stream(): StreamView {
  return {
    targetId: "stream",
    parentId: null,
    append: false,
    startedAt: "2026-07-23T00:00:00Z",
    instruction: "",
    ...emptyStreamText()
  };
}

describe("incremental stream trim metadata", () => {
  test("matches String.trim across arbitrary delta boundaries", () => {
    const current = stream();
    const deltas = [
      " \r",
      "\n\u00a0",
      "The",
      " lantern ",
      "\t",
      "waited",
      "\u2003\n"
    ];

    for (const delta of deltas) {
      appendStreamText(current, delta);
      expect(streamTrimmedText(current)).toBe(current.text.trim());
      expect(streamHasSubstantiveText(current)).toBe(current.text.trim().length > 0);
    }
  });

  test("reads a large metadata-backed stream without a legacy full scan", () => {
    const current = stream();
    appendStreamText(current, " ".repeat(20_000));

    expect(streamTrimBounds(current)).toEqual({ start: 0, end: 0 });
    appendStreamText(current, "kept");
    appendStreamText(current, "\n".repeat(20_000));
    expect(streamTrimmedText(current)).toBe("kept");
  });

  test("rejects large legacy streams without incremental bounds", () => {
    const legacy = {
      ...stream(),
      text: " ".repeat(8_193),
      trimStart: undefined,
      trimEnd: undefined
    };

    expect(() => streamTrimBounds(legacy)).toThrow(
      "Large stream text is missing incremental trim metadata."
    );
  });
});

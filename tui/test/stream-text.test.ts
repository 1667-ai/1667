import { describe, expect, test } from "bun:test";
import type { StreamView } from "../src/state.js";
import { createTextPresentation } from "../src/text-presentation.js";
import {
  appendStreamReasoning,
  appendStreamText,
  emptyStreamText,
  streamHasSubstantiveReasoning,
  streamHasSubstantiveText,
  streamReasoningTrimmedText,
  streamPresentedTrimBounds,
  streamPresentedTrimmedText,
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

  test("keeps exact presented trim offsets when the prefix starts with whitespace", () => {
    const current = stream();
    current.presentation = createTextPresentation();
    appendStreamText(current, "  hello  ");

    expect(streamPresentedTrimBounds(current)).toEqual({ start: 2, end: 7 });
    expect(streamPresentedTrimmedText(current)).toBe("hello");

    appendStreamText(current, " world ");
    current.presentation.advance();
    expect(streamPresentedTrimBounds(current)).toEqual({ start: 2, end: 15 });
    expect(streamPresentedTrimmedText(current)).toBe("hello   world");
    current.presentation.dispose();
  });
});

describe("incremental stream reasoning trim metadata", () => {
  test("matches String.trim across arbitrary delta boundaries, kept off stream.text", () => {
    const current = stream();
    appendStreamText(current, "settled prose");
    const deltas = [
      " \r",
      "\n ",
      "The",
      " model ",
      "\t",
      "weighed",
      " \n"
    ];

    for (const delta of deltas) {
      appendStreamReasoning(current, delta, deltas.indexOf(delta) + 1);
      expect(streamReasoningTrimmedText(current)).toBe(current.reasoning!.text.trim());
      expect(streamHasSubstantiveReasoning(current)).toBe(current.reasoning!.text.trim().length > 0);
    }
    // Reasoning never touches the prose channel it started with.
    expect(streamTrimmedText(current)).toBe("settled prose");
  });

  test("a stream with no reasoning reports none, never a fabricated empty channel", () => {
    const current = stream();
    appendStreamText(current, "prose only");
    expect(current.reasoning).toBe(undefined);
    expect(streamHasSubstantiveReasoning(current)).toBeFalse();
    expect(streamReasoningTrimmedText(current)).toBe("");
  });

  test("tokenCount updates even when a delta carries no new text", () => {
    const current = stream();
    appendStreamReasoning(current, "first", 1);
    appendStreamReasoning(current, "", 4);
    expect(current.reasoning!.tokenCount).toBe(4);
    expect(current.reasoning!.text).toBe("first");
  });
});

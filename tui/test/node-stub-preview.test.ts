import { describe, expect, test } from "bun:test";
import {
  boundedNodeStubPreviewText,
  nodeStubPreviewText
} from "../../shared/node-stub.js";

describe("bounded node stub preview", () => {
  test("matches the canonical preview when its source fits the budget", () => {
    const text = `  ${"visible prose ".repeat(80)}`;
    const preview = boundedNodeStubPreviewText(text, 512);

    expect(preview.complete).toBeTrue();
    expect(preview.text).toBe(nodeStubPreviewText(text));
  });

  test("defers pathological leading whitespace within a fixed source budget", () => {
    const preview = boundedNodeStubPreviewText(`${" ".repeat(10_000)}prose`, 512);

    expect(preview.complete).toBeFalse();
    expect(preview.text).toBe("");
  });

  test("defers an incomplete oversized grapheme", () => {
    const text = `a${"\u0301".repeat(10_000)} tail`;
    const preview = boundedNodeStubPreviewText(text, 512);

    expect(preview.complete).toBeFalse();
  });
});

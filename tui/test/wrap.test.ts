import { describe, expect, test } from "bun:test";
import { createResumableWrap, createWrapCache, wrapText } from "../src/wrap.js";
import { cellWidth } from "../src/cell-width.js";

describe("span-aware wrapping", () => {
  test("style spans survive line breaks", () => {
    const lines = wrapText("alpha beta gamma", [{ start: 6, end: 16, style: "human" }], 10);
    expect(lines.map((line) => line.text)).toEqual(["alpha beta", "gamma"]);
    expect(lines[0]!.styleRuns).toEqual([{ start: 6, end: 10, style: "human" }]);
    expect(lines[1]!.styleRuns).toEqual([{ start: 0, end: 5, style: "human" }]);
  });

  test("wraps at word boundaries", () => {
    expect(wrapText("alpha beta gamma", [], 10).map((line) => line.text)).toEqual(["alpha beta", "gamma"]);
  });

  test("hard-breaks words longer than the measure", () => {
    expect(wrapText("supercalifragilistic", [], 5).map((line) => line.text))
      .toEqual(["super", "calif", "ragil", "istic"]);
  });

  test("measures wide and combining graphemes in terminal cells", () => {
    expect(wrapText("界界界", [], 4).map((line) => line.text)).toEqual(["界界", "界"]);
    expect(cellWidth("e\u0301界🙂")).toBe(5);
  });

  test("keeps text-default flags narrow without shrinking emoji sequences", () => {
    expect(cellWidth("⚑⚐")).toBe(2);
    expect(cellWidth("⚑️")).toBe(2);
    expect(cellWidth("🙂🇩🇪1️⃣")).toBe(6);
  });

  test("keeps control grapheme semantics outside the printable-ASCII fast path", () => {
    expect(cellWidth("\r\n")).toBe(1);
  });

  test("aligns raw style seams during synchronous and resumable segmentation", () => {
    const text = "ae\u0301b";
    const runs = [{ start: 2, end: text.length, style: "streaming" }];
    const expected = [{
      text,
      start: 0,
      end: text.length,
      styleRuns: [{ start: 1, end: text.length, style: "streaming" }]
    }];

    expect(wrapText(text, runs, 10)).toEqual(expected);
    const resumable = createResumableWrap(text, runs, 10);
    while (!resumable.advance(() => true)) {
      // Drain the bounded segmentation and materialization phases.
    }
    expect(resumable.result()).toEqual(expected);
    expect(wrapText("\r\nx", [{ start: 1, end: 3, style: "streaming" }], 10)
      .flatMap((line) => line.styleRuns.map((run) => line.start + run.start)))
      .toEqual([0, 2]);
  });

  test("cache keys part and width and supports invalidation", () => {
    const cache = createWrapCache<string>();
    const runs = [{ start: 0, end: 5, style: "human" }];
    const first = cache.wrap("p1", 10, "alpha beta", runs);
    expect(cache.wrap("p1", 10, "alpha beta", runs)).toBe(first);
    expect(cache.hits).toBe(1);
    cache.wrap("p1", 8, "alpha beta", runs);
    expect(cache.misses).toBe(2);
    cache.invalidate("p1");
    cache.wrap("p1", 10, "alpha beta", runs);
    expect(cache.misses).toBe(3);
  });

  test("cache misses when style runs change without changing text", () => {
    const cache = createWrapCache<string>();
    const human = [{ start: 0, end: 5, style: "human" }];
    cache.wrap("p1", 10, "alpha beta", human);
    expect(cache.isWarm("p1", 10, "alpha beta", human)).toBeTrue();
    expect(cache.isWarm("p1", 10, "alpha beta", [])).toBeFalse();
    cache.wrap("p1", 10, "alpha beta", []);
    expect(cache.misses).toBe(2);
  });

  test("cache exposes warm line counts without reconstructing wrap inputs", () => {
    const cache = createWrapCache();
    expect(cache.lineCount("part", 5, "one two three")).toBe(null);
    const wrapped = cache.wrap("part", 5, "one two three", []);
    expect(cache.lineCount("part", 5, "one two three")).toBe(wrapped.length);
    expect(cache.lineCount("part", 5, "changed text")).toBe(null);
    cache.invalidate("part");
    expect(cache.lineCount("part", 5, "one two three")).toBe(null);
  });

  test("cache uses immutable content identity for warm prose", () => {
    const cache = createWrapCache();
    const source = {};
    const identity = {
      source,
      stream: null,
      streamStart: 0,
      streamEnd: 0,
      textLength: 13
    };
    const firstText = ["one two", " three"].join("");
    const sameText = ["one ", "two three"].join("");
    const wrapped = cache.wrap("part", 5, firstText, [], identity);

    expect(cache.wrap("part", 5, sameText, [], { ...identity })).toBe(wrapped);
    expect(cache.lineCount("part", 5, sameText, identity)).toBe(wrapped.length);
    expect(cache.isWarm("part", 5, sameText, [], {
      ...identity,
      source: {}
    })).toBeFalse();
  });

  test("resumable wrapping exactly matches synchronous wrapping", () => {
    const cases = [
      { text: "alpha beta gamma", width: 10 },
      { text: "first\n\nlast\n", width: 4 },
      { text: "first\r\n\r\nlast\r\n", width: 4 },
      { text: "界界 e\u0301 🙂 supercalifragilistic", width: 5 },
      { text: " ".repeat(20) + "end", width: 3 },
      { text: "word ".repeat(100), width: 8 }
    ];
    let totalSlices = 0;
    for (const { text, width } of cases) {
      const runs = [{ start: 1, end: Math.max(1, text.length - 1), style: "human" }];
      const task = createResumableWrap(text, runs, width);
      let checks = 0;
      while (!task.advance(() => ++checks % 2 === 0)) totalSlices += 1;
      expect(task.result()).toEqual(wrapText(text, runs, width));
    }
    expect(totalSlices).toBeGreaterThan(0);
  });

  test("resumable wrapping withholds partial results", () => {
    const task = createResumableWrap("word ".repeat(1_000), [], 8);
    expect(task.advance(() => true)).toBeFalse();
    expect(() => task.result()).toThrow("before completion");
  });

  test("resumable wrapping yields while skipping a long leading-space run", () => {
    const text = `${" ".repeat(4_095)}x`;
    const task = createResumableWrap(text, [], 8);
    let checks = 0;

    expect(task.advance(() => ++checks > 64)).toBeFalse();
    expect(checks).toBe(65);
    while (!task.advance(() => true)) {
      // Drain the remaining bounded slices.
    }
    expect(task.result()).toEqual(wrapText(text, [], 8));
  });

  test("resumable wrapping yields while locating a newline-free ASCII paragraph", () => {
    const text = "word ".repeat(4_000);
    const task = createResumableWrap(text, [], 8);
    let checks = 0;

    expect(task.advance(() => ++checks === 1)).toBeFalse();
    expect(checks).toBe(1);
    while (!task.advance(() => true)) {
      // Drain incremental newline discovery, ASCII segmentation, and wrapping.
    }
    expect(task.result()).toEqual(wrapText(text, [], 8));
  });

  test("resumable segmentation charges adjacent one-cell graphemes", () => {
    const text = "x".repeat(64);
    const task = createResumableWrap(text, [], 64);
    let discoveryChecks = 0;

    expect(task.advance(() => ++discoveryChecks === 1)).toBeFalse();
    expect(discoveryChecks).toBe(1);
    let segmentationChecks = 0;
    expect(task.advance(() => {
      segmentationChecks += 1;
      return true;
    })).toBeFalse();
    expect(segmentationChecks).toBe(1);

    while (!task.advance(() => true)) {
      // Drain line and style materialization after the charged cell slice.
    }
    expect(task.result()).toEqual(wrapText(text, [], 64));
  });

  test("resumable style-run normalization and clipping yield without changing order", () => {
    const text = "ae\u0301 word ".repeat(200);
    const runs = Array.from({ length: 600 }, (_, index) => {
      const start = (index * 17) % (text.length - 20);
      return { start, end: start + 20, style: index };
    }).reverse();
    const task = createResumableWrap(text, runs, 8);
    let slices = 0;

    while (!task.advance(() => true)) slices += 1;

    expect(slices).toBeGreaterThan(10);
    expect(task.result()).toEqual(wrapText(text, runs, 8));
  });
});

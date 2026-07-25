import { describe, expect, test } from "bun:test";
import { takeStrip } from "../src/screens/story/density.js";

describe("take density ladder", () => {
  test("three takes use spaced dots", () => {
    expect(takeStrip(2, 3)).toEqual({
      density: "spaced",
      text: "○ ● ○",
      currentOffset: 2,
      counter: "‹ take 2/3 ›"
    });
  });

  test("eight takes use condensed dots", () => {
    expect(takeStrip(6, 8)).toEqual({
      density: "condensed",
      text: "○○○○○●○○",
      currentOffset: 5,
      counter: "‹ take 6/8 ›"
    });
  });

  test("twenty takes use the fourteen-cell gauge", () => {
    expect(takeStrip(12, 20)).toEqual({
      density: "gauge",
      text: "───────●──────",
      currentOffset: 7,
      counter: "‹ take 12/20 ›"
    });
  });
});

import { describe, expect, test } from "bun:test";
import { takeStrip } from "../src/screens/story/density.js";

describe("take density ladder", () => {
  test("three takes use spaced dots", () => {
    expect(takeStrip(2, 3)).toEqual({
      density: "spaced",
      cells: ["○", "●", "○"],
      text: "○ ● ○",
      currentOffset: 2,
      counter: "‹ take 2/3 ›"
    });
  });

  test("eight takes use condensed dots", () => {
    expect(takeStrip(6, 8)).toEqual({
      density: "condensed",
      cells: ["○", "○", "○", "○", "○", "●", "○", "○"],
      text: "○○○○○●○○",
      currentOffset: 5,
      counter: "‹ take 6/8 ›"
    });
  });

  test("twenty takes use the fourteen-cell gauge", () => {
    expect(takeStrip(12, 20)).toEqual({
      density: "gauge",
      cells: [],
      text: "───────●──────",
      currentOffset: 7,
      counter: "‹ take 12/20 ›"
    });
  });
});

describe("subtake ring on the page strip", () => {
  test("an alternate take that branches wears the ring, a childless one does not", () => {
    expect(takeStrip(2, 4, [true, false, true, false]).text).toBe("◎ ● ◎ ○");
  });

  test("the take you are reading is never ringed, even when it branches", () => {
    // Decision 18's cursor exception carried to the page: its subtakes are the
    // parts below it, so a ring would only repeat what is already on screen.
    expect(takeStrip(1, 3, [true, true, false]).text).toBe("● ◎ ○");
  });

  test("condensed strips ring the same way", () => {
    const flags = Array.from({ length: 8 }, (_, index) => index % 2 === 0);
    expect(takeStrip(6, 8, flags).text).toBe("◎○◎○◎●◎○");
  });

  test("takes with no subtake information stay plain", () => {
    expect(takeStrip(2, 3).text).toBe("○ ● ○");
  });

  test("the gauge has no per-take cell to ring", () => {
    expect(takeStrip(12, 20, Array.from({ length: 20 }, () => true)).text)
      .toBe("───────●──────");
  });
});

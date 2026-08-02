import { expect, test } from "bun:test";
import { createPalette } from "../src/palette.js";
import { frameStyledText, frameText, type FrameLine } from "../src/screens/story/frame.js";

test("frameStyledText and frameText project prose and line segments correctly while preserving chrome line breaks", () => {
  const lines: FrameLine[] = [
    [
      { text: "Prose line\nWith LF and \u202EBidi controls", prose: true },
      { text: "Strict line\nWith LF and \u202EBidi controls" }
    ],
    [
      { text: "Second line", prose: true }
    ]
  ];

  const textOutput = frameText(lines);
  expect(textOutput).toBe(
    "Prose line\nWith LF and \u202EBidi controlsStrict line▪With LF and ▪Bidi controls\nSecond line"
  );

  const palette = createPalette("lantern", "256");
  const styledOutput = frameStyledText(lines, palette);

  // The painted text is the concatenation of the chunks, and it must agree with
  // frameText. The two are the only ways drawn text leaves the frame.
  const chunkTexts = styledOutput.chunks.map((chunk) => chunk.text);
  expect(chunkTexts.join("")).toBe(textOutput);
  expect(chunkTexts).toContain("Prose line\nWith LF and \u202EBidi controlsStrict line▪With LF and ▪Bidi controls");
  expect(chunkTexts).toContain("\n");
  expect(chunkTexts).toContain("Second line");
});

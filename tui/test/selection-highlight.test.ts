import { expect, test } from "bun:test";
import { paintStorySelection } from "../src/screens/story/selection-highlight.js";

test("semantic selection highlights only the selected prose slice", () => {
  const source = "lantern remembers";
  const lines = paintStorySelection([[
    {
      text: source,
      role: "prose",
      storySource: { key: "part:text", text: source, start: 0 }
    }
  ]], [{ key: "part:text", text: source, start: 8, end: 17 }]);

  expect(lines[0]?.map(({ text }) => text)).toEqual(["lantern ", "remembers"]);
  expect(lines[0]?.[0]?.background).toBe(undefined);
  expect(lines[0]?.[1]).toMatchObject({
    text: "remembers",
    role: "background",
    background: "focus / accent",
    storySource: { key: "part:text", text: source, start: 8 }
  });
});

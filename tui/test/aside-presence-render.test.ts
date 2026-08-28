import { expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine, visibleWidth } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

test("story rendering keeps the READ waymark inside the 80-column boundary", () => {
  const source = demoAppSource();
  // The default demo viewport shows the chapter-three path. Anchor its first
  // visible part so the assertion exercises the narrow boundary fold.
  const firstTake = source.payload.path[10]!;
  const state = initialState(source, false);
  state.payload = {
    ...source.payload,
    asidePresence: {
      anchors: [{ partId: firstTake.id, takeId: firstTake.id, sessionCount: 1 }],
      unanchoredCount: 2
    }
  };
  const rendered = renderStoryScreen(state, {
    width: 80,
    height: 24,
    wrapCache: createWrapCache<ProseStyle>()
  });
  const lines = rendered.lines.map(plainLine);
  expect(lines.some((line) => line.includes("1 aside"))).toBeTrue();
  expect(lines.every((line) => visibleWidth(line) <= 80)).toBeTrue();
});

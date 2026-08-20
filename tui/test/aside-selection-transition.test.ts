import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { dispatch, initialState } from "../src/app.js";
import { createAsideSurface } from "../src/aside-surface.js";
import { demoAppSource } from "../src/demo.js";
import { createPalette } from "../src/palette.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import { createStorySurface } from "../src/story-surface.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

test("leaving ASIDE clears the native selection from the replaced Aside surface", async () => {
  const width = 80;
  const height = 24;
  const setup = await createTestRenderer({ width, height });
  const source = demoAppSource(false);
  const state = initialState(source, false);
  state.aside = createAsideSurface(state.payload.id, state.payload.title);
  state.mode = "ASIDE";
  const palette = createPalette("lantern", "256");
  const wrapCache = createWrapCache<ProseStyle>();
  const layout = deriveStoryFrameLayout(width, state.config);
  const surface = createStorySurface(setup.renderer, palette);
  const frame = renderStoryScreen(state, { width, height, layout, wrapCache });

  surface.paint(frame.lines, palette, layout, frame.selectable);
  await setup.renderOnce();
  const page = setup.renderer.root.findDescendantById("story") as TextRenderable;
  setup.renderer.startSelection(page, 0, 0);
  setup.renderer.updateSelection(page, 5, 0, { finishDragging: true });
  expect(setup.renderer.getSelection()).not.toBeNull();

  await dispatch(
    { action: "cancel" }, state, source, wrapCache,
    () => undefined, async () => undefined, () => undefined, setup.renderer
  );

  expect(state.mode).toBe("NAV");
  expect(setup.renderer.getSelection()).toBeNull();
  setup.renderer.destroy();
});

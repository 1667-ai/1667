import { expect, test } from "bun:test";
import { MouseEvent, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createPalette } from "../src/palette.js";
import { storyTextFromRendererSelection } from "../src/copy-actions.js";
import { raisedSegment } from "../src/screens/overlay.js";
import { fitLine, segment, type FrameLine } from "../src/screens/story/frame.js";
import { buildStorySelectionProjection } from "../src/selection-projection.js";
import { createStorySurface } from "../src/story-surface.js";

test("story surface isolates rail selection and leaves wheel scrolling to the app", async () => {
  const setup = await createTestRenderer({ width: 18, height: 2 });
  const palette = createPalette("lantern", "256");
  const surface = createStorySurface(setup.renderer, palette);
  const frame: FrameLine[] = [
    [segment("story     "), segment("│ fact  ")],
    [segment("prose     "), segment("│ note  ")],
    [segment("more      "), segment("│ detail")]
  ];
  const layout = {
    fullWidth: 18,
    pageWidth: 10,
    railStart: 10,
    factLeft: 11,
    railRight: 18
  };
  surface.paint(frame, palette, layout, null);
  await setup.renderOnce();

  const page = setup.renderer.root.findDescendantById("story") as TextRenderable;
  const rail = setup.renderer.root.findDescendantById("story-rail") as TextRenderable;
  const overlayRail = setup.renderer.root.findDescendantById("story-overlay-rail") as TextRenderable;
  expect(page.selectable).toBeTrue();
  expect(rail.selectable).toBeFalse();
  expect(overlayRail.visible).toBeFalse();
  expect(page.plainText).not.toContain("fact");
  expect(rail.plainText).toContain("fact");

  surface.paint(frame, palette, layout, null, { singleSelectionBuffer: true });
  expect(page.plainText).toContain("fact");
  expect(rail.visible).toBeFalse();
  expect(overlayRail.visible).toBeFalse();
  surface.paint(frame, palette, layout, null);

  const panelFrame = [[segment("story     "), raisedSegment("│ panel")]];
  surface.paint(panelFrame, palette, layout, null);
  expect(overlayRail.visible).toBeFalse();
  surface.paint(panelFrame, palette, layout, { left: 10, top: 0, right: 17, bottom: 1 });
  expect(rail.selectable).toBeFalse();
  expect(overlayRail.visible).toBeTrue();
  expect(overlayRail.plainText).toContain("panel");
  surface.paint(frame, palette, layout, null);
  expect(overlayRail.visible).toBeFalse();

  surface.paint([
    [segment("123456789界tail")],
    [segment("12345678界tail")]
  ], palette, layout, null);
  const boundaryGlyph = setup.renderer.root.findDescendantById("story-boundary-glyph-0") as TextRenderable;
  const pageLines = page.plainText.split("\n");
  expect(pageLines[0]).not.toContain("界");
  expect(pageLines[1]).toContain("界");
  expect(rail.plainText).not.toContain("界");
  expect(rail.left).toBe(10);
  expect(boundaryGlyph.left).toBe(9);
  expect(boundaryGlyph.plainText).toContain("界");
  surface.paint(frame, palette, layout, null);
  expect(boundaryGlyph.visible).toBeFalse();

  page.processMouseEvent(new MouseEvent(page, {
    type: "scroll", button: 0, x: 1, y: 1,
    modifiers: { shift: false, alt: false, ctrl: false },
    scroll: { direction: "down", delta: 1 }
  }));
  expect(page.maxScrollY).toBeGreaterThan(0);
  expect(page.scrollY).toBe(0);
  setup.renderer.destroy();
});

test("OpenTUI story selection offsets follow display cells for wide and combined graphemes", async () => {
  const setup = await createTestRenderer({ width: 8, height: 3 });
  const palette = createPalette("lantern", "256");
  const surface = createStorySurface(setup.renderer, palette);
  const source = "A界B\nC💡D\nEe\u0301F";
  const key = "part:text";
  const frame: FrameLine[] = [
    fitLine([{ text: "A界B", storySource: { key, text: source, start: 0 } }], 8),
    fitLine([{ text: "C💡D", storySource: { key, text: source, start: 4 } }], 8),
    fitLine([{ text: "Ee\u0301F", storySource: { key, text: source, start: 9 } }], 8)
  ];
  surface.paint(frame, palette, {
    fullWidth: 8, pageWidth: 8, railStart: null, factLeft: null, railRight: null
  }, null);
  await setup.renderOnce();

  const page = setup.renderer.root.findDescendantById("story") as TextRenderable;
  const projection = buildStorySelectionProjection(frame, 8)!;
  setup.renderer.startSelection(page, 0, 0);
  setup.renderer.updateSelection(page, 3, 1, { finishDragging: true });
  expect(storyTextFromRendererSelection(setup.renderer, projection)).toBe("A界B\nC💡");

  setup.renderer.clearSelection();
  setup.renderer.startSelection(page, 0, 2);
  setup.renderer.updateSelection(page, 2, 2, { finishDragging: true });
  expect(storyTextFromRendererSelection(setup.renderer, projection)).toBe("Ee\u0301");
  setup.renderer.destroy();
});

test("story surface restores selection ownership on an identical interactive repaint", async () => {
  const setup = await createTestRenderer({ width: 18, height: 2 });
  const palette = createPalette("lantern", "256");
  const surface = createStorySurface(setup.renderer, palette);
  const frame = [[segment("story prose")]];
  const layout = {
    fullWidth: 18, pageWidth: 18, railStart: null, factLeft: null, railRight: null
  };
  surface.paint(frame, palette, layout, null);
  const page = setup.renderer.root.findDescendantById("story") as TextRenderable;

  surface.setPageSelectable(false);
  expect(page.selectable).toBeFalse();
  surface.paint(frame, palette, layout, null);
  expect(page.selectable).toBeTrue();

  setup.renderer.destroy();
});

test("story surface disables every selectable layer after a partial paint failure", async () => {
  const setup = await createTestRenderer({ width: 18, height: 2 });
  const palette = createPalette("lantern", "256");
  const surface = createStorySurface(setup.renderer, palette);
  const layout = {
    fullWidth: 18,
    pageWidth: 10,
    railStart: 10,
    factLeft: 11,
    railRight: 18
  };
  const overlayFrame = [[segment("old page  "), raisedSegment("│ panel")]];
  surface.paint(overlayFrame, palette, layout, {
    left: 10, top: 0, right: 17, bottom: 1
  });
  await setup.renderOnce();

  const page = setup.renderer.root.findDescendantById("story") as TextRenderable;
  const rail = setup.renderer.root.findDescendantById("story-rail") as TextRenderable;
  const overlayRail = setup.renderer.root.findDescendantById("story-overlay-rail") as TextRenderable;
  const content = Object.getOwnPropertyDescriptor(TextRenderable.prototype, "content")!;
  let failOnce = true;
  Object.defineProperty(rail, "content", {
    configurable: true,
    get() {
      return content.get!.call(rail);
    },
    set(value: TextRenderable["content"]) {
      if (failOnce) {
        failOnce = false;
        throw new Error("rail paint failed");
      }
      content.set!.call(rail, value);
    }
  });

  const next = [
    [segment("123456789界tail")],
    [segment("new page  "), segment("│ new   ")]
  ];
  expect(() => surface.paint(next, palette, layout, null)).toThrow("rail paint failed");
  expect(overlayRail.visible).toBeTrue();
  const boundaryGlyph = setup.renderer.root.findDescendantById("story-boundary-glyph-0") as TextRenderable;

  setup.renderer.clearSelection();
  surface.setPageSelectable(false);
  expect(page.selectable).toBeFalse();
  expect(overlayRail.selectable).toBeFalse();
  expect(boundaryGlyph.selectable).toBeFalse();
  setup.renderer.startSelection(overlayRail, 0, 0);
  setup.renderer.updateSelection(overlayRail, 5, 0, { finishDragging: true });
  expect(setup.renderer.getSelection()).toBe(null);

  surface.paint(next, palette, layout, null);
  expect(page.selectable).toBeTrue();
  expect(overlayRail.selectable).toBeTrue();
  expect(boundaryGlyph.selectable).toBeTrue();
  expect(overlayRail.visible).toBeFalse();

  setup.renderer.destroy();
});

test("story surface retries an identical frame after a partial paint failure", async () => {
  const setup = await createTestRenderer({ width: 18, height: 2 });
  const palette = createPalette("lantern", "256");
  const surface = createStorySurface(setup.renderer, palette);
  const layout = {
    fullWidth: 18,
    pageWidth: 10,
    railStart: 10,
    factLeft: 11,
    railRight: 18
  };
  surface.paint([[segment("old page  "), segment("│ old   ")]], palette, layout, null);

  const page = setup.renderer.root.findDescendantById("story") as TextRenderable;
  const rail = setup.renderer.root.findDescendantById("story-rail") as TextRenderable;
  const content = Object.getOwnPropertyDescriptor(TextRenderable.prototype, "content")!;
  let failOnce = true;
  Object.defineProperty(rail, "content", {
    configurable: true,
    get() {
      return content.get!.call(rail);
    },
    set(value: TextRenderable["content"]) {
      if (failOnce) {
        failOnce = false;
        throw new Error("rail paint failed");
      }
      content.set!.call(rail, value);
    }
  });

  const next = [[segment("new page  "), segment("│ new   ")]];
  expect(() => surface.paint(next, palette, layout, null)).toThrow("rail paint failed");
  expect(page.plainText).toContain("new page");
  expect(rail.plainText).toContain("old");

  surface.paint(next, palette, layout, null);
  expect(page.plainText).toContain("new page");
  expect(rail.plainText).toContain("new");
  setup.renderer.destroy();
});

import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { createComposer } from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { attachDraftImage, type DraftImage } from "../src/draft-image.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { renderComposerLayout } from "../src/screens/story/composer.js";
import { spliceDraftImageRows } from "../src/screens/story/draft-image-rows.js";

function image(id: string, width: number, height: number, byteLength: number): DraftImage {
  return {
    leaseId: id.padStart(64, "a"),
    attachment: { objectId: id.padStart(64, "b"), mediaType: "image/png", width, height, byteLength }
  };
}

describe("draft image metadata rows above the composer", () => {
  test("splicing rows grows lineCount/bodyRows/cursorViewportRow by the inserted count", () => {
    const composer = createComposer("hello");
    const layout = renderComposerLayout({
      composer,
      terminalWidth: 100,
      terminalHeight: 24,
      measure: 72
    });
    const withImages = spliceDraftImageRows(layout, [
      image("1", 1_200, 800, 428 * 1024),
      image("2", 640, 480, 96 * 1024)
    ], "");

    expect(withImages.lines.length).toBe(layout.lines.length + 2);
    expect(withImages.lineCount).toBe(layout.lineCount + 2);
    expect(withImages.bodyRows).toBe(layout.bodyRows + 2);
    expect(withImages.cursorViewportRow).toBe(layout.cursorViewportRow + 2);
    // No images: an exact no-op, not merely an equivalent copy.
    expect(spliceDraftImageRows(layout, [], "")).toBe(layout);
  });

  test("a row names the position, media type, dimensions, and size, never inserted into the draft text", () => {
    const composer = createComposer("");
    const layout = renderComposerLayout({ composer, terminalWidth: 100, terminalHeight: 24, measure: 72 });
    const withImages = spliceDraftImageRows(layout, [image("1", 1_200, 800, 428 * 1024)], "");
    const text = frameText(withImages.lines);

    expect(text).toContain("Image 1");
    expect(text).toContain("PNG");
    expect(text).toContain("1200×800");
    expect(text).toContain("428 KiB");
    expect(text).toContain("remove");
    expect(composer.text).toBe("");
  });

  test("the story screen shrinks story content by exactly the attached row count", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    const bare = renderStoryScreen(state, { width: 120, height: 36 });
    attachDraftImage(state.composer, image("1", 1_200, 800, 428 * 1024));
    const withImage = renderStoryScreen(state, { width: 120, height: 36 });

    // The frame always fills the same terminal height; the row the image
    // added comes out of story content, not off the bottom of the screen.
    expect(withImage.lines.length).toBe(bare.lines.length);
    expect(frameText(withImage.lines)).toContain("Image 1");
    expect(frameText(bare.lines)).not.toContain("Image 1");
  });
});

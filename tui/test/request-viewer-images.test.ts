import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { attachDraftImage } from "../src/draft-image.js";
import { nextRequestContext } from "../src/request-context.js";
import { nextRequestEstimate } from "../src/request-projection.js";
import { renderRequestViewer } from "../src/screens/request-viewer.js";
import { frameText } from "../src/screens/story/frame.js";

describe("request viewer image blocks", () => {
  test("shows image metadata, marks the estimate with ~, and never a data URL", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    // A model this build has a documented visual-token formula for, so the
    // estimate is nonzero and the "~" mark has something to attach to.
    state.model = "claude-sonnet-5";
    const wouldBeBase64Payload = Buffer.alloc(64, 137).toString("base64");
    attachDraftImage(state.composer, {
      leaseId: "a".repeat(64),
      attachment: {
        objectId: "b".repeat(64),
        mediaType: "image/png",
        width: 1_024,
        height: 768,
        byteLength: 512_000
      }
    });

    const context = nextRequestContext(state);
    const estimate = nextRequestEstimate(state.payload, context);
    expect(estimate.breakdown.visual).toBeGreaterThan(0);
    const frame = renderRequestViewer(
      state,
      context,
      estimate,
      // Negative scrollTop reveals the focused message on this render, the
      // image rides the final ("request") turn, so the cursor has to land
      // there for its metadata row to be in the visible window.
      { cursor: estimate.messages.length - 1, scrollTop: -1, returnMode: "COMPOSE" },
      120,
      36
    );
    const text = frameText(frame.lines);

    expect(text).toContain("Image 1");
    expect(text).toContain("PNG");
    expect(text).toContain("1024×768");
    expect(text).toContain("500 KiB");
    expect(text).toContain("~");
    expect(text).not.toContain("data:image");
    expect(text).not.toContain("base64");
    expect(text).not.toContain(wouldBeBase64Payload);
  });

  test("no attachment means no image row and a zero visual estimate", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    const context = nextRequestContext(state);
    const estimate = nextRequestEstimate(state.payload, context);

    expect(estimate.breakdown.visual).toBe(0);
    expect(estimate.imageTokens.size).toBe(0);
    const frame = renderRequestViewer(
      state,
      context,
      estimate,
      { cursor: 0, scrollTop: 0, returnMode: "COMPOSE" },
      120,
      36
    );
    expect(frameText(frame.lines)).not.toContain("Image 1");
  });
});

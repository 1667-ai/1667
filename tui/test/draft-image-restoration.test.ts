import { describe, expect, test } from "bun:test";
import { ActionRuntime } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import { ApiFailureError } from "../src/api-error.js";
import { createComposer } from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { attachDraftImage, draftImagesFor, type DraftImage } from "../src/draft-image.js";
import { IMAGE_REATTACH_NOTICE } from "../src/image-attachment-failure.js";
import { composeAction } from "../src/story-actions.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import type { RuntimeState } from "../src/state.js";

function context(state: RuntimeState) {
  return {
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: null,
    applyTheme: () => undefined,
    previewTheme: () => undefined,
    backend: new ActionRuntime(state, () => undefined)
  };
}

function sampleImage(id: string): DraftImage {
  return {
    leaseId: id.padStart(64, "a"),
    attachment: {
      objectId: id.padStart(64, "b"),
      mediaType: "image/png",
      width: 200,
      height: 100,
      byteLength: 12_000
    }
  };
}

describe("draft image capture and restoration", () => {
  test("a generation failure restores the attached image alongside the instruction", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    state.composer = createComposer("look at this");
    const image = sampleImage("1");
    attachDraftImage(state.composer, image);
    source.api.continueStory = async () => { throw new Error("provider request failed"); };

    await composeAction({ action: "send" }, state, source, context(state));

    expect(state.composer.text).toBe("look at this");
    expect(draftImagesFor(state.composer)).toEqual([image]);
    expect(state.toast).toBe("provider request failed");
    expect(state.pendingGenerationDraft).toMatchObject({ restored: true });
  });

  test("an expired Draft Lease removes the row and tells the writer to reattach", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    state.composer = createComposer("look at this");
    attachDraftImage(state.composer, sampleImage("2"));
    source.api.continueStory = async () => {
      throw new ApiFailureError({
        kind: "plain",
        code: "image_attachment_expired",
        message: "the draft lease expired",
        status: 410
      });
    };

    await composeAction({ action: "send" }, state, source, context(state));

    expect(state.composer.text).toBe("look at this");
    expect(draftImagesFor(state.composer)).toHaveLength(0);
    expect(state.toast).toBe(IMAGE_REATTACH_NOTICE);
  });

  test("every other image failure code restores the image, not just the expiry", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    state.composer = createComposer("look at this");
    const image = sampleImage("3");
    attachDraftImage(state.composer, image);
    source.api.continueStory = async () => {
      throw new ApiFailureError({
        kind: "plain",
        code: "image_context_too_large",
        message: "too many images for this request",
        status: 413
      });
    };

    await composeAction({ action: "send" }, state, source, context(state));

    expect(draftImagesFor(state.composer)).toEqual([image]);
    expect(state.toast).toBe("too many images for this request");
  });

  test("a successful generation clears the attached images, not just the text", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    state.composer = createComposer("look at this");
    attachDraftImage(state.composer, sampleImage("4"));
    const payload = state.payload;
    source.api.continueStory = async () => ({ payload, droppedFacts: [] });

    await composeAction({ action: "send" }, state, source, context(state));

    expect(draftImagesFor(state.composer)).toHaveLength(0);
    expect(state.pendingGenerationDraft).toBe(null);
  });
});

describe("removing an attached image", () => {
  test("drops the row and releases the lease, best-effort", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    state.composer = createComposer("");
    const image = sampleImage("5");
    attachDraftImage(state.composer, image);
    let released: string | null = null;
    source.api.releaseStoryImage = async (_storyId, leaseId) => { released = leaseId; };

    await composeAction({ action: "remove-draft-image", index: 0 }, state, source, context(state));

    expect(draftImagesFor(state.composer)).toHaveLength(0);
    expect(released).toBe(image.leaseId);
    expect(state.toast).toBe("image removed");
  });

  test("an out-of-range index is a no-op", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    state.composer = createComposer("");
    attachDraftImage(state.composer, sampleImage("6"));

    await composeAction({ action: "remove-draft-image", index: 3 }, state, source, context(state));

    expect(draftImagesFor(state.composer)).toHaveLength(1);
  });
});

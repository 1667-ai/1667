import { describe, expect, test } from "bun:test";
import { ActionRuntime } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import type { AppSource } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { draftImagesFor } from "../src/draft-image.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import type { RuntimeState } from "../src/state.js";
import type { SettingsDocumentV2, SettingsProtocolV2 } from "../../shared/settings-v2-types.js";

/**
 * `pasteClipboardIntoComposer`'s clipboard read goes through
 * `readClipboardContent`, so this suite mocks `../src/clipboard.js` rather
 * than touching the host platform clipboard, the same technique
 * sampling-clipboard.test.ts already uses.
 */
type MockClipboardContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png"; bytes: Uint8Array };

const bunTest = await import("bun:test") as unknown as {
  mock: { module(path: string, factory: () => Record<string, unknown>): void };
};
let clipboardContent: MockClipboardContent | null = null;
bunTest.mock.module("../src/clipboard.js", () => ({
  readClipboardContent: async () => clipboardContent
}));

const { pasteClipboardIntoComposer } = await import("../src/compose-clipboard.js");

function backendContext(state: RuntimeState) {
  return {
    cache: createWrapCache<ProseStyle>(),
    backend: new ActionRuntime(state, () => undefined)
  };
}

/** Point the demo's Generation Profile at an explicit protocol and remote
 *  model id, the same two facts `resolveImageInputCapability` reads. */
function setRoute(source: AppSource, protocol: SettingsProtocolV2, remoteId: string): void {
  const view = source.settingsView;
  if (view.document === null) throw new Error("demo settings must carry a schema-2 document");
  const base = structuredClone(view.document);
  const connection = base.connections.demo;
  const model = base.models.demo;
  if (connection === undefined || model === undefined) throw new Error("demo document is missing its fixture route");
  const document = {
    ...base,
    connections: { ...base.connections, demo: { ...connection, protocol } },
    models: { ...base.models, demo: { ...model, remoteId } }
  };
  source.settingsView = { ...view, document };
}

describe("a clipboard image and the release gate", () => {
  test("falls back to the pre-Image-Input unreadable toast, never an error, while entry points are closed", async () => {
    clipboardContent = { type: "image", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "claude-sonnet-5");
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    let staged = false;
    source.api.stageStoryImage = async () => { staged = true; throw new Error("must not stage while entry points are closed"); };

    // This release's own default opens the gate (shared/image-input-release.ts),
    // so a genuine predecessor's refusal needs the explicit override; the
    // test right below drives the bare default instead.
    await pasteClipboardIntoComposer(state, source, backendContext(state), false);

    expect(staged).toBeFalse();
    expect(state.toast).toBe("clipboard unreadable · paste with ⌘V or ctrl+shift+v");
    expect(draftImagesFor(state.composer)).toHaveLength(0);
  });

  test("attaches the clipboard image as a Draft Image once entry points are open", async () => {
    clipboardContent = { type: "image", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "claude-sonnet-5");
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    const staged = {
      leaseId: "a".repeat(64),
      attachment: {
        objectId: "b".repeat(64),
        mediaType: "image/png" as const,
        width: 1,
        height: 1,
        byteLength: 3
      }
    };
    source.api.stageStoryImage = async (_storyId, mediaType, bytes) => {
      expect(mediaType).toBe("image/png");
      expect(bytes.byteLength).toBe(3);
      return staged;
    };

    await pasteClipboardIntoComposer(state, source, backendContext(state), true);

    expect(draftImagesFor(state.composer)).toEqual([staged]);
    expect(state.toast).toContain("Image 1");
  });
});

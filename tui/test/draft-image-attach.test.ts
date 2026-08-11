import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PNG_SIGNATURE } from "../../shared/png-text-chunk.js";
import { MAX_SOURCE_IMAGE_BYTES } from "../../shared/image-attachment.js";
import type { SettingsDocumentV2, SettingsProtocolV2 } from "../../shared/settings-v2-types.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import type { AppSource } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { draftImagesFor } from "../src/draft-image.js";
import { openImageAttach, imageAttachAction } from "../src/image-attach-actions.js";
import { IMAGE_INPUT_ENTRY_POINTS_CLOSED_MESSAGE, IMAGE_INPUT_UNKNOWN_MESSAGE } from "../src/image-input-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import type { RuntimeState } from "../src/state.js";

const execFileAsync = promisify(execFile);

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

/** Point the demo's Generation Profile at an explicit protocol and remote
 *  model id, the same two facts `resolveImageInputCapability` reads. */
function setRoute(source: AppSource, protocol: SettingsProtocolV2, remoteId: string): void {
  const view = source.settingsView;
  if (view.document === null) throw new Error("demo settings must carry a schema-2 document");
  const base: SettingsDocumentV2 = structuredClone(view.document);
  const connection = base.connections.demo;
  const model = base.models.demo;
  if (connection === undefined || model === undefined) throw new Error("demo document is missing its fixture route");
  const document: SettingsDocumentV2 = {
    ...base,
    connections: { ...base.connections, demo: { ...connection, protocol } },
    models: { ...base.models, demo: { ...model, remoteId } }
  };
  source.settingsView = { ...view, document };
}

/** A minimal, byte-exact PNG header: signature plus an IHDR chunk giving
 *  declared dimensions. `parseImageHeader` (server/image-header.ts) never
 *  decodes pixels, so no IDAT/IEND is needed for it to accept this. */
function minimalPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set(PNG_SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes[26] = 0;
  bytes[27] = 0;
  bytes[28] = 0;
  return bytes;
}

let leaseCounter = 0;
function stagedImage(width = 64, height = 48, byteLength = 4_096) {
  leaseCounter += 1;
  const hex = leaseCounter.toString(16).padStart(4, "0");
  return {
    leaseId: `${hex}${"a".repeat(60)}`,
    attachment: {
      objectId: `${hex}${"b".repeat(60)}`,
      mediaType: "image/png" as const,
      width,
      height,
      byteLength
    }
  };
}

/**
 * Every `openImageAttach` call below the release-gate block passes an
 * explicit `true` fourth argument, opening the gate that
 * shared/image-input-release.ts closes by default in this release. Those
 * tests are about capability resolution, the rewrite carve-out, path
 * handling, and the four-image ceiling, behavior that sits behind the
 * gate, not the gate itself, so they drive past it deliberately. The
 * release-gate block below is the one place that calls `openImageAttach`
 * with no override, pinning the production default.
 */
describe("the release gate", () => {
  test("refuses before any other check, and opens no panel, while entry points are closed", async () => {
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "claude-sonnet-5");
    const state = initialState(source, false);
    state.mode = "COMPOSE";

    openImageAttach(state, source);

    expect(state.toast).toBe(IMAGE_INPUT_ENTRY_POINTS_CLOSED_MESSAGE);
    expect(state.mode).toBe("COMPOSE");
    expect(state.image ?? null).toBe(null);
  });
});

describe("attach image capability gating", () => {
  test("refuses with the exact unknown-model message and opens no panel", async () => {
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "some-unreleased-model");
    const state = initialState(source, false);
    state.mode = "COMPOSE";

    openImageAttach(state, source, undefined, true);

    expect(state.toast).toBe(IMAGE_INPUT_UNKNOWN_MESSAGE);
    expect(state.mode).toBe("COMPOSE");
    expect(state.image ?? null).toBe(null);
  });

  test("refuses when the protocol does not carry images at all", async () => {
    const source = demoAppSource();
    // The demo's own dry-run protocol, unchanged.
    const state = initialState(source, false);
    state.mode = "COMPOSE";

    openImageAttach(state, source, undefined, true);

    expect(state.image ?? null).toBe(null);
    expect(state.mode).toBe("COMPOSE");
  });

  test("opens the panel once the route resolves to supported", async () => {
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "claude-sonnet-5");
    const state = initialState(source, false);
    state.mode = "COMPOSE";

    openImageAttach(state, source, undefined, true);

    expect(state.mode).toBe("IMAGE");
    expect(state.image?.returnMode).toBe("COMPOSE");
  });

  test("refuses to attach to a rewrite composer", async () => {
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "claude-sonnet-5");
    const state = initialState(source, false);
    state.retakePrompt = {
      nodeId: "p1",
      intent: { kind: "rewrite", start: 0, end: 0, expected: "" },
      composer: state.composer,
      composerScrollTop: 0,
      returnState: {
        composer: state.composer,
        composerScrollTop: 0,
        historyIndex: 0,
        historyDraft: null,
        historyWasLive: true
      }
    };

    openImageAttach(state, source, undefined, true);

    expect(state.image ?? null).toBe(null);
    expect(state.toast).toContain("rewrite");
  });
});

describe("attach image path handling", () => {
  test("rejects a directory, a FIFO, and a device before any decode", async () => {
    if (process.platform === "win32") return;
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "claude-sonnet-5");
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    const root = await mkdtemp(join(tmpdir(), "image-attach-"));
    const fifo = join(root, "blocked.fifo");
    await execFileAsync("mkfifo", [fifo]);

    for (const badPath of [root, fifo, "/dev/null"]) {
      openImageAttach(state, source, undefined, true);
      state.image!.path = badPath;
      await imageAttachAction({ action: "apply" }, state, source, context(state));
      expect(state.image?.error ?? "").not.toBe("");
      expect(draftImagesFor(state.composer)).toHaveLength(0);
      state.image = null;
      state.mode = "COMPOSE";
    }
  });

  test("refuses a source image over the byte bound before constructing a Uint8Array", async () => {
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "claude-sonnet-5");
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    const root = await mkdtemp(join(tmpdir(), "image-attach-"));
    const oversized = join(root, "too-big.png");
    // One byte over the Source Image bound. readImportBytes rejects on the
    // stat check alone, so this never allocates the oversized buffer to
    // compare against a decoded image.
    await writeFile(oversized, Buffer.alloc(MAX_SOURCE_IMAGE_BYTES + 1));
    let staged = false;
    source.api.stageStoryImage = async () => { staged = true; return stagedImage(); };

    openImageAttach(state, source, undefined, true);
    state.image!.path = oversized;
    await imageAttachAction({ action: "apply" }, state, source, context(state));

    expect(staged).toBeFalse();
    expect(state.image?.error ?? "").not.toBe("");
    expect(draftImagesFor(state.composer)).toHaveLength(0);
  }, 20_000);

  test("attaches a valid image and shows it as a metadata row, never inserted into the draft text", async () => {
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "claude-sonnet-5");
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    const root = await mkdtemp(join(tmpdir(), "image-attach-"));
    const png = join(root, "art.png");
    await writeFile(png, minimalPng(1_200, 800));
    const staged = stagedImage(1_200, 800, 428_000);
    source.api.stageStoryImage = async (_storyId, mediaType, bytes) => {
      expect(mediaType).toBe("image/png");
      expect(bytes.byteLength).toBe(29);
      return staged;
    };

    openImageAttach(state, source, undefined, true);
    state.image!.path = png;
    await imageAttachAction({ action: "apply" }, state, source, context(state));

    expect(state.image ?? null).toBe(null);
    expect(state.mode).toBe("COMPOSE");
    expect(draftImagesFor(state.composer)).toEqual([staged]);
    expect(state.composer.text).toBe("");
    expect(state.toast).toContain("Image 1");
  });
});

describe("the four-image boundary", () => {
  test("allows exactly four attachments and refuses a fifth", async () => {
    const source = demoAppSource();
    setRoute(source, "anthropic-messages", "claude-sonnet-5");
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    const root = await mkdtemp(join(tmpdir(), "image-attach-"));
    for (let index = 0; index < 4; index += 1) {
      const png = join(root, `art-${index}.png`);
      await writeFile(png, minimalPng(10, 10));
      source.api.stageStoryImage = async () => stagedImage();
      openImageAttach(state, source, undefined, true);
      expect(state.mode).toBe("IMAGE");
      state.image!.path = png;
      await imageAttachAction({ action: "apply" }, state, source, context(state));
      expect(draftImagesFor(state.composer)).toHaveLength(index + 1);
    }

    // A fifth attempt is refused before the panel even opens.
    openImageAttach(state, source, undefined, true);
    expect(state.image ?? null).toBe(null);
    expect(state.toast).toContain("already 4 images attached");
    expect(draftImagesFor(state.composer)).toHaveLength(4);
  });
});

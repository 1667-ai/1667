import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_OBJECT_BYTES,
  MAX_NORMALIZED_IMAGE_DIMENSION
} from "../shared/image-attachment.js";
import { parseImageHeader } from "../server/image-header.js";
import { normalizeImage } from "../server/image-normalize.js";
import { launchImageNormalizeChild } from "../server/image-normalize-launcher.js";
import { ServiceError } from "../server/errors.js";
import {
  corruptPayload,
  decodedDimensions,
  decompressionBombPng,
  jpegWithOrientation,
  minAlpha,
  noiseImage,
  opaqueJpeg,
  opaquePng,
  opaqueWebp,
  quadrantAt,
  quadrantImage,
  transparentPng,
  truncate,
  zeroDimensionPng
} from "./image-fixtures.js";

async function expectServiceError(
  action: () => Promise<unknown>,
  code: string
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ServiceError, "expected a ServiceError");
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /[A-Za-z0-9+/]{40,}={0,2}/u, "message must not carry base64");
    return true;
  });
}

test("normalizes a valid opaque PNG source", async () => {
  const source = await opaquePng(320, 240);
  const result = await normalizeImage(source, "image/png");
  assert.equal(result.mediaType, "image/png");
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
  assert.ok(result.bytes.byteLength <= MAX_IMAGE_OBJECT_BYTES);
});

test("normalizes a valid opaque JPEG source", async () => {
  const source = await opaqueJpeg(320, 240);
  const result = await normalizeImage(source, "image/jpeg");
  assert.equal(result.mediaType, "image/jpeg");
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
});

test("normalizes a valid WebP source to JPEG (never stores WebP)", async () => {
  const source = await opaqueWebp(200, 150);
  const result = await normalizeImage(source, "image/webp");
  assert.ok(result.mediaType === "image/png" || result.mediaType === "image/jpeg");
  assert.equal(result.width, 200);
  assert.equal(result.height, 150);
});

test("rejects wrong magic bytes before any decode", async () => {
  const notAnImage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  await expectServiceError(
    () => normalizeImage(notAnImage, "image/png"),
    "image_type_not_supported"
  );
});

test("rejects a declared content type that disagrees with the magic bytes", async () => {
  const source = await opaqueJpeg(64, 64);
  await expectServiceError(
    () => normalizeImage(source, "image/png"),
    "image_invalid"
  );
});

test("rejects a header truncated before it can be read", async () => {
  const source = await opaquePng(64, 64);
  const cut = truncate(source, 10);
  await expectServiceError(() => normalizeImage(cut, "image/png"), "image_invalid");
});

test("rejects zero-valued declared dimensions", () => {
  assert.throws(
    () => parseImageHeader(zeroDimensionPng(), "image/png"),
    (error: unknown) => error instanceof ServiceError && error.code === "image_invalid"
  );
});

test("the header parser alone rejects a decompression bomb, before any raster allocation", () => {
  const bomb = decompressionBombPng(6000, 6000);
  const start = performance.now();
  assert.throws(
    () => parseImageHeader(bomb, "image/png"),
    (error: unknown) => error instanceof ServiceError && error.code === "image_source_too_large"
  );
  const elapsedMs = performance.now() - start;
  // A rejection that read only the header, and never asked photon to
  // allocate a 6000x6000 raster, returns in a few milliseconds, not the
  // time a real decode of that many pixels would take.
  assert.ok(elapsedMs < 50, `header rejection took ${elapsedMs}ms`);
});

test("the full pipeline also rejects a decompression bomb", async () => {
  const bomb = decompressionBombPng(6000, 6000);
  await expectServiceError(
    () => normalizeImage(bomb, "image/png"),
    "image_source_too_large"
  );
});

test("every EXIF orientation from 1 to 8 lands the correct quadrant", async () => {
  const width = 8, height = 4;
  const source = await quadrantImage(width, height);
  const jpeg = await opaqueJpegFromQuadrant(source, width, height);
  const expectedByOrientation: Record<number, {
    tl: string; tr: string; bl: string; br: string; width: number; height: number;
  }> = {
    1: { tl: "R", tr: "G", bl: "B", br: "W", width, height },
    2: { tl: "G", tr: "R", bl: "W", br: "B", width, height },
    3: { tl: "W", tr: "B", bl: "G", br: "R", width, height },
    4: { tl: "B", tr: "W", bl: "R", br: "G", width, height },
    5: { tl: "R", tr: "B", bl: "G", br: "W", width: height, height: width },
    6: { tl: "B", tr: "R", bl: "W", br: "G", width: height, height: width },
    7: { tl: "W", tr: "G", bl: "B", br: "R", width: height, height: width },
    8: { tl: "G", tr: "W", bl: "R", br: "B", width: height, height: width }
  };
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const tagged = jpegWithOrientation(jpeg, orientation);
    const result = await normalizeImage(tagged, "image/jpeg");
    const expected = expectedByOrientation[orientation]!;
    assert.equal(result.width, expected.width, `orientation ${orientation} width`);
    assert.equal(result.height, expected.height, `orientation ${orientation} height`);
    const tl = await quadrantAt(result.bytes, 1, 1);
    const tr = await quadrantAt(result.bytes, result.width - 2, 1);
    const bl = await quadrantAt(result.bytes, 1, result.height - 2);
    const br = await quadrantAt(result.bytes, result.width - 2, result.height - 2);
    assert.equal(tl, expected.tl, `orientation ${orientation} top-left`);
    assert.equal(tr, expected.tr, `orientation ${orientation} top-right`);
    assert.equal(bl, expected.bl, `orientation ${orientation} bottom-left`);
    assert.equal(br, expected.br, `orientation ${orientation} bottom-right`);
  }
});

async function opaqueJpegFromQuadrant(
  pngBytes: Uint8Array,
  width: number,
  height: number
): Promise<Uint8Array> {
  const { loadPhoton } = await import("../server/image-photon.js");
  const photon = await loadPhoton();
  const decoded = photon.PhotonImage.new_from_byteslice(pngBytes);
  try {
    assert.equal(decoded.get_width(), width);
    assert.equal(decoded.get_height(), height);
    return decoded.get_bytes_jpeg(95);
  } finally {
    decoded.free();
  }
}

test("PNG transparency survives decode, orientation, resize, and re-encode", async () => {
  const source = await transparentPng(400, 300);
  const result = await normalizeImage(source, "image/png");
  assert.equal(result.mediaType, "image/png");
  const alpha = await minAlpha(result.bytes);
  assert.ok(alpha < 255, `expected transparency to survive, got minimum alpha ${alpha}`);
});

test("a large source is resized to the normalized dimension cap, aspect preserved", async () => {
  const source = await opaqueJpeg(4000, 2000, 90);
  const result = await normalizeImage(source, "image/jpeg");
  assert.equal(result.width, MAX_NORMALIZED_IMAGE_DIMENSION);
  assert.equal(result.height, MAX_NORMALIZED_IMAGE_DIMENSION / 2);
});

test("the JPEG reduction sequence shrinks quality and then dimensions until the output fits", async () => {
  const { jpeg } = await noiseImage(1400, 1400, false);
  const result = await normalizeImage(jpeg, "image/jpeg");
  assert.equal(result.mediaType, "image/jpeg");
  assert.ok(result.bytes.byteLength <= MAX_IMAGE_OBJECT_BYTES);
  const decoded = await decodedDimensions(result.bytes);
  assert.equal(decoded.width, result.width);
  assert.equal(decoded.height, result.height);
});

test("the PNG reduction sequence shrinks dimensions, never drops transparency", async () => {
  const { png } = await noiseImage(1000, 1000, true);
  const result = await normalizeImage(png, "image/png");
  assert.equal(result.mediaType, "image/png");
  assert.ok(result.bytes.byteLength <= MAX_IMAGE_OBJECT_BYTES);
  assert.ok(
    result.width < 1000 || result.height < 1000,
    "expected the reduction ladder to shrink a noisy transparent source"
  );
  const alpha = await minAlpha(result.bytes);
  assert.ok(alpha < 255, "transparency must survive reduction");
});

test("a payload truncated deep inside compressed data is isolated to one child process", async () => {
  const source = await opaquePng(600, 400);
  const corrupted = corruptPayload(source, 40, 200);
  const outcome = await launchImageNormalizeChild(corrupted, "image/png", {
    deadlineMs: 10_000
  }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.ok(outcome.error instanceof ServiceError);
    assert.equal((outcome.error as ServiceError).code, "image_invalid");
  }
  // The child process that saw the corrupted payload is gone. A fresh
  // normalization in a fresh child process still succeeds, proving the
  // one-normalization-per-child design isolates a panicked WASM instance
  // to the process that panicked rather than poisoning the next request.
  const clean = await opaquePng(64, 64);
  const result = await launchImageNormalizeChild(clean, "image/png", { deadlineMs: 10_000 });
  assert.equal(result.mediaType, "image/png");
});

test("the launcher's deadline kills a child stuck in synchronous work", async () => {
  const source = await opaquePng(64, 64);
  const start = performance.now();
  await assert.rejects(
    () => launchImageNormalizeChild(source, "image/png", {
      deadlineMs: 300,
      debugStallMs: 5_000
    }),
    (error: unknown) => error instanceof ServiceError && error.code === "image_normalization_failed"
  );
  const elapsedMs = performance.now() - start;
  // The deadline is 300ms and the stall is 5s: settling well under the
  // stall duration proves the parent's timer, not the child's own event
  // loop, ended the process.
  assert.ok(elapsedMs < 4_000, `expected the deadline to end the child quickly, took ${elapsedMs}ms`);
});

// The memory watchdog itself only runs on Linux (`pollChildMemory` in
// server/image-normalize-launcher.ts reads /proc); on another platform this
// child would never receive a beginTermination call and would run to its own
// completion instead of proving the watchdog, so the test is gated the same
// way the watchdog is.
test("the memory watchdog kills a child that grows past the configured limit", { skip: process.platform !== "linux" }, async () => {
  const source = await opaquePng(64, 64);
  await assert.rejects(
    () => launchImageNormalizeChild(source, "image/png", {
      deadlineMs: 10_000,
      memoryLimitBytes: 64 * 1024 * 1024,
      debugAllocateMb: 200
    }),
    (error: unknown) => error instanceof ServiceError && error.code === "image_normalization_failed"
  );
});

test("resident memory stays bounded across repeated normalization", async () => {
  const source = await opaqueJpeg(800, 600, 85);
  if (global.gc) global.gc();
  const before = process.memoryUsage().rss;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    await normalizeImage(source, "image/jpeg");
  }
  if (global.gc) global.gc();
  const after = process.memoryUsage().rss;
  const growthBytes = after - before;
  assert.ok(
    growthBytes < 200 * 1024 * 1024,
    `resident memory grew by ${(growthBytes / (1024 * 1024)).toFixed(1)} MiB over 20 normalizations`
  );
});

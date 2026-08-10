import assert from "node:assert/strict";
import test from "node:test";
import { attachHttpServer } from "../tui/src/http-attach.js";
import { createApi } from "../tui/src/api.js";
import { ApiHttpError } from "../tui/src/api-error.js";
import {
  fetchWithApiProtocol
} from "./http-test-client.js";
import { testApp } from "./story-server-fixture.js";
import {
  opaqueJpeg,
  opaquePng,
  opaqueWebp
} from "./image-fixtures.js";
import { MAX_SOURCE_IMAGE_BYTES } from "../shared/image-attachment.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("stageStoryImage accepts PNG, JPEG, and WebP, and normalizes each to a stored attachment", async (t) => {
  const base = await testApp(t, "1667-image-stage-http-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Image story");

  const cases: readonly [string, Promise<Uint8Array>][] = [
    ["image/png", opaquePng(8, 8)],
    ["image/jpeg", opaqueJpeg(8, 8)],
    ["image/webp", opaqueWebp(8, 8)]
  ];
  for (const [mediaType, bytesPromise] of cases) {
    const bytes = await bytesPromise;
    const staged = await api.stageStoryImage(story.id, mediaType as "image/png", bytes);
    assert.match(staged.leaseId, /^[a-f0-9]{64}$/u);
    assert.match(staged.attachment.objectId, /^[a-f0-9]{64}$/u);
    assert.ok(staged.attachment.mediaType === "image/png" || staged.attachment.mediaType === "image/jpeg");
    assert.equal(staged.attachment.width, 8);
    assert.equal(staged.attachment.height, 8);
    assert.ok(staged.attachment.byteLength > 0);
  }
});

linuxTest("stageStoryImage returns 415 on a Content-Type mismatch", async (t) => {
  const base = await testApp(t, "1667-image-415-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("415 story");

  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/images`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: Buffer.from(await opaquePng(4, 4))
  });
  assert.equal(response.status, 415);
  const payload = await response.json() as { code?: string };
  assert.equal(payload.code, "image_type_not_supported");
});

linuxTest("stageStoryImage returns 415 for a multipart body", async (t) => {
  const base = await testApp(t, "1667-image-multipart-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Multipart story");

  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/images`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: "--x\r\n\r\n--x--"
  });
  assert.equal(response.status, 415);
});

linuxTest("stageStoryImage returns 413 over the byte cap, without ever reaching the normalizer", async (t) => {
  const base = await testApp(t, "1667-image-413-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("413 story");

  const oversized = new Uint8Array(MAX_SOURCE_IMAGE_BYTES + 1);
  const response = await fetchWithApiProtocol(`${base}/api/stories/${story.id}/images`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: oversized
  });
  assert.equal(response.status, 413);
});

linuxTest("releaseStoryImage removes a lease by id, and releasing it again succeeds", async (t) => {
  const base = await testApp(t, "1667-image-release-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Release story");

  const staged = await api.stageStoryImage(story.id, "image/png", await opaquePng(4, 4));
  await api.releaseStoryImage(story.id, staged.leaseId);
  // Idempotent: releasing an already-gone lease succeeds with no error.
  await api.releaseStoryImage(story.id, staged.leaseId);
});

linuxTest("releaseStoryImage succeeds for a lease id that was never staged", async (t) => {
  const base = await testApp(t, "1667-image-release-absent-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Absent lease story");

  await api.releaseStoryImage(story.id, "a".repeat(64));
});

linuxTest("staging a non-existent story 404s", async (t) => {
  const base = await testApp(t, "1667-image-404-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);

  // Valid, normalizable bytes: the story-existence check runs after
  // normalization, so invalid image bytes would fail with an image error
  // first and never exercise the 404 this test is about.
  const bytes = await opaquePng(4, 4);
  await assert.rejects(
    () => api.stageStoryImage("does-not-exist", "image/png", bytes),
    (error: unknown) => error instanceof ApiHttpError && error.status === 404
  );
});

linuxTest("a client disconnect while the server is mid body-read still releases the permit", async (t) => {
  const base = await testApp(t, "1667-image-disconnect-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Disconnect story");

  const controller = new AbortController();
  let firstChunkSent = false;
  const slowBody = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      if (!firstChunkSent) {
        firstChunkSent = true;
        streamController.enqueue(new Uint8Array(1_024));
        return;
      }
      // Never close: the upload stays open until this test aborts the
      // client, so the server is provably still inside its body reader,
      // holding the permit, when the abort lands.
      await new Promise(() => {});
    }
  });

  const pending = fetchWithApiProtocol(`${base}/api/stories/${story.id}/images`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: slowBody,
    duplex: "half",
    signal: controller.signal
  } as RequestInit);
  pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await assert.rejects(pending);

  // The permit must be free again: a fresh stage call succeeds without
  // waiting on a permit the aborted upload never released.
  const staged = await api.stageStoryImage(story.id, "image/png", await opaquePng(4, 4));
  assert.match(staged.leaseId, /^[a-f0-9]{64}$/u);
});

linuxTest("three concurrent stage calls are admitted and a fourth is refused with image_stage_busy", async (t) => {
  const base = await testApp(t, "1667-image-busy-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Busy story");

  // High-entropy content pushes the normalizer through several JPEG-quality
  // steps, widening the real window during which the permit stays held,
  // both a real child-process spawn and this reduction loop take
  // measurable wall-clock time, which is what gives four calls fired
  // together a realistic chance to overlap.
  const bytes = await Promise.all([0, 1, 2, 3].map(() => opaqueJpeg(64, 64, 90)));

  const results = await Promise.allSettled(
    bytes.map((source) => api.stageStoryImage(story.id, "image/jpeg", source))
  );
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(fulfilled.length, 3, `expected exactly 3 admitted, got ${fulfilled.length}`);
  assert.equal(rejected.length, 1, `expected exactly 1 refused, got ${rejected.length}`);
  const failure = rejected[0]!.reason as unknown;
  assert.ok(failure instanceof ApiHttpError, "the refusal must be a typed API error");
  assert.equal((failure as ApiHttpError).code, "image_stage_busy");
  assert.equal((failure as ApiHttpError).status, 429);
});

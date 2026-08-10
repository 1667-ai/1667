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
import { IMAGE_INPUT_ACTIVATED } from "../shared/image-input-release.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

/**
 * These tests exercise the real HTTP entry points through a spawned server
 * process, so they read the production release constant directly rather
 * than overriding it: `testApp` (test/story-server-fixture.ts) starts the
 * actual product binary, which has no test-only override for
 * `IMAGE_INPUT_ACTIVATED`.
 *
 * Every test below is written to hold on both sides of the switch. While it
 * is `false`, both image routes refuse before any other work, the fix for
 * a confirmed BLOCKING finding: this route had nothing gating it. Once
 * slice 6 flips the constant, the very same test bodies assert the
 * mechanics (normalization, content-type validation, byte caps, 404
 * mapping, permit release on disconnect, and busy-refusal under
 * concurrency) that this file always covered. No further edit is required
 * for that half to start running; only the `if (!IMAGE_INPUT_ACTIVATED)`
 * branches become dead code worth deleting then.
 *
 * The deeper staging mechanics, normalization correctness, permit queuing,
 * lease and quota bookkeeping, are also covered independently of this HTTP
 * boundary in image-normalize.test.ts, image-stage-permit.test.ts,
 * story-image-objects.test.ts, and story-image-quota.test.ts. Those keep
 * passing unaffected by the release gate this file is about.
 */

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
    if (!IMAGE_INPUT_ACTIVATED) {
      await assertEntryPointClosed(() => api.stageStoryImage(story.id, mediaType as "image/png", bytes));
      continue;
    }
    const staged = await api.stageStoryImage(story.id, mediaType as "image/png", bytes);
    assert.match(staged.leaseId, /^[a-f0-9]{64}$/u);
    assert.match(staged.attachment.objectId, /^[a-f0-9]{64}$/u);
    assert.ok(staged.attachment.mediaType === "image/png" || staged.attachment.mediaType === "image/jpeg");
    assert.equal(staged.attachment.width, 8);
    assert.equal(staged.attachment.height, 8);
    assert.ok(staged.attachment.byteLength > 0);
  }
});

linuxTest("stageStoryImage returns 415 on a Content-Type mismatch, once image input is active", async (t) => {
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
  if (!IMAGE_INPUT_ACTIVATED) {
    await assertResponseClosed(response);
    return;
  }
  assert.equal(response.status, 415);
  const payload = await response.json() as { code?: string };
  assert.equal(payload.code, "image_type_not_supported");
});

linuxTest("stageStoryImage returns 415 for a multipart body, once image input is active", async (t) => {
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
  if (!IMAGE_INPUT_ACTIVATED) {
    await assertResponseClosed(response);
    return;
  }
  assert.equal(response.status, 415);
});

linuxTest("stageStoryImage returns 413 over the byte cap, without ever reaching the normalizer, once image input is active", async (t) => {
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
  if (!IMAGE_INPUT_ACTIVATED) {
    // The release gate refuses before the body is even read, so an
    // oversized body never reaches the byte-cap check this test is
    // otherwise about.
    await assertResponseClosed(response);
    return;
  }
  assert.equal(response.status, 413);
});

linuxTest("releaseStoryImage removes a lease by id, and releasing it again succeeds, once image input is active", async (t) => {
  const base = await testApp(t, "1667-image-release-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Release story");

  if (!IMAGE_INPUT_ACTIVATED) {
    await assertEntryPointClosed(() => api.releaseStoryImage(story.id, "a".repeat(64)));
    return;
  }
  const staged = await api.stageStoryImage(story.id, "image/png", await opaquePng(4, 4));
  await api.releaseStoryImage(story.id, staged.leaseId);
  // Idempotent: releasing an already-gone lease succeeds with no error.
  await api.releaseStoryImage(story.id, staged.leaseId);
});

linuxTest("releaseStoryImage succeeds for a lease id that was never staged, once image input is active", async (t) => {
  const base = await testApp(t, "1667-image-release-absent-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Absent lease story");

  if (!IMAGE_INPUT_ACTIVATED) {
    await assertEntryPointClosed(() => api.releaseStoryImage(story.id, "a".repeat(64)));
    return;
  }
  await api.releaseStoryImage(story.id, "a".repeat(64));
});

linuxTest("staging a non-existent story 404s, once image input is active", async (t) => {
  const base = await testApp(t, "1667-image-404-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);

  // Valid, normalizable bytes: the story-existence check runs after
  // normalization, so invalid image bytes would fail with an image error
  // first and never exercise the 404 this test is about.
  const bytes = await opaquePng(4, 4);
  if (!IMAGE_INPUT_ACTIVATED) {
    // The release gate refuses before the story-existence check ever runs,
    // so a non-existent story gets the same refusal as a real one.
    await assertEntryPointClosed(() => api.stageStoryImage("does-not-exist", "image/png", bytes));
    return;
  }
  await assert.rejects(
    () => api.stageStoryImage("does-not-exist", "image/png", bytes),
    (error: unknown) => error instanceof ApiHttpError && error.status === 404
  );
});

linuxTest("a client disconnect while the server is mid body-read still releases the permit, once image input is active", async (t) => {
  const base = await testApp(t, "1667-image-disconnect-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Disconnect story");

  if (!IMAGE_INPUT_ACTIVATED) {
    // The release gate refuses before the permit is even acquired, so
    // there is nothing for a disconnect to interrupt: a plain stage call
    // is refused immediately instead of hanging.
    const bytes = await opaquePng(4, 4);
    await assertEntryPointClosed(() => api.stageStoryImage(story.id, "image/png", bytes));
    return;
  }

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

linuxTest("three concurrent stage calls are admitted and a fourth is refused with image_stage_busy, once image input is active", async (t) => {
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

  if (!IMAGE_INPUT_ACTIVATED) {
    // The release gate refuses every one of the four before the permit
    // exists at all, so nothing is admitted and none is `image_stage_busy`.
    assert.ok(results.every((result) => result.status === "rejected"));
    for (const result of results) {
      const reason = (result as PromiseRejectedResult).reason as unknown;
      assert.ok(reason instanceof ApiHttpError && reason.code === "image_input_not_supported");
    }
    return;
  }

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(fulfilled.length, 3, `expected exactly 3 admitted, got ${fulfilled.length}`);
  assert.equal(rejected.length, 1, `expected exactly 1 refused, got ${rejected.length}`);
  const failure = rejected[0]!.reason as unknown;
  assert.ok(failure instanceof ApiHttpError, "the refusal must be a typed API error");
  assert.equal((failure as ApiHttpError).code, "image_stage_busy");
  assert.equal((failure as ApiHttpError).status, 429);
});

/** Pin the BLOCKING finding directly: both image routes refuse before doing
 *  any other work while `IMAGE_INPUT_ACTIVATED` is false. This test does not
 *  branch on the constant, it exists specifically to fail loudly if the
 *  release ships with the gate silently missing again. */
linuxTest("the stage and release routes both refuse while image input's entry points are closed", { skip: IMAGE_INPUT_ACTIVATED }, async (t) => {
  const base = await testApp(t, "1667-image-closed-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const story = await api.createStory("Closed-gate story");
  const bytes = await opaquePng(4, 4);

  await assertEntryPointClosed(() => api.stageStoryImage(story.id, "image/png", bytes));
  await assertEntryPointClosed(() => api.releaseStoryImage(story.id, "a".repeat(64)));
});

async function assertEntryPointClosed(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    run,
    (error: unknown) => error instanceof ApiHttpError && error.code === "image_input_not_supported"
  );
}

async function assertResponseClosed(response: Response): Promise<void> {
  assert.equal(response.status, 400);
  const payload = await response.json() as { code?: string };
  assert.equal(payload.code, "image_input_not_supported");
}

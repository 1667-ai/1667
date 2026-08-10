import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireImageStagePermit,
  imageStagePermitWaiterCountForTest,
  isImageStagePermitActiveForTest
} from "../server/image-stage-permit.js";

test("image stage permit: one active, two waiters, a fourth caller is refused before it is granted", async () => {
  assert.equal(isImageStagePermitActiveForTest(), false);
  const releaseFirst = await acquireImageStagePermit();
  assert.equal(isImageStagePermitActiveForTest(), true);

  let secondGranted = false;
  let thirdGranted = false;
  const second = acquireImageStagePermit().then((release) => {
    secondGranted = true;
    return release;
  });
  const third = acquireImageStagePermit().then((release) => {
    thirdGranted = true;
    return release;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(secondGranted, false, "the second waiter is not granted while the first holds the permit");
  assert.equal(thirdGranted, false, "the third waiter is not granted either");
  assert.equal(imageStagePermitWaiterCountForTest(), 2);

  await assert.rejects(
    acquireImageStagePermit(),
    /image_stage_busy|Another image is already staging/
  );
  try {
    await acquireImageStagePermit();
    assert.fail("a fourth caller must be refused");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "image_stage_busy");
  }

  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondGranted, true);
  assert.equal(imageStagePermitWaiterCountForTest(), 1);

  releaseSecond();
  const releaseThird = await third;
  assert.equal(thirdGranted, true);
  assert.equal(imageStagePermitWaiterCountForTest(), 0);

  releaseThird();
  assert.equal(isImageStagePermitActiveForTest(), false);
});

test("image stage permit: a waiter removed by its own AbortSignal frees its slot for the next caller", async () => {
  const releaseFirst = await acquireImageStagePermit();

  const controller = new AbortController();
  const waiting = acquireImageStagePermit(controller.signal);
  await Promise.resolve();
  assert.equal(imageStagePermitWaiterCountForTest(), 1);

  controller.abort();
  await assert.rejects(waiting, /AbortError|aborted/);
  assert.equal(imageStagePermitWaiterCountForTest(), 0);

  // The freed slot is usable: a fresh waiter can still queue behind the
  // still-held permit.
  const secondController = new AbortController();
  const stillWaiting = acquireImageStagePermit(secondController.signal);
  await Promise.resolve();
  assert.equal(imageStagePermitWaiterCountForTest(), 1);
  releaseFirst();
  const releaseSecond = await stillWaiting;
  releaseSecond();
});

test("image stage permit: acquiring with an already-aborted signal is refused without occupying a slot", async () => {
  const releaseFirst = await acquireImageStagePermit();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(acquireImageStagePermit(controller.signal), /AbortError|aborted/);
  assert.equal(imageStagePermitWaiterCountForTest(), 0);
  releaseFirst();
});

test("image stage permit: release on every terminal path lets the next stage proceed", async () => {
  const release = await acquireImageStagePermit();
  assert.equal(isImageStagePermitActiveForTest(), true);
  release();
  // A second release call is a no-op, matching a defensive `finally` that
  // might run release twice on an unusual control-flow path.
  const releaseAgain = await acquireImageStagePermit();
  assert.equal(isImageStagePermitActiveForTest(), true);
  releaseAgain();
  assert.equal(isImageStagePermitActiveForTest(), false);
});

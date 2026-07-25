import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import { RequestDrain } from "../server/request-drain.js";

test("request drain rejects work admitted after shutdown and observes accepted work", async () => {
  const requests = new RequestDrain();
  let finish!: () => void;
  const accepted = requests.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  await Promise.resolve();

  requests.beginShutdown();
  let lateRan = false;
  await assert.rejects(
    requests.run(async () => { lateRan = true; }),
    (error: unknown) => error instanceof ServiceError && error.status === 503
  );
  assert.equal(lateRan, false);

  let drained = false;
  const waiting = requests.waitForIdle().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finish();
  await Promise.all([accepted, waiting]);
  assert.equal(drained, true);
});

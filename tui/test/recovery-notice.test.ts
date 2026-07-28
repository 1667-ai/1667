import { expect, test } from "bun:test";
import { recoveryNotice } from "../src/app.js";
import { WorkerApiError, type WorkerRecoveryWarning } from "../src/worker-api.js";
import { RecoveryWarningFeed } from "../src/recovery-warning-feed.js";
import {
  createFailureEnvelope,
  type FailureCode
} from "../../shared/failure-envelope.js";

test("recovery notice describes a stopped model request in product terms", () => {
  const warning: WorkerRecoveryWarning = {
    mutationId: "m1-example",
    method: "continueStory",
    storyId: "story",
    resolution: "archived",
    error: workerError(
      "The model request may have been billed; retry only with a new mutation ID.",
      "generation_outcome_unknown",
      409
    )
  };

  expect(recoveryNotice([warning])).toBe("last model request stopped");
});

test("recovery feed replays early warnings and deduplicates live metadata", () => {
  const feed = new RecoveryWarningFeed();
  const warning: WorkerRecoveryWarning = {
    mutationId: "m1-feed",
    method: "autonameStory",
    storyId: "story",
    resolution: "archived",
    error: workerError(
      "Provider outcome unknown.",
      "generation_outcome_unknown",
      409
    )
  };
  const batches: Array<readonly WorkerRecoveryWarning[]> = [];
  feed.publish([warning]);
  const unsubscribe = feed.subscribe((warnings) => { batches.push(warnings); }, () => {});
  feed.publish([warning]);
  feed.publish([{ ...warning, mutationId: "m1-live" }]);
  unsubscribe();

  expect(batches.map((batch) => batch.map(({ mutationId }) => mutationId))).toEqual([
    ["m1-feed"], ["m1-live"]
  ]);
});

test("recovery feed blocks repeated warnings until adoption succeeds", async () => {
  const feed = new RecoveryWarningFeed();
  const warning: WorkerRecoveryWarning = {
    mutationId: "m1-pending-feed",
    method: "renameStory",
    storyId: "story",
    resolution: "archived",
    error: workerError("Reload state.", "mutation_outcome_unknown", 409)
  };
  let attempts = 0;
  expect(feed.publish([warning])).toBeTrue();
  const unsubscribe = feed.subscribe(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient reload failure");
  }, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(feed.publish([warning])).toBeTrue();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(attempts).toBe(2);
  expect(feed.publish([warning])).toBeFalse();
  unsubscribe();
});

test("recovery feed admits only a mutation that resolves recovery", async () => {
  const feed = new RecoveryWarningFeed();
  const warning: WorkerRecoveryWarning = {
    mutationId: "m1-empty-store",
    method: "deleteStory",
    storyId: "story",
    resolution: "archived",
    error: workerError("Reload state.", "mutation_outcome_unknown", 409)
  };
  expect(feed.publish([warning])).toBeTrue();
  await feed.runRecoveryMutation(async () => {
    expect(feed.publish([warning])).toBeFalse();
  });
  expect(feed.publish([warning])).toBeTrue();
});

function workerError(
  message: string,
  code: FailureCode,
  status: number
): WorkerApiError {
  return new WorkerApiError(createFailureEnvelope({
    code,
    message,
    status
  }));
}

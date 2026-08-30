import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  MUTATION_INPUT_PROTOCOL_VERSION,
  PRE_ASIDE_REPROMPT_WORKER_PROTOCOL_VERSION,
  PRE_ASIDE_WORKER_PROTOCOL_VERSION,
  PRE_FACT_STATES_WORKER_PROTOCOL_VERSION,
  PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION
} from "../shared/worker-protocol.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { StoryService } from "../server/story-service.js";
import { mutationFingerprint } from "../server/mutation-receipts.js";
import {
  executeWorkerMutation,
  parseWorkerMutation
} from "../server/worker-mutations.js";
import { runHttpOperationMutation } from "../server/http-operation-mutation.js";
import { storyIdForMutation } from "../server/story-identity.js";

test("HTTP retries receipts retained across worker protocol bumps", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-protocol-replay-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({
    dataDir,
    asideActivation: true
  });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const signal = new AbortController().signal;
  for (const [legacyProtocol, title] of [
    [PRE_ASIDE_WORKER_PROTOCOL_VERSION, "Retained before Aside"],
    [PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION, "Retained before Settings schema 5"],
    [PRE_ASIDE_REPROMPT_WORKER_PROTOCOL_VERSION, "Retained before Reprompt"],
    [PRE_FACT_STATES_WORKER_PROTOCOL_VERSION, "Retained before Fact States"]
  ] as const) {
    const mutationId = createDurableMutationId();
    const input = { title };
    const parsed = parseWorkerMutation("createStory", input, legacyProtocol);
    await service.runMutation(
      mutationId,
      "createStory",
      input,
      async (plan) => {
        const storyId = storyIdForMutation(mutationId);
        return await executeWorkerMutation(
          service,
          parsed,
          plan,
          {
            onDelta: () => {},
            onReasoning: () => {},
            signal,
            storyMutationRequest: {
              transportOperationId: "retained-http-request",
              mutationId,
              fingerprint: mutationFingerprint("createStory", input, legacyProtocol),
              scope: `story:${storyId}`,
              expectedAggregateVersion: { kind: "absent" }
            }
          }
        );
      },
      legacyProtocol,
      () => undefined
    );

    const retained = await service.inspectMutationReceipt(mutationId, "createStory");
    assert.equal(
      retained !== null && "protocolVersion" in retained
        ? retained.protocolVersion
        : null,
      legacyProtocol
    );

    const replayed = await runHttpOperationMutation(
      service,
      mutationId,
      "createStory",
      input,
      signal,
      "current-http-retry",
      { kind: "absent" }
    );
    assert.equal(replayed.id, storyIdForMutation(mutationId));
  }
  assert.equal((await service.listStories()).length, 4);

  const freshMutationId = createDurableMutationId();
  const fresh = await runHttpOperationMutation(
    service,
    freshMutationId,
    "createStory",
    { title: "Created on protocol 11" },
    signal,
    "current-http-fresh",
    { kind: "absent" }
  );
  const freshReceipt = await service.inspectMutationReceipt(freshMutationId, "createStory");
  assert.equal(
    freshReceipt !== null && "protocolVersion" in freshReceipt
      ? freshReceipt.protocolVersion
      : null,
    MUTATION_INPUT_PROTOCOL_VERSION
  );

  const asideMutationId = createDurableMutationId();
  const asideVersion = (await service.stories.loadVersioned(fresh.id)).aggregateVersion!;
  await runHttpOperationMutation(
    service,
    asideMutationId,
    "askAside",
    { storyId: fresh.id, question: "What matters here?" },
    signal,
    "current-http-aside",
    asideVersion
  );
  const asideReceipt = await service.inspectMutationReceipt(asideMutationId, "askAside");
  assert.equal(
    asideReceipt !== null && "protocolVersion" in asideReceipt
      ? asideReceipt.protocolVersion
      : null,
    MUTATION_INPUT_PROTOCOL_VERSION
  );
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decodeChildToSupervisorMessage,
  decodeSupervisorToChildMessage,
  isCredentialEnvironmentName,
  sameSupervisedOperationDescriptor,
  supervisedOperationKey
} from "../shared/supervised-serve-protocol.js";
import {
  decodeSupervisedSecrets,
  encodeSupervisedSecrets,
  SUPERVISED_SECRET_CHANNEL_MAX_BYTES
} from "../shared/supervised-secret-channel.js";
import {
  parseServeArguments,
  sanitizedSupervisorChildEnvironment
} from "../tui/src/serve-supervisor.js";
import { recoverDescriptors } from "../server/supervised-serve-child.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("serve supervisor import closure excludes application and provider modules", async () => {
  const source = await readFile(
    path.join(ROOT, "tui", "src", "serve-supervisor.ts"),
    "utf8"
  );
  for (const forbidden of [
    "http-listener",
    "story-service",
    "settings",
    "providers",
    "storage",
    "data-directory"
  ]) {
    assert.doesNotMatch(source, new RegExp(`from [\"'][^\"']*${forbidden}`));
  }
});

test("supervised child environment excludes secrets and runtime loaders", () => {
  const environment = sanitizedSupervisorChildEnvironment({
    PATH: "/bin",
    HOME: "/home/reader",
    OPENAI_API_KEY: "secret",
    BUN_OPTIONS: "--preload hostile.ts",
    NODE_OPTIONS: "--require hostile.js",
    AI_1667_URL: "http://127.0.0.1:1"
  });
  assert.deepEqual(environment, {
    PATH: "/bin",
    HOME: "/home/reader"
  });
});

test("serve parser rejects empty separated and inline values", () => {
  for (const argv of [
    ["serve", "--data", ""],
    ["serve", "--data="],
    ["serve", "--port", ""],
    ["serve", "--port="]
  ]) {
    assert.throws(() => parseServeArguments(argv), /requires a value/);
  }
});

test("supervised credential slots and operation keys are closed", () => {
  assert.equal(isCredentialEnvironmentName("OPENAI_API_KEY"), true);
  assert.equal(isCredentialEnvironmentName("lowercase"), true);
  assert.equal(isCredentialEnvironmentName("AI_1667_URL"), true);
  for (const name of [
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "HOME",
    "A".repeat(65)
  ]) {
    assert.equal(isCredentialEnvironmentName(name), false);
  }
  assert.equal(supervisedOperationKey({
    sessionId: "11".repeat(16),
    sequence: "42"
  }), `${"11".repeat(16)}:42`);
  assert.equal(sameSupervisedOperationDescriptor(
    {
      listenerInstanceId: "11".repeat(16),
      sessionId: "22".repeat(16),
      sequence: "1",
      scope: "story",
      operation: "listStories",
      mutationId: null,
      lifetime: "local",
      deadlineDelayMs: 30_000
    },
    {
      listenerInstanceId: "11".repeat(16),
      sessionId: "22".repeat(16),
      sequence: "1",
      scope: "story",
      operation: "listStories",
      mutationId: null,
      lifetime: "local",
      deadlineDelayMs: 30_000
    }
  ), true);
});

test("supervised lifecycle IPC rejects malformed and unbounded authority", () => {
  const descriptor = {
    listenerInstanceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22".repeat(16),
    sequence: "1",
    scope: "story",
    operation: "listStories",
    mutationId: null,
    lifetime: "local",
    deadlineDelayMs: 30_000
  } as const;
  assert.deepEqual(decodeChildToSupervisorMessage({
    type: "reserve",
    requestId: `${descriptor.sessionId}:1`,
    descriptor
  }), {
    type: "reserve",
    requestId: `${descriptor.sessionId}:1`,
    descriptor
  });
  assert.deepEqual(decodeSupervisorToChildMessage({
    type: "recover",
    descriptors: [descriptor]
  }), {
    type: "recover",
    descriptors: [descriptor]
  });
  assert.deepEqual(decodeChildToSupervisorMessage({
    type: "hard-deadline",
    sessionId: descriptor.sessionId,
    sequence: descriptor.sequence
  }), {
    type: "hard-deadline",
    sessionId: descriptor.sessionId,
    sequence: descriptor.sequence
  });
  assert.throws(
    () => decodeChildToSupervisorMessage({
      type: "terminal",
      descriptor: { ...descriptor, extra: true }
    }),
    /message fields are invalid/
  );
  assert.throws(
    () => decodeChildToSupervisorMessage({
      type: "terminal",
      descriptor: { ...descriptor, operation: "createStory" }
    }),
    /mutation identity/
  );
  assert.throws(
    () => decodeSupervisorToChildMessage({
      type: "recover",
      descriptors: [{ ...descriptor, deadlineDelayMs: 30_001 }]
    }),
    /deadline is invalid/
  );
});

test("supervised recovery reopens admission for replayable local receipts", async () => {
  const mutationId = "m1.1753356800000.22222222222222222222222222222222";
  const base = {
    listenerInstanceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22".repeat(16),
    sequence: "1",
    scope: "story",
    mutationId,
    lifetime: "local",
    deadlineDelayMs: 30_000
  } as const;
  const service = {
    inspectMutationReceipt: async () => ({
      state: "pending" as const,
      method: "renameStory" as const,
      fingerprint: "f".repeat(64)
    })
  };

  assert.deepEqual(await recoverDescriptors(
    service as never,
    [{ ...base, operation: "renameStory" }]
  ), [{
    sessionId: base.sessionId,
    sequence: base.sequence,
    state: "not-committed"
  }]);
  assert.deepEqual(await recoverDescriptors(
    service as never,
    [{ ...base, operation: "continueStory", lifetime: "generation" }]
  ), [{
    sessionId: base.sessionId,
    sequence: base.sequence,
    state: "generation-outcome-unknown"
  }]);
});

test("supervised secrets use one bounded canonical frame", () => {
  const bytes = encodeSupervisedSecrets({
    ANTHROPIC_API_KEY: "one",
    OPENAI_API_KEY: null
  });
  assert.deepEqual(decodeSupervisedSecrets(bytes), {
    ANTHROPIC_API_KEY: "one",
    OPENAI_API_KEY: null
  });
  const maximum = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      `KEY_${String(index).padStart(2, "0")}`,
      null
    ])
  );
  assert.deepEqual(decodeSupervisedSecrets(encodeSupervisedSecrets(maximum)), maximum);
  assert.throws(
    () => encodeSupervisedSecrets({ ...maximum, KEY_64: null }),
    /invalid credential slots/
  );
  assert.throws(
    () => encodeSupervisedSecrets({ Z_KEY: "last", A_KEY: "first" }),
    /invalid credential slots/
  );
  assert.throws(
    () => decodeSupervisedSecrets(Buffer.alloc(
      SUPERVISED_SECRET_CHANNEL_MAX_BYTES + 1
    )),
    /invalid size/
  );
  assert.throws(
    () => decodeSupervisedSecrets(Buffer.from('{"OPENAI_API_KEY":"x"}\\nextra')),
    /canonical frame/
  );
});

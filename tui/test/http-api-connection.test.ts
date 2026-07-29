import { expect, test } from "bun:test";
import {
  HttpListenerAuthority,
  type HttpListenerBinding,
  type OperationFetch
} from "../../shared/http-listener-authority.js";
import { HttpApiConnection } from "../src/http-api-connection.js";
import {
  testHttpMetadata
} from "./http-api-fixture.js";

const ORIGIN = "http://127.0.0.1:7373";
const OLD_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const NEW_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";

test("late preflight retries the current listener before publication", async () => {
  let resolveOldPreflight: ((response: Response) => void) | undefined;
  const oldPreflight = new Promise<Response>((resolve) => {
    resolveOldPreflight = resolve;
  });
  const oldBinding = binding(
    OLD_INSTANCE_ID,
    async () => await oldPreflight
  );
  const newBinding = binding(
    NEW_INSTANCE_ID,
    async () => Response.json(testHttpMetadata(NEW_INSTANCE_ID))
  );
  const authority = new HttpListenerAuthority({
    root: ORIGIN,
    binding: oldBinding,
    confirmReplacement: async () => ({
      kind: "rebound",
      binding: newBinding
    })
  });
  const published: string[] = [];
  const connection = new HttpApiConnection({
    root: ORIGIN,
    authority,
    onMetadata: (metadata) => {
      published.push(metadata.serverInstanceId);
    }
  });

  const request = connection.run(
    async (current) => current.authRecord.instanceId,
    true
  );
  await authority.confirmListenerReplacement(OLD_INSTANCE_ID);
  resolveOldPreflight!(Response.json(testHttpMetadata(OLD_INSTANCE_ID)));

  expect(await request).toBe(NEW_INSTANCE_ID);
  expect(published).toEqual([NEW_INSTANCE_ID]);
});

test("replacement confirmation follows caller cancellation", async () => {
  let confirmStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    confirmStarted = resolve;
  });
  let confirmationSignal: AbortSignal | undefined;
  const authority = new HttpListenerAuthority({
    root: ORIGIN,
    binding: binding(
      OLD_INSTANCE_ID,
      async () => {
        throw new TypeError("listener disappeared");
      }
    ),
    confirmReplacement: async (_instanceId, signal) => {
      confirmationSignal = signal;
      confirmStarted();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return { kind: "unchanged" };
    }
  });
  const connection = new HttpApiConnection({ root: ORIGIN, authority });
  const controller = new AbortController();
  const reason = new Error("caller canceled replacement confirmation");

  const request = connection.run(
    async () => "unreachable",
    true,
    controller.signal
  );
  await started;
  controller.abort(reason);

  expect(await rejection(request)).toBe(reason);
  expect(confirmationSignal?.aborted).toBeTrue();
});

test("queued replacement confirmation follows caller cancellation", async () => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let confirmations = 0;
  const authority = new HttpListenerAuthority({
    root: ORIGIN,
    binding: binding(
      OLD_INSTANCE_ID,
      async () => Response.json(testHttpMetadata(OLD_INSTANCE_ID))
    ),
    confirmReplacement: async () => {
      confirmations += 1;
      firstStarted();
      await firstReleased;
      return { kind: "unchanged" };
    }
  });
  const first = authority.confirmListenerReplacement(OLD_INSTANCE_ID);
  await started;
  const controller = new AbortController();
  const reason = new Error("caller canceled queued confirmation");
  const queued = authority.confirmListenerReplacement(
    OLD_INSTANCE_ID,
    false,
    controller.signal
  );

  controller.abort(reason);
  expect(await rejection(queued)).toBe(reason);
  expect(confirmations).toBe(1);
  releaseFirst();
  await first;
});

function binding(
  instanceId: string,
  fetch: OperationFetch
): HttpListenerBinding {
  return {
    authRecord: {
      schema: 1,
      origin: ORIGIN,
      instanceId,
      capabilities: {
        story: "11".repeat(32),
        admin: "22".repeat(32)
      }
    },
    fetch
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

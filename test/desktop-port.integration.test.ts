import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopTransport } from "../client/desktop-transport.js";
import { DesktopPortBridge, type DesktopMainPort } from "../host/desktop-port-bridge.js";
import { createWorkerHost } from "../host/worker-host.js";
import { storyApiFromWorkerTransport } from "../client/worker-story-api.js";
import type { DesktopRendererPort } from "../client/desktop-transport.js";
import {
  MutationOutbox
} from "../server/mutation-outbox.js";
import type { DesktopMainMessage, DesktopRendererMessage } from "../shared/desktop-shell.js";

function connectDesktopPort(host: Awaited<ReturnType<typeof createWorkerHost>>): {
  readonly bridge: DesktopPortBridge;
  readonly transport: DesktopTransport;
} {
  const channel = new MessageChannel();
  const bridge = new DesktopPortBridge(
    host,
    channel.port1 as unknown as DesktopMainPort
  );
  const transport = new DesktopTransport(
    channel.port2 as unknown as DesktopRendererPort
  );
  return { bridge, transport };
}

test("a Renderer port can reload while the shared Node Host keeps its worker and lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-port-"));
  const machineDir = path.join(root, "machine");
  await mkdir(machineDir);
  const host = await createWorkerHost({
    dataDir: path.join(root, "data"),
    machineDir,
    cancelGraceMs: 500
  });
  let first: ReturnType<typeof connectDesktopPort> | undefined;
  let second: ReturnType<typeof connectDesktopPort> | undefined;
  try {
    first = connectDesktopPort(host);
    const firstApi = storyApiFromWorkerTransport(first.transport);
    const story = await firstApi.createStory("desktop reload");
    const seeded = await firstApi.createNode(story.id, {
      parentId: null,
      text: "seed"
    });
    const parentId = seeded.path.at(-1)?.id;
    assert.ok(parentId);

    const arrived: string[] = [];
    let reloadStarted = false;
    const running = firstApi.continueStory(
      story.id,
      "continue",
      "desktop-reload",
      { parentId },
      (text) => {
        arrived.push(text);
        if (!reloadStarted) {
          reloadStarted = true;
          setTimeout(() => {
            first?.transport.close(new Error("Renderer reloaded"));
            first?.bridge.close();
          }, 10);
        }
      },
      new AbortController().signal
    );
    const settled = assert.rejects(running, /Renderer reloaded/);
    const deadline = Date.now() + 5_000;
    while (arrived.length === 0) {
      if (Date.now() >= deadline) throw new Error("stream did not reach the Renderer");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    // Closing the port while the call is in flight rejects the old Renderer
    // call. The Host receives the port close and settles the same stream.
    await settled;
    assert.ok(arrived.join("").length > 0);

    second = connectDesktopPort(host);
    const secondApi = storyApiFromWorkerTransport(second.transport);
    const loadedAfterReload = await secondApi.loadStory(story.id);
    assert.equal(loadedAfterReload.id, story.id);
    await waitForAsync(async () =>
      (await new MutationOutbox(path.join(root, "data", "mutation-outbox")).list()).length
        === 0
    );
    const renamed = await secondApi.renameStory(story.id, "after reload");
    assert.equal(renamed.title, "after reload");
  } finally {
    first?.transport.close();
    first?.bridge.close();
    second?.transport.close();
    second?.bridge.close();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stalled Renderer reaches the bounded delta credit window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-credit-"));
  const machineDir = path.join(root, "machine");
  await mkdir(machineDir);
  const host = await createWorkerHost({
    dataDir: path.join(root, "data"),
    machineDir,
    cancelGraceMs: 500
  });
  let active: ReturnType<typeof connectDesktopPort> | undefined;
  let stalledBridge: DesktopPortBridge | undefined;
  let stalledPort: MessagePort | undefined;
  try {
    active = connectDesktopPort(host);
    const api = storyApiFromWorkerTransport(active.transport);
    const story = await api.createStory("desktop credit");
    const channel = new MessageChannel();
    stalledBridge = new DesktopPortBridge(
      host,
      channel.port1 as unknown as DesktopMainPort
    );
    stalledPort = channel.port2;
    const messages: DesktopMainMessage[] = [];
    stalledPort.on("message", (message: DesktopMainMessage) => messages.push(message));
    stalledPort.start();
    const expected = story.aggregateVersion;
    assert.ok(expected);
    const request: DesktopRendererMessage = {
      type: "request",
      callId: "stalled-stream",
      method: "continueStory",
      input: {
        storyId: story.id,
        instruction: "credit bound",
        genId: "desktop-credit",
        target: { parentId: null }
      },
      expectedAggregateVersion: expected
    };
    stalledPort.postMessage(request);
    await waitFor(() =>
      messages.filter((message) => message.type === "delta").length
        >= 8
    );
    const deltaCount = messages.filter((message) => message.type === "delta").length;
    assert.equal(deltaCount, 8);
    assert.ok(
      messages
        .filter((message): message is Extract<DesktopMainMessage, { type: "delta" }> =>
          message.type === "delta")
        .map((message) => message.text)
        .join("").length > 0,
      "the stalled Renderer keeps the text that reached its port"
    );
    await waitFor(() => messages.some((message) =>
      message.type === "complete" || message.type === "error"
    ));
    assert.equal(
      messages.filter((message) => message.type === "delta").length,
      deltaCount,
      "main must stop publishing after the credit bound"
    );
  } finally {
    active?.transport.close();
    active?.bridge.close();
    stalledBridge?.close();
    stalledPort?.close();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("archived recovery dismissal removes the durable warning through the port", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-archive-"));
  const dataDir = path.join(root, "data");
  const machineDir = path.join(root, "machine");
  const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
  const mutationId = "m1.1767225600000.7123456789abcdef0123456789abcdef";
  await outbox.init();
  await outbox.enqueue(
    mutationId,
    "autonameStory",
    { id: "archived-story" },
    { kind: "v6", revision: "00000000000000000001" }
  );
  await outbox.archive(mutationId, {
    kind: "plain",
    code: "generation_outcome_unknown",
    message: "Unknown provider outcome",
    status: 409
  }, "m1.1767225600001.8123456789abcdef0123456789abcdef");
  let host = await createWorkerHost({
    dataDir,
    machineDir,
    outbox
  });
  let connected: ReturnType<typeof connectDesktopPort> | undefined;
  try {
    await host.recovery;
    const warnings: unknown[] = [];
    const channel = new MessageChannel();
    const bridge = new DesktopPortBridge(host, channel.port1 as unknown as DesktopMainPort);
    const transport = new DesktopTransport(
      channel.port2 as unknown as DesktopRendererPort,
      { onRecoveryWarnings: (value) => warnings.push(value) }
    );
    connected = { bridge, transport };
    await waitFor(() => warnings.length > 0);
    assert.equal((await outbox.listArchived()).length, 1);
    await transport.dismissArchivedMutation(mutationId);
    assert.deepEqual(await outbox.listArchived(), []);
    connected.transport.close();
    connected.bridge.close();
    connected = undefined;
    await host.dispose();
    const restartedOutbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await restartedOutbox.init();
    host = await createWorkerHost({
      dataDir,
      machineDir,
      outbox: restartedOutbox
    });
    await host.recovery;
    assert.deepEqual(await restartedOutbox.listArchived(), []);
    assert.deepEqual(host.recoveryWarnings, []);
  } finally {
    connected?.transport.close();
    connected?.bridge.close();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

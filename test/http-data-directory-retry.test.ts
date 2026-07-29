import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AI_1667_BUILD_IDENTITY } from "../shared/build-identity.js";
import { HttpOperationClient } from "../shared/http-operation-client.js";
import {
  HttpListenerAuthority,
  type HttpListenerBinding,
  type OperationFetch
} from "../shared/http-listener-authority.js";
import { readHttpAuthRecord } from "../server/http-auth-record.js";
import {
  startHttpListener,
  type HttpListener
} from "../server/http-listener.js";
import { StoryService } from "../server/story-service.js";
import { createApi } from "../tui/src/api.js";
import { attachHttpServer } from "../tui/src/http-attach.js";
import {
  closeServer,
  listen,
  startProvenReplacementServer
} from "./http-listener-replacement-fixture.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("TUI create retry follows one project across ports without crossing projects", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const firstDataDir = path.join(await temporaryDirectory(t), "first-data");
  const initial = await startHttpListener({
    port: 0,
    dataDir: firstDataDir,
    authStore: { stateRoot }
  });
  t.after(() => initial.close());
  const initialPort = Number(new URL(initial.origin).port);
  const initialAttach = await attachHttpServer(initial.origin, {
    stateRoot
  });
  t.after(() => initialAttach.dispose());
  let droppedResponses = 0;
  const losingAuthority = decorateListenerAuthority(
    initialAttach.authority,
    (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/api/stories"
        && init?.method === "POST") {
        droppedResponses += 1;
        await response.arrayBuffer();
        throw new Error("simulated create response loss");
      }
      return response;
    }
  );
  const losingApi = createApi(initialAttach.origin, undefined, {
    authority: losingAuthority,
    mutationIntents: initialAttach.mutationIntents
  });
  await assert.rejects(
    losingApi.createStory("Retained HTTP story"),
    /simulated create response loss/
  );
  assert.ok(droppedResponses > 0);
  initialAttach.dispose();
  await initial.close();

  const otherDataDir = path.join(await temporaryDirectory(t), "other-data");
  const independent = await startHttpListener({
    port: initialPort,
    dataDir: otherDataDir,
    authStore: { stateRoot }
  });
  t.after(() => independent.close());
  const independentAttach = await attachHttpServer(independent.origin, {
    stateRoot
  });
  t.after(() => independentAttach.dispose());
  const independentStory = await createApi(
    independentAttach.origin,
    undefined,
    independentAttach
  ).createStory("Retained HTTP story");
  independentAttach.dispose();
  await independent.close();

  const blocker = createServer();
  t.after(() => closeServer(blocker));
  await listen(blocker, initialPort);
  const replacement = await startHttpListener({
    port: 0,
    dataDir: firstDataDir,
    authStore: { stateRoot }
  });
  t.after(() => replacement.close());
  assert.notEqual(Number(new URL(replacement.origin).port), initialPort);
  await closeServer(blocker);
  const replacementAttach = await attachHttpServer(replacement.origin, {
    stateRoot
  });
  t.after(() => replacementAttach.dispose());
  const replacementApi = createApi(
    replacementAttach.origin,
    undefined,
    replacementAttach
  );
  const recovered = await replacementApi.createStory(
    "Retained HTTP story"
  );
  const stories = await replacementApi.listStories();

  assert.equal(stories.length, 1);
  assert.equal(stories[0]?.id, recovered.id);
  assert.notEqual(recovered.id, independentStory.id);
});

linuxTest("TUI create retry rebinds to a same-project listener at one origin", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const initial = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot }
  });
  t.after(() => initial.close());
  const port = Number(new URL(initial.origin).port);
  const attach = await attachHttpServer(initial.origin, { stateRoot });
  t.after(() => attach.dispose());
  let replacement: HttpListener | undefined;
  t.after(async () => await replacement?.close());
  let responseLost = false;
  const reboundAuthority = decorateListenerAuthority(
    attach.authority,
    (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (!responseLost
        && new URL(String(input)).pathname === "/api/stories"
        && init?.method === "POST") {
        responseLost = true;
        await response.arrayBuffer();
        await initial.close();
        replacement = await startHttpListener({
          port,
          dataDir,
          authStore: { stateRoot }
        });
        throw new Error("simulated response loss before listener rebind");
      }
      return response;
    }
  );
  const api = createApi(attach.origin, undefined, {
    authority: reboundAuthority,
    mutationIntents: attach.mutationIntents
  });

  const created = await api.createStory("Rebound HTTP story");
  assert.equal(responseLost, true);
  assert.notEqual(
    attach.authRecord.instanceId,
    initial.authRecord.instanceId
  );
  assert.equal(
    attach.authRecord.instanceId,
    replacement?.authRecord.instanceId
  );
  assert.deepEqual(
    (await api.listStories()).map((story) => story.id),
    [created.id]
  );
});

linuxTest("TUI attach rejects a copied project as a listener replacement", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const projectRoot = await temporaryDirectory(t);
  const dataDir = path.join(projectRoot, "data");
  const copiedDataDir = path.join(projectRoot, "copied-data");
  const initial = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot }
  });
  t.after(() => initial.close());
  const attach = await attachHttpServer(initial.origin, { stateRoot });
  t.after(() => attach.dispose());
  const oldInstanceId = initial.authRecord.instanceId;
  const port = Number(new URL(initial.origin).port);
  await initial.close();
  await cp(dataDir, copiedDataDir, { recursive: true });
  const copied = await startHttpListener({
    port,
    dataDir: copiedDataDir,
    authStore: { stateRoot }
  });
  t.after(() => copied.close());

  assert.equal(
    (await attach.confirmListenerReplacement(oldInstanceId)).kind,
    "replaced"
  );
  assert.equal(attach.authRecord.instanceId, oldInstanceId);
});

linuxTest("TUI attach waits for replacement health before it classifies the project", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const initial = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot }
  });
  t.after(() => initial.close());
  const attach = await attachHttpServer(initial.origin, { stateRoot });
  t.after(() => attach.dispose());
  const oldInstanceId = initial.authRecord.instanceId;
  const port = Number(new URL(initial.origin).port);
  await initial.close();
  let releaseFactory!: () => void;
  const factoryReleased = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  let replacement: HttpListener | undefined;
  const starting = startHttpListener({
    port,
    authStore: { stateRoot },
    project: { root: dataDir, dataDir },
    serviceFactory: async (errorReporter, machineDir) => {
      await factoryReleased;
      return new StoryService({
        dataDir,
        machineDir,
        errorReporter
      });
    }
  });
  t.after(async () => {
    releaseFactory();
    replacement ??= await starting.catch(() => undefined);
    await replacement?.close();
  });
  assert.equal(
    (await attach.confirmListenerReplacement(oldInstanceId)).kind,
    "unchanged"
  );
  releaseFactory();
  replacement = await starting;
  assert.notEqual(replacement.authRecord.instanceId, oldInstanceId);
  assert.equal(
    (await attach.confirmListenerReplacement(oldInstanceId)).kind,
    "rebound"
  );
});

linuxTest("TUI attach waits for supervised replacement admission", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const initial = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot }
  });
  t.after(() => initial.close());
  const attach = await attachHttpServer(initial.origin, { stateRoot });
  t.after(() => attach.dispose());
  const oldInstanceId = initial.authRecord.instanceId;
  const port = Number(new URL(initial.origin).port);
  await initial.close();
  let admissionOpen = false;
  const replacement = await startHttpListener({
    port,
    dataDir,
    authStore: { stateRoot },
    operationSessions: {
      lifecycle: {
        kind: "supervised",
        isAdmissionOpen: () => admissionOpen,
        admit: async () => {},
        terminal: () => {},
        hardDeadline: () => {}
      }
    }
  });
  t.after(() => replacement.close());

  assert.equal(
    (await attach.confirmListenerReplacement(oldInstanceId)).kind,
    "unchanged"
  );
  admissionOpen = true;
  assert.equal(
    (await attach.confirmListenerReplacement(oldInstanceId)).kind,
    "rebound"
  );
});

linuxTest("TUI attach classifies an incompatible proven listener as replaced", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const initial = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot }
  });
  t.after(() => initial.close());
  const attach = await attachHttpServer(initial.origin, { stateRoot });
  t.after(() => attach.dispose());
  const oldInstanceId = initial.authRecord.instanceId;
  const port = Number(new URL(initial.origin).port);
  await initial.close();

  await startProvenReplacementServer(
    t,
    initial.origin,
    port,
    stateRoot,
    (candidate) => ({
      ok: true,
      buildIdentity: {
        ...AI_1667_BUILD_IDENTITY,
        apiProtocolVersion: 7,
        minClientProtocolVersion: 7,
        maxClientProtocolVersion: 7
      },
      serverInstanceId: candidate.instanceId,
      recoveryWarnings: []
    })
  );

  assert.equal(
    (await attach.confirmListenerReplacement(oldInstanceId)).kind,
    "replaced"
  );
});

linuxTest("TUI attach classifies malformed proven health as replaced", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const initial = await startHttpListener({
    port: 0,
    dataDir,
    authStore: { stateRoot }
  });
  t.after(() => initial.close());
  const attach = await attachHttpServer(initial.origin, { stateRoot });
  t.after(() => attach.dispose());
  const oldInstanceId = initial.authRecord.instanceId;
  const port = Number(new URL(initial.origin).port);
  await initial.close();

  await startProvenReplacementServer(
    t,
    initial.origin,
    port,
    stateRoot,
    (candidate) => ({
      ok: true,
      buildIdentity: AI_1667_BUILD_IDENTITY,
      serverInstanceId: candidate.instanceId,
      recoveryWarnings: []
    })
  );

  assert.equal(
    (await attach.confirmListenerReplacement(oldInstanceId)).kind,
    "replaced"
  );
});

linuxTest("TUI settlement ends when another project replaces the listener", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const initial = await startHttpListener({
    port: 0,
    dataDir: path.join(await temporaryDirectory(t), "first-data"),
    authStore: { stateRoot }
  });
  t.after(() => initial.close());
  const attach = await attachHttpServer(initial.origin, { stateRoot });
  t.after(() => attach.dispose());
  const oldInstanceId = initial.authRecord.instanceId;
  const port = Number(new URL(initial.origin).port);
  const operations = new HttpOperationClient({
    authority: attach.authority
  });
  t.after(() => operations.dispose());
  const lease = await operations.reserve({
    method: "GET",
    path: "/api/stories",
    binding: attach.authority.snapshot(),
    requestedLifetimeMs: 2_000
  });

  await initial.close();
  const replacement = await startHttpListener({
    port,
    dataDir: path.join(await temporaryDirectory(t), "other-data"),
    authStore: { stateRoot }
  });
  t.after(() => replacement.close());

  await within(lease.settle(), 2_000);
  assert.equal(attach.authRecord.instanceId, oldInstanceId);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-http-retry-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function decorateListenerAuthority(
  source: HttpListenerAuthority,
  decorate: (fetch: OperationFetch) => OperationFetch
): HttpListenerAuthority {
  const decorateBinding = (
    binding: HttpListenerBinding
  ): HttpListenerBinding => ({
    authRecord: binding.authRecord,
    fetch: decorate(binding.fetch)
  });
  const authority = new HttpListenerAuthority({
    root: source.root,
    binding: decorateBinding(source.snapshot()),
    confirmReplacement: async (previousInstanceId) => {
      const outcome = await source.confirmListenerReplacement(
        previousInstanceId
      );
      return outcome.kind === "rebound"
        ? { kind: "rebound", binding: decorateBinding(outcome.binding) }
        : outcome;
    }
  });
  if (source.shutdownSignal.aborted) {
    authority.dispose(source.shutdownSignal.reason);
  } else {
    source.shutdownSignal.addEventListener(
      "abort",
      () => authority.dispose(source.shutdownSignal.reason),
      { once: true }
    );
  }
  return authority;
}

async function within<T>(
  operation: Promise<T>,
  milliseconds: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("operation did not settle")),
      milliseconds
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!await check()) {
    if (Date.now() >= deadline) {
      throw new Error("condition did not become true");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

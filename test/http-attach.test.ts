import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { startHttpListener } from "../server/http-listener.js";
import { createApi } from "../tui/src/api.js";
import { attachHttpServer } from "../tui/src/http-attach.js";
import { resolveHttpAuthRecordPaths } from "../server/http-auth-record.js";
import { runAuthShow } from "../tui/src/http-commands.js";
import { HttpOperationClient } from "../shared/http-operation-client.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("TUI attach binds the private auth record to the live numeric listener", async (t) => {
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const listener = await startHttpListener({ port: 0, dataDir });
  t.after(() => listener.close());
  const attach = await attachHttpServer(listener.origin);
  assert.equal(attach.authRecord.instanceId, listener.authRecord.instanceId);
  const api = createApi(attach.origin, undefined, attach);
  assert.deepEqual(await api.listStories(), []);
  assert.equal((await api.getSettings()).dataFormat, 2);
  const created = await api.createStory("HTTP V6");
  assert.equal(created.aggregateVersion?.kind, "v6");
  const renamed = await api.renameStory(created.id, "HTTP V6 renamed");
  assert.equal(renamed.title, "HTTP V6 renamed");
  assert.equal(renamed.aggregateVersion?.kind, "v6");
  if (created.aggregateVersion?.kind === "v6"
    && renamed.aggregateVersion?.kind === "v6") {
    assert.ok(renamed.aggregateVersion.revision
      > created.aggregateVersion.revision);
  }
});

linuxTest("TUI attach rejects an auth-file path outside the canonical record", async (t) => {
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const listener = await startHttpListener({ port: 0, dataDir });
  t.after(() => listener.close());
  await assert.rejects(
    attachHttpServer(listener.origin, {
      authFile: "/tmp/not-the-1667-auth-record.json"
    }),
    /canonical record/
  );
});

linuxTest("TUI API recovers an idle client with proven replacement authority", async (t) => {
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const initial = await startHttpListener({ port: 0, dataDir });
  t.after(() => initial.close());
  const attach = await attachHttpServer(initial.origin);
  t.after(() => attach.dispose());
  const api = createApi(attach.origin, undefined, attach);
  assert.deepEqual(await api.listStories(), []);
  const oldInstanceId = initial.authRecord.instanceId;
  const port = Number(new URL(initial.origin).port);

  await initial.close();
  const replacement = await startHttpListener({ port, dataDir });
  t.after(() => replacement.close());

  assert.deepEqual(await api.listStories(), []);
  assert.equal(
    attach.authRecord.instanceId,
    replacement.authRecord.instanceId
  );
  assert.notEqual(attach.authRecord.instanceId, oldInstanceId);
  assert.deepEqual(await api.listStories(), []);

  await replacement.close();
  const latest = await startHttpListener({ port, dataDir });
  t.after(() => latest.close());
  const latestRebound = await attach.confirmListenerReplacement(oldInstanceId);
  assert.equal(latestRebound.kind, "rebound");
  assert.equal(attach.authRecord.instanceId, latest.authRecord.instanceId);
  assert.deepEqual(await api.listStories(), []);

  await latest.close();
  const other = await startHttpListener({
    port,
    dataDir: path.join(await temporaryDirectory(t), "other-data")
  });
  t.after(() => other.close());
  assert.equal(
    (await attach.confirmListenerReplacement(oldInstanceId)).kind,
    "replaced"
  );
  assert.equal(attach.authRecord.instanceId, latest.authRecord.instanceId);
});

linuxTest("settings HTTP body cannot replace its reserved mutation identity", async (t) => {
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const listener = await startHttpListener({ port: 0, dataDir });
  t.after(() => listener.close());
  const attach = await attachHttpServer(listener.origin);
  t.after(() => attach.dispose());
  const api = createApi(attach.origin, undefined, attach);
  const settings = await api.getSettings();
  assert.equal(settings.dataFormat, 2);
  if (settings.dataFormat !== 2) return;
  const reservedMutationId = createDurableMutationId();
  const commandMutationId = createDurableMutationId();
  const operations = new HttpOperationClient({
    authority: attach.authority
  });
  t.after(() => operations.dispose());

  const response = await operations.run({
    method: "PUT",
    path: "/api/settings",
    binding: attach.authority.snapshot(),
    mutationId: reservedMutationId,
    execute: async (lease) => await lease.fetch(
      `${attach.origin}/api/settings`,
      {
        method: "PUT",
        headers: {
          ...lease.headers,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          transportOperationId: "untrusted-client-value",
          mutationId: commandMutationId,
          expectedStateGeneration: settings.stateGeneration,
          document: settings.document
        }),
        redirect: "error",
        signal: lease.signal
      }
    )
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Settings command mutation ID does not match its reservation",
    code: "invalid_request"
  });
  assert.equal((await api.getSettings()).stateGeneration, settings.stateGeneration);
});

linuxTest("auth show is TTY-only and prints the matching instance with one requested scope", async (t) => {
  const dataDir = path.join(await temporaryDirectory(t), "data");
  const listener = await startHttpListener({ port: 0, dataDir });
  t.after(() => listener.close());
  const authFile = (await resolveHttpAuthRecordPaths(listener.origin)).final;
  let output = "";
  await runAuthShow(
    ["show", "--scope", "story", "--url", listener.origin],
    { isTTY: true, write: (chunk) => { output += String(chunk); return true; } }
  );
  assert.match(output, new RegExp(listener.authRecord.instanceId));
  assert.match(output, new RegExp(listener.authRecord.capabilities.story));
  assert.doesNotMatch(output, new RegExp(listener.authRecord.capabilities.admin));
  await assert.rejects(
    runAuthShow(
      ["show", "--scope", "story", "--auth-file", authFile],
      { isTTY: false, write: () => true }
    ),
    /non-TTY/
  );
  await assert.rejects(
    runAuthShow(
      [
        "show",
        "--scope",
        "story",
        "--url",
        listener.origin,
        "--auth-file",
        authFile
      ],
      { isTTY: true, write: () => true }
    ),
    /either --url or --auth-file/
  );
});

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-http-attach-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

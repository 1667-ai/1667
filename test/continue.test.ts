import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "../server/story-format.js";
import type { StoryPayload } from "../shared/types.js";
import {
  API_PROTOCOL_HEADERS,
  fetchWithApiProtocol,
  waitForTestServer
} from "./http-test-client.js";

test("node routes: human create, optimistic edit, subtree delete, and payload shape", async (t) => {
  const base = await testApp(t);
  const empty = await createStory(base, "Nodes");
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.path, []);

  const withRoot = await json<StoryPayload>(`${base}/api/stories/${empty.id}/nodes`, post({
    parentId: null, instruction: "Open.", text: "The door opened."
  }));
  assert.equal(withRoot.path.length, 1);
  assert.equal(withRoot.path[0]!.human, true);
  assert.equal(withRoot.nodes[0]!.preview, "The door opened.");
  const root = withRoot.path[0]!;

  const edited = await json<StoryPayload>(`${base}/api/stories/${empty.id}/nodes/${root.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "The blue door opened.", expectedTextHash: sha256(root.text) })
  });
  assert.equal(edited.path[0]!.text, "The blue door opened.");
  assert.equal(edited.path[0]!.attribution?.source, "human");
  assert.ok(edited.path[0]!.updatedAt);
  const stale = await fetchWithApiProtocol(`${base}/api/stories/${empty.id}/nodes/${root.id}`, {
    method: "PATCH", headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ text: "stale", expectedTextHash: sha256(root.text) })
  });
  assert.equal(stale.status, 409);

  const child = await json<StoryPayload>(`${base}/api/stories/${empty.id}/nodes`, post({
    parentId: root.id, text: "Child prose."
  }));
  const wrongCount = await fetchWithApiProtocol(`${base}/api/stories/${empty.id}/nodes/${root.id}`, {
    method: "DELETE", headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" }, body: JSON.stringify({ expectedSubtreeCount: 1 })
  });
  assert.equal(wrongCount.status, 409);
  const deleted = await json<StoryPayload>(`${base}/api/stories/${empty.id}/nodes/${root.id}`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedSubtreeCount: 2 })
  });
  assert.equal(child.nodes.length, 2);
  assert.deepEqual(deleted.nodes, []);
  assert.deepEqual(deleted.path, []);
});

test("node routes: human instructions stay verbatim and first-node titles come from prose", async (t) => {
  const base = await testApp(t);
  const untitled = await json<StoryPayload>(`${base}/api/stories`, post({}));
  const human = await json<StoryPayload>(`${base}/api/stories/${untitled.id}/nodes`, post({
    parentId: null, instruction: "", text: "Lanterns beneath the rain"
  }));
  assert.equal(human.path[0]!.instruction, "");
  assert.equal(human.title, "Lanterns beneath the rain");
  const withVerbatimInstruction = await json<StoryPayload>(`${base}/api/stories/${untitled.id}/nodes`, post({
    parentId: human.path[0]!.id, instruction: "  Keep these spaces.  ", text: "A second line"
  }));
  assert.equal(withVerbatimInstruction.path[1]!.instruction, "  Keep these spaces.  ");

  const stoppedStory = await json<StoryPayload>(`${base}/api/stories`, post({}));
  const stopped = await json<StoryPayload>(`${base}/api/stories/${stoppedStory.id}/nodes`, post({
    parentId: null, text: "Partial model prose", genId: "stopped-first"
  }));
  assert.equal(stopped.path[0]!.instruction, "Continue the story.");
  assert.equal(stopped.title, "Continue the story.");
});

test("node routes: committing under an inactive parent leaves the reader on the current take", async (t) => {
  const base = await testApp(t);
  const created = await createStory(base, "Commit race");
  let payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({ parentId: null, text: "A" }));
  const a = payload.path[0]!;
  payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({ parentId: a.id, text: "B" }));
  const b = payload.path[1]!;
  payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({ parentId: a.id, text: "C" }));
  const c = payload.path[1]!;
  await json<StoryPayload>(`${base}/api/stories/${created.id}/switch`, post({ nodeId: b.id }));
  await json<StoryPayload>(`${base}/api/stories/${created.id}/switch`, post({ nodeId: c.id }));

  const saved = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({
    parentId: b.id, text: "Late continuation under B"
  }));
  assert.deepEqual(saved.path.map(({ id }) => id), [a.id, c.id]);
  assert.equal(saved.nodes.some((node) => node.parentId === b.id && node.preview === "Late continuation under B"), true);
});

test("node routes: editing as a sibling preserves model lineage and attributes only the edit", async (t) => {
  const base = await testApp(t);
  const created = await createStory(base, "Edited sibling");
  const seeded = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({
    parentId: null,
    instruction: "Open the blue door.",
    text: "The blue door opened.",
    genId: "edited-sibling-source"
  }));
  const source = seeded.path[0]!;

  const edited = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({
    sourceNodeId: source.id,
    expectedTextHash: sha256(source.text),
    instruction: "Open the red door.",
    text: "The red door opened."
  }));
  const sibling = edited.path[0]!;

  assert.notEqual(sibling.id, source.id);
  assert.equal(sibling.parentId, source.parentId);
  assert.equal(sibling.model, source.model);
  assert.equal(sibling.human, undefined);
  assert.deepEqual(sibling.attribution, {
    source: "human",
    ranges: [{ start: 4, end: 7 }],
    deletedCharacters: 3
  });
  assert.equal(edited.nodes.some((node) => node.id === source.id), true);

  const revised = await json<StoryPayload>(
    `${base}/api/stories/${created.id}/nodes/${sibling.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "The red door opened quietly.",
        expectedTextHash: sha256(sibling.text)
      })
    }
  );
  const savedRevision = revised.path[0]!;
  assert.deepEqual(
    savedRevision.attribution?.ranges.map((range) =>
      savedRevision.text.slice(range.start, range.end)),
    ["red", "quietly"]
  );
  assert.equal(savedRevision.attribution?.deletedCharacters, 3);

  const stale = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/nodes`, post({
    sourceNodeId: source.id,
    expectedTextHash: sha256("stale"),
    text: "Stale edit."
  }));
  assert.equal(stale.status, 409);
});

test("take-from-cut route validates the selection and creates an attributed sibling", async (t) => {
  const base = await testApp(t);
  const created = await createStory(base, "Cut");
  let payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({
    parentId: null, instruction: "Open", text: "Alpha beta gamma"
  }));
  const original = payload.path[0]!;
  payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes/${original.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Alpha BETAZ gamma", expectedTextHash: sha256(original.text) })
  });
  const target = payload.path[0]!;
  const offset = 9;

  const stale = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/nodes/${target.id}/take-from-cut`, post({ offset, expected: "stale" }));
  assert.equal(stale.status, 409);
  for (const invalid of [0, target.text.length, 1.5]) {
    const response = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/nodes/${target.id}/take-from-cut`, post({ offset: invalid }));
    assert.equal(response.status, 400);
  }

  const response = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/nodes/${target.id}/take-from-cut`, post({ offset, expected: "BET" }));
  assert.equal(response.status, 201);
  const cutPayload = await response.json() as StoryPayload;
  const cut = cutPayload.path[0]!;
  assert.notEqual(cut.id, target.id);
  assert.equal(cut.parentId, null);
  assert.equal(cut.text, "Alpha BET");
  assert.equal(cut.instruction, target.instruction);
  assert.equal(cut.model, target.model);
  assert.deepEqual(cut.attribution, {
    source: "human", ranges: [{ start: 6, end: 9 }], deletedCharacters: 4
  });
  const inactiveTarget = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/nodes/${target.id}/take-from-cut`, post({ offset }));
  assert.equal(inactiveTarget.status, 404);
});

test("continue modes: append, default child, regenerate sibling, and genId stop-save dedup", async (t) => {
  const base = await testApp(t);
  const created = await createStory(base, "Generation");
  let payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({
    parentId: null, instruction: "Open.", text: "The latch was unlo"
  }));
  const root = payload.path[0]!;

  let response = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/continue`, post({
    appendTo: root.id, expectedTextHash: sha256(root.text), instruction: "", genId: "append-1"
  }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"type":"done"/);
  payload = await getStory(base, created.id);
  assert.equal(payload.path.length, 1);
  assert.match(payload.path[0]!.text, /^The latch was unlo/);
  assert.equal(payload.path[0]!.genId, "append-1");
  assert.ok(payload.path[0]!.updatedAt);

  response = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/continue`, post({
    instruction: "A stranger enters.", genId: "child-1"
  }));
  assert.match(await response.text(), /"type":"done"/);
  payload = await getStory(base, created.id);
  assert.equal(payload.path.length, 2, "omitted parentId defaults to the active leaf");
  const committedChild = payload.path[1]!;

  const afterDuplicateStop = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({
    parentId: root.id, instruction: "A stranger enters.", text: "Partial duplicate", genId: "child-1"
  }));
  assert.equal(afterDuplicateStop.nodes.filter((node) => node.id === committedChild.id).length, 1);
  assert.equal(afterDuplicateStop.nodes.length, 2);

  response = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/continue`, post({
    parentId: null, instruction: "Begin differently.", genId: "regen-root"
  }));
  assert.match(await response.text(), /"type":"done"/);
  payload = await getStory(base, created.id);
  assert.equal(payload.nodes.filter((node) => node.parentId === null).length, 2, "regenerate is a root sibling take");
  assert.equal(payload.path.length, 1);
  assert.equal(payload.path[0]!.genId, "regen-root");
});

test("continue append rejects stale hashes and targets that are not the active leaf", async (t) => {
  const base = await testApp(t);
  const created = await createStory(base, "Append guards");
  let payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({ parentId: null, text: "Root" }));
  const root = payload.path[0]!;
  payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({ parentId: root.id, text: "Old leaf" }));
  const oldLeaf = payload.path[1]!;
  payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({ parentId: root.id, text: "Active leaf" }));
  const activeLeaf = payload.path[1]!;

  const stale = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/continue`, post({
    appendTo: activeLeaf.id, expectedTextHash: sha256("stale"), instruction: "", genId: "stale-append"
  }));
  assert.equal(stale.status, 409);
  const nonLeaf = await fetchWithApiProtocol(`${base}/api/stories/${created.id}/continue`, post({
    appendTo: oldLeaf.id, expectedTextHash: sha256(oldLeaf.text), instruction: "", genId: "non-leaf-append"
  }));
  assert.equal(nonLeaf.status, 409);
});

test("bookmark, switch, facts, and import mutations all return story payloads", async (t) => {
  const base = await testApp(t);
  const created = await createStory(base, "Payloads");
  let payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({ parentId: null, text: "Left." }));
  const left = payload.path[0]!;
  payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/nodes`, post({ parentId: null, text: "Right." }));
  const right = payload.path[0]!;
  payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/bookmarks/${right.id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Right", label: "Canon" })
  });
  assert.equal(payload.bookmarks[0]!.nodeId, right.id);
  payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/switch`, post({ nodeId: left.id }));
  assert.equal(payload.path[0]!.id, left.id);
  assert.deepEqual(payload.recentNodeIds, [right.id, left.id]);
  payload = await json<StoryPayload>(`${base}/api/stories/${created.id}/facts`, post({ tag: "Hero", text: "Level: 1" }));
  assert.equal(payload.facts[0]!.text, "Level: 1");

  const imported = await json<StoryPayload>(`${base}/api/import/sillytavern`, {
    method: "POST", headers: { "content-type": "text/plain" },
    body: [JSON.stringify({ character_name: "Mira", user_name: "You" }),
      JSON.stringify({ is_user: true, mes: "Begin" }), JSON.stringify({ is_user: false, mes: "One" }),
      JSON.stringify({ is_user: true, mes: "Continue" }), JSON.stringify({ is_user: false, mes: "Two" })].join("\n")
  });
  assert.equal(imported.path.length, 2);
  assert.equal(imported.path[1]!.parentId, imported.path[0]!.id);
  assert.equal(imported.path[0]!.activeChildId, imported.path[1]!.id);
});

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function createStory(base: string, title: string): Promise<StoryPayload> {
  return await json(`${base}/api/stories`, post({ title }));
}

async function getStory(base: string, id: string): Promise<StoryPayload> {
  return await json(`${base}/api/stories/${id}`);
}

async function testApp(t: test.TestContext): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-node-http-"));
  const port = await availablePort();
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts", "--print-logs"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, AI_1667_DATA: dataDir, AI_1667_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  server.stdout?.on("data", (chunk) => { output += String(chunk); });
  server.stderr?.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => { await stopApp(server); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  await waitForTestServer(server, base, () => output);
  return base;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopApp(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => server.once("exit", () => resolve())), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithApiProtocol(url, init);
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return await response.json() as T;
}

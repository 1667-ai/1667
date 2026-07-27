import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveChapters } from "../shared/chapters.js";
import type { NodeStub, StoryNode, StoryPayload } from "../shared/types.js";
import { sha256 } from "../server/story-format.js";
import {
  API_PROTOCOL_HEADERS,
  fetchWithApiProtocol,
  waitForTestServer
} from "./http-test-client.js";

test("chapter break routes validate seams and round-trip CRUD", async (t) => {
  const base = await testApp(t);
  let payload = await createStory(base, "Breaks");
  payload = await addNode(base, payload.id, null, "Root prose");
  const root = payload.path[0]!;

  assert.equal((await fetchWithApiProtocol(`${base}/api/stories/${payload.id}/chapter-breaks`, post({ parentPartId: null }))).status, 400);
  assert.equal((await fetchWithApiProtocol(`${base}/api/stories/${payload.id}/chapter-breaks`, post({ parentPartId: "missing" }))).status, 404);
  let response = await fetchWithApiProtocol(`${base}/api/stories/${payload.id}/chapter-breaks`, post({
    parentPartId: root.id, title: "Opening"
  }));
  assert.equal(response.status, 201);
  const created = await response.json() as { payload: StoryPayload; breakId: string };
  payload = created.payload;
  const chapterBreak = payload.chapterBreaks.find((item) => item.id === created.breakId)!;
  assert.equal(created.breakId, chapterBreak.id);
  assert.equal(chapterBreak.parentPartId, root.id, "a root part is a valid closing seam");
  assert.equal((await fetchWithApiProtocol(`${base}/api/stories/${payload.id}/chapter-breaks`, post({ parentPartId: root.id }))).status, 409);

  payload = await json(`${base}/api/stories/${payload.id}/chapter-breaks/${chapterBreak.id}`, patch({ title: "Renamed" }));
  assert.equal(payload.chapterBreaks[0]!.title, "Renamed");
  const removed = await json<{ payload: StoryPayload; removed: { break: unknown; summaries: unknown[] } }>(
    `${base}/api/stories/${payload.id}/chapter-breaks/${chapterBreak.id}`,
    { method: "DELETE" }
  );
  assert.deepEqual(removed.payload.chapterBreaks, []);
  assert.deepEqual(removed.removed.summaries, []);
  payload = await json(`${base}/api/stories/${payload.id}/chapter-breaks/${chapterBreak.id}/restore`, post(removed.removed));
  assert.deepEqual(payload.chapterBreaks, [{ ...chapterBreak, title: "Renamed" }]);
});

test("chapter break restore keeps canonical parse failures at 400 and state conflicts at 409", async (t) => {
  const base = await testApp(t);
  const first = await removedSummaryFixture(base, "Restore validation");
  const restoreUrl = `${base}/api/stories/${first.storyId}/chapter-breaks/${first.removed.break.id}/restore`;

  for (const invalid of [null, {}, { break: first.removed.break, summaries: {} }]) {
    assert.equal((await fetchWithApiProtocol(restoreUrl, post(invalid))).status, 400);
  }
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${first.storyId}/chapter-breaks/wrong-id/restore`,
    post(first.removed)
  )).status, 400, "the route id must match the restored break");

  const invalidSummary = structuredClone(first.removed);
  invalidSummary.summaries[0]!.role = undefined;
  assert.equal((await fetchWithApiProtocol(restoreUrl, post(invalidSummary))).status, 400);
  const duplicateSummary = structuredClone(first.removed);
  duplicateSummary.summaries.push({ ...duplicateSummary.summaries[0]!, id: "second-summary" });
  assert.equal((await fetchWithApiProtocol(restoreUrl, post(duplicateSummary))).status, 400);

  const takenSummaryId = structuredClone(first.removed);
  takenSummaryId.summaries[0]!.id = first.root.id;
  assert.equal((await fetchWithApiProtocol(restoreUrl, post(takenSummaryId))).status, 409);

  const takenBreakId = await removedSummaryFixture(base, "Break id conflict");
  takenBreakId.removed.break.id = takenBreakId.root.id;
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${takenBreakId.storyId}/chapter-breaks/${takenBreakId.root.id}/restore`,
    post(takenBreakId.removed)
  )).status, 409);

  const occupiedSeam = await removedSummaryFixture(base, "Seam conflict");
  await addChapterBreak(base, occupiedSeam.storyId, occupiedSeam.root.id, "Replacement");
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${occupiedSeam.storyId}/chapter-breaks/${occupiedSeam.removed.break.id}/restore`,
    post(occupiedSeam.removed)
  )).status, 409);

  assert.equal((await fetchWithApiProtocol(restoreUrl, post(first.removed))).status, 200);
  assert.equal((await fetchWithApiProtocol(restoreUrl, post(first.removed))).status, 409, "restoring the same break twice conflicts");
});

test("chapter summaries refresh in place, mark user edits, derive staleness, and restore with a removed break", async (t) => {
  const base = await testApp(t);
  let payload = await createStory(base, "Summaries");
  for (const text of ["One", "Two", "Three", "Four"]) {
    payload = await addNode(base, payload.id, payload.path.at(-1)?.id ?? null, text);
  }
  const [p1, p2, , p4] = payload.path;
  payload = (await addChapterBreak(base, payload.id, p2!.id, "Second")).payload;
  const closing = payload.chapterBreaks[0]!;
  payload = (await addChapterBreak(base, payload.id, p4!.id, "After")).payload;
  const inactiveClosing = payload.chapterBreaks.find((item) => item.parentPartId === p4!.id)!;

  payload = await json(`${base}/api/stories/${payload.id}/chapter-breaks/${closing.id}/summarize`, post({}));
  const summary = payload.nodes.find((node) => node.chapterBreakId === closing.id)!;
  assert.equal(summary.parentId, p2!.id);
  assert.deepEqual(summary.coveredExtent, { fromPartId: p1!.id, toPartId: p2!.id });
  assert.ok(summary.text?.includes("STORY SO FAR"));
  assert.ok((summary.tokens ?? 0) > 0);
  assert.equal(payload.path.some((node) => node.id === summary.id), false);
  assert.equal(payload.path[1]!.activeChildId, payload.path[2]!.id, "summary creation does not move the active path");

  await new Promise((resolve) => setTimeout(resolve, 5));
  payload = await json(`${base}/api/stories/${payload.id}/nodes/${summary.id}`, patch({
    text: "Author-maintained chapter summary.", expectedTextHash: sha256(summary.text!)
  }));
  const edited = payload.nodes.find((node) => node.id === summary.id)!;
  assert.equal(edited.editedByUser, true);
  assert.equal(edited.text, "Author-maintained chapter summary.");
  assert.ok(edited.madeAt! > summary.madeAt!, "a summary text edit advances madeAt");
  const editedMadeAt = edited.madeAt;

  payload = await json(`${base}/api/stories/${payload.id}/chapter-breaks/${closing.id}/summarize`, post({}));
  const refreshed = payload.nodes.find((node) => node.id === summary.id)!;
  assert.equal(refreshed.editedByUser, undefined);
  assert.notEqual(refreshed.text, edited.text);
  assert.ok(refreshed.madeAt! >= editedMadeAt!);
  assert.equal(chapter(payload, closing.id).stale, false);

  await new Promise((resolve) => setTimeout(resolve, 5));
  payload = await json(`${base}/api/stories/${payload.id}/nodes/${p1!.id}`, patch({
    text: "One changed", expectedTextHash: sha256(p1!.text)
  }));
  assert.equal(chapter(payload, closing.id).stale, true, "editing a covered part stales the summary");
  payload = await json(`${base}/api/stories/${payload.id}/chapter-breaks/${closing.id}/summarize`, post({}));
  assert.equal(chapter(payload, closing.id).stale, false, "refresh uses the current extent and edit times");

  payload = (await addChapterBreak(base, payload.id, p1!.id, "Carved")).payload;
  const carved = payload.chapterBreaks.find((item) => item.parentPartId === p1!.id)!;
  assert.equal(chapter(payload, closing.id).stale, true, "inserting a break changes the summary extent");
  const carvedRemoval = await json<{ payload: StoryPayload; removed: unknown }>(
    `${base}/api/stories/${payload.id}/chapter-breaks/${carved.id}`,
    { method: "DELETE" }
  );
  payload = carvedRemoval.payload;
  assert.equal(chapter(payload, closing.id).stale, false, "removing the carved break restores the extent");

  const removed = await json<{
    payload: StoryPayload;
    removed: { break: unknown; summaries: Array<{ id: string }> };
  }>(`${base}/api/stories/${payload.id}/chapter-breaks/${closing.id}`, { method: "DELETE" });
  assert.deepEqual(removed.removed.summaries.map((node) => node.id), [summary.id]);
  assert.equal(removed.payload.nodes.some((node) => node.id === summary.id), false);
  payload = await json(`${base}/api/stories/${payload.id}/chapter-breaks/${closing.id}/restore`, post(removed.removed));
  assert.equal(payload.nodes.some((node) => node.id === summary.id), true);
  assert.equal(payload.chapterBreaks.some((item) => item.id === closing.id), true);

  const alt = await addNode(base, payload.id, payload.path[1]!.id, "Alternate continuation");
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${payload.id}/chapter-breaks/${inactiveClosing.id}/summarize`, post({})
  )).status, 409);
  assert.equal(alt.path.at(-1)!.text, "Alternate continuation");
  payload = await json(`${base}/api/stories/${payload.id}/nodes/${p1!.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedSubtreeCount: alt.nodes.length })
  });
  assert.deepEqual(payload.nodes, []);
  assert.deepEqual(payload.chapterBreaks, [], "subtree deletion removes anchored breaks and their summaries");
});

test("facts persist a validated optional source part", async (t) => {
  const base = await testApp(t);
  let payload = await createStory(base, "Facts");
  payload = await addNode(base, payload.id, null, "Source prose");
  const source = payload.path[0]!;
  payload = await json(`${base}/api/stories/${payload.id}/facts`, post({ text: "Remembered", sourcePartId: source.id }));
  assert.equal(payload.facts[0]!.sourcePartId, source.id);
  assert.equal((await json<StoryPayload>(`${base}/api/stories/${payload.id}`)).facts[0]!.sourcePartId, source.id);
  assert.equal((await fetchWithApiProtocol(`${base}/api/stories/${payload.id}/facts`, post({
    text: "Bad source", sourcePartId: "missing"
  }))).status, 400);
});

test("instruction-only PATCH refreshes hydrated node stub tokens", async (t) => {
  const base = await testApp(t);
  let payload = await createStory(base, "Instruction tokens");
  payload = await addNode(base, payload.id, null, "Root");
  const root = payload.path[0]!;
  payload = await addNode(base, payload.id, root.id, "Inactive branch prose");
  const inactive = payload.path[1]!;
  payload = await addNode(base, payload.id, root.id, "Active branch prose");
  const before = payload.nodes.find((node) => node.id === inactive.id)!.tokens;

  payload = await json(`${base}/api/stories/${payload.id}/nodes/${inactive.id}`, patch({
    instruction: "Describe every turn of the long crossing in patient sensory detail. ".repeat(12),
    expectedTextHash: sha256(inactive.text)
  }));

  assert.ok(payload.nodes.find((node) => node.id === inactive.id)!.tokens > before);
});

function chapter(payload: StoryPayload, breakId: string) {
  const byId = new Map(payload.nodes.map((node) => [node.id, node] as const));
  const path = payload.path.map((node) => byId.get(node.id)!).filter((node): node is NodeStub => node !== undefined);
  return deriveChapters(path, payload.chapterBreaks, payload.nodes)
    .find((candidate) => candidate.closedBy?.id === breakId)!;
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function patch(body: unknown): RequestInit {
  return {
    method: "PATCH",
    headers: { ...API_PROTOCOL_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function createStory(base: string, title: string): Promise<StoryPayload> {
  return await json(`${base}/api/stories`, post({ title }));
}

async function addNode(base: string, id: string, parentId: string | null, text: string): Promise<StoryPayload> {
  return await json(`${base}/api/stories/${id}/nodes`, post({ parentId, text }));
}

async function addChapterBreak(
  base: string,
  storyId: string,
  parentPartId: string,
  title = ""
): Promise<{ payload: StoryPayload; breakId: string }> {
  return await json(`${base}/api/stories/${storyId}/chapter-breaks`, post({ parentPartId, title }));
}

async function removedSummaryFixture(base: string, title: string): Promise<{
  storyId: string;
  root: StoryPayload["path"][number];
  removed: { break: { id: string; parentPartId: string; title: string; createdAt: string }; summaries: StoryNode[] };
}> {
  let payload = await createStory(base, title);
  payload = await addNode(base, payload.id, null, "Closed chapter prose");
  const root = payload.path[0]!;
  const created = await addChapterBreak(base, payload.id, root.id);
  await json(`${base}/api/stories/${payload.id}/chapter-breaks/${created.breakId}/summarize`, post({}));
  const deleted = await json<{ payload: StoryPayload; removed: {
    break: { id: string; parentPartId: string; title: string; createdAt: string };
    summaries: StoryNode[];
  } }>(`${base}/api/stories/${payload.id}/chapter-breaks/${created.breakId}`, { method: "DELETE" });
  return { storyId: payload.id, root, removed: deleted.removed };
}

async function testApp(t: test.TestContext): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-chapters-http-"));
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
  await Promise.race([
    new Promise<void>((resolve) => server.once("exit", () => resolve())),
    new Promise((resolve) => setTimeout(resolve, 1_000))
  ]);
  if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithApiProtocol(url, init);
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return await response.json() as T;
}

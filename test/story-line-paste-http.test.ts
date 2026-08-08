import assert from "node:assert/strict";
import test from "node:test";
import type { StoryPayload } from "../shared/types.js";
import { API_PROTOCOL_HEADERS, fetchWithApiProtocol } from "./http-test-client.js";
import { json, testApp } from "./story-server-fixture.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest(
  "paste-line clones the source's descendant chain under the target, in order, active, and leaves the source untouched",
  async (t) => {
    const base = await testApp(t, "1667-paste-line-http-");
    let payload = await createStory(base, "Paste line");
    payload = await addNode(base, payload.id, null, "Root", "Open");
    const root = payload.path[0]!;
    payload = await addNode(base, payload.id, root.id, "First", "Write on");
    const first = payload.path[1]!;
    payload = await addNode(base, payload.id, first.id, "Second", "Write on");
    const second = payload.path[2]!;
    payload = await addNode(base, payload.id, second.id, "Third", "Write on");
    const third = payload.path[3]!;
    // A sibling take under the root retargets the active line away from
    // `first`/`second`/`third` (root is still on the active path when this
    // take is created) without touching their own activeChildId pointers —
    // exactly the "anchor off the active line, chain still intact" shape
    // paste-line has to handle.
    payload = await addNode(base, payload.id, root.id, "Alt", "Branch");
    const target = payload.path[1]!;
    assert.equal(target.text, "Alt");

    const pasted = await json<StoryPayload>(
      `${base}/api/stories/${payload.id}/nodes/${target.id}/paste-line`,
      post({ sourceNodeId: first.id, expectedLeafId: third.id })
    );

    // Target attachment and exact cloned order: root, target, then the
    // cloned chain in the same order it appeared below the source.
    assert.deepEqual(
      pasted.path.map((node) => [node.text, node.instruction]),
      [["Root", "Open"], ["Alt", "Branch"], ["Second", "Write on"], ["Third", "Write on"]]
    );
    const [, , clonedSecond, clonedThird] = pasted.path;
    assert.equal(clonedSecond!.parentId, target.id);
    assert.equal(clonedThird!.parentId, clonedSecond!.id);
    assert.notEqual(clonedSecond!.id, second.id, "a paste clones a new node, it does not move the original");
    assert.notEqual(clonedThird!.id, third.id);

    // Active-path selection: the cloned path is now the story's active line.
    assert.equal(pasted.path.at(-1)!.id, clonedThird!.id);
    assert.equal(clonedSecond!.activeChildId, clonedThird!.id);
    assert.equal(clonedThird!.activeChildId, null);

    // Source preservation: switching back to the original leaf shows the
    // original chain untouched — same ids, same text, same instructions.
    const resumed = await json<StoryPayload>(
      `${base}/api/stories/${payload.id}/switch`,
      post({ nodeId: third.id })
    );
    assert.deepEqual(
      resumed.path.map((node) => [node.id, node.text, node.instruction]),
      [[root.id, "Root", "Open"], [first.id, "First", "Write on"], [second.id, "Second", "Write on"], [third.id, "Third", "Write on"]]
    );
  }
);

linuxTest("paste-line validates missing, summary, stale, and self/descendant targets", async (t) => {
  const base = await testApp(t, "1667-paste-line-http-");
  let payload = await createStory(base, "Paste line validation");
  payload = await addNode(base, payload.id, null, "Root");
  const root = payload.path[0]!;
  payload = await addNode(base, payload.id, root.id, "First");
  const first = payload.path[1]!;
  payload = await addNode(base, payload.id, first.id, "Second");
  const second = payload.path[2]!;

  // Missing source and missing target.
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${payload.id}/nodes/${root.id}/paste-line`,
    post({ sourceNodeId: "missing", expectedLeafId: second.id })
  )).status, 404);
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${payload.id}/nodes/missing/paste-line`,
    post({ sourceNodeId: first.id, expectedLeafId: second.id })
  )).status, 404);

  // Nothing below a leaf to copy.
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${payload.id}/nodes/${root.id}/paste-line`,
    post({ sourceNodeId: second.id, expectedLeafId: second.id })
  )).status, 400);

  // Self and descendant targets.
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${payload.id}/nodes/${first.id}/paste-line`,
    post({ sourceNodeId: first.id, expectedLeafId: second.id })
  )).status, 400, "a story line cannot paste below its own anchor");
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${payload.id}/nodes/${second.id}/paste-line`,
    post({ sourceNodeId: root.id, expectedLeafId: second.id })
  )).status, 400, "a story line cannot paste below one of its own parts");

  // Stale: the chain grew after `expectedLeafId` was captured.
  payload = await addNode(base, payload.id, second.id, "Third");
  const third = payload.path[3]!;
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${payload.id}/nodes/${root.id}/paste-line`,
    post({ sourceNodeId: first.id, expectedLeafId: second.id })
  )).status, 409);

  // Chapter summaries are structural dead ends: neither a copy source nor a
  // paste target.
  const created = await json<{ payload: StoryPayload; breakId: string }>(
    `${base}/api/stories/${payload.id}/chapter-breaks`,
    post({ parentPartId: root.id })
  );
  payload = created.payload;
  payload = await json(
    `${base}/api/stories/${payload.id}/chapter-breaks/${created.breakId}/summarize`,
    post({})
  );
  const summary = payload.nodes.find((node) => node.chapterBreakId === created.breakId)!;
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${payload.id}/nodes/${root.id}/paste-line`,
    post({ sourceNodeId: summary.id, expectedLeafId: summary.id })
  )).status, 400);
  assert.equal((await fetchWithApiProtocol(
    `${base}/api/stories/${payload.id}/nodes/${summary.id}/paste-line`,
    post({ sourceNodeId: first.id, expectedLeafId: third.id })
  )).status, 400);
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

async function addNode(
  base: string,
  id: string,
  parentId: string | null,
  text: string,
  instruction = ""
): Promise<StoryPayload> {
  return await json(`${base}/api/stories/${id}/nodes`, post({ parentId, text, instruction }));
}

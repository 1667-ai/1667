import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubNpmOperationWorkflows
} from "../scripts/release-npm-operation-workflows.js";

const REPOSITORY = "1667-ai/1667";
const SOURCE = "0123456789abcdef0123456789abcdef01234567";

test("npm operation workflows paginate and dispatch through the bounded transport",
  async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new GitHubNpmOperationWorkflows({
      repository: REPOSITORY,
      token: "secret",
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
        const page = new URL(url).searchParams.get("page");
        if (page === "1") {
          return jsonResponse({
            workflow_runs: Array.from({ length: 100 }, (_, index) => {
              return workflowRun(index + 1);
            })
          });
        }
        if (page === "2") {
          return jsonResponse({ workflow_runs: [workflowRun(101)] });
        }
        throw new Error(`unexpected request ${url}`);
      }
    });

    await client.dispatchHolder({
      operation: "promotion",
      version: "1.2.3",
      sourceCommit: SOURCE,
      requestId: "123e4567-e89b-42d3-a456-426614174000"
    });
    const runs = await client.runs("release-npm-operation.yml");

    assert.equal(runs.length, 101);
    assert.deepEqual(
      requests.slice(1).map((request) => new URL(request.url).searchParams.get("page")),
      ["1", "2"]
    );
    const dispatch = requests[0]!;
    assert.equal(dispatch.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(dispatch.init?.body)), {
      inputs: {
        operation: "promotion",
        request_id: "123e4567-e89b-42d3-a456-426614174000",
        source_commit: SOURCE,
        version: "1.2.3"
      },
      ref: "main"
    });
  });

test("npm operation workflow pages reject duplicate JSON fields", async () => {
  const client = new GitHubNpmOperationWorkflows({
    repository: REPOSITORY,
    token: "secret",
    fetch: async () => new Response(
      '{"workflow_runs":[],"workflow_runs":[]}',
      { headers: { "content-type": "application/json" } }
    )
  });

  await assert.rejects(
    client.runs("release-npm-operation.yml"),
    /invalid JSON/u
  );
});

function workflowRun(id: number): Record<string, unknown> {
  return {
    id,
    run_attempt: 1,
    display_title: `run ${id}`,
    status: "completed"
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  });
}

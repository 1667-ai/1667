import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubHttpTransport
} from "../scripts/release-github-http.js";
import {
  GitHubWorkflowClient
} from "../scripts/release-github-workflow-client.js";

const API = "https://api.github.test/";
const DATE = "Tue, 28 Jul 2026 12:00:00 GMT";
const ACQUIRED = "2026-07-28T11:59:00Z";

test("the concurrency proof follows the bounded next cursor", async () => {
  const requests: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const after = url.searchParams.get("after");
    if (after === null) {
      return jsonResponse({
        total_count: 101,
        concurrency_groups: Array.from(
          { length: 100 },
          (_, index) => concurrencyGroup(`group-${index}`)
        )
      }, {
        link: `<${API}repos/1667-ai/1667/actions/concurrency_groups`
          + `?per_page=100&after=cursor-1>; rel="next"`
      });
    }
    assert.equal(after, "cursor-1");
    return jsonResponse({
      total_count: 101,
      concurrency_groups: [concurrencyGroup("release-npm")]
    });
  };
  const store = workflowClient({
    repository: "1667-ai/1667",
    token: "token",
    apiUrl: API,
    fetch
  });

  const acquisition = await store.concurrencyAcquisition("release-npm");
  assert.equal(acquisition.groupName, "release-npm");
  assert.equal(acquisition.acquiredAt, Date.parse(ACQUIRED));
  assert.equal(acquisition.observedAt, Date.parse(DATE));
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.searchParams.get("after"), "cursor-1");
});

test("the concurrency proof rejects an external next cursor", async () => {
  let requests = 0;
  const store = workflowClient({
    repository: "1667-ai/1667",
    token: "token",
    apiUrl: API,
    fetch: async () => {
      requests += 1;
      return jsonResponse({
        total_count: 2,
        concurrency_groups: [concurrencyGroup("group-1")]
      }, {
        link: '<https://attacker.example/steal?per_page=100&after=secret>; rel="next"'
      });
    }
  });

  await assert.rejects(
    store.concurrencyAcquisition("release-npm"),
    /concurrency next link is invalid/u
  );
  assert.equal(requests, 1);
});

test("the concurrency proof rejects a repeated cursor", async () => {
  let requests = 0;
  const store = workflowClient({
    repository: "1667-ai/1667",
    token: "token",
    apiUrl: API,
    fetch: async () => {
      requests += 1;
      return jsonResponse({
        total_count: 3,
        concurrency_groups: [concurrencyGroup(`group-${requests}`)]
      }, {
        link: `<${API}repos/1667-ai/1667/actions/concurrency_groups`
          + `?per_page=100&after=cursor-1>; rel="next"`
      });
    }
  });

  await assert.rejects(
    store.concurrencyAcquisition("release-npm"),
    /pagination repeats a cursor/u
  );
  assert.equal(requests, 2);
});

test("the concurrency proof rejects a count change between pages", async () => {
  let requests = 0;
  const store = workflowClient({
    repository: "1667-ai/1667",
    token: "token",
    apiUrl: API,
    fetch: async () => {
      requests += 1;
      return requests === 1
        ? jsonResponse({
            total_count: 2,
            concurrency_groups: [concurrencyGroup("group-1")]
          }, {
            link: `<${API}repos/1667-ai/1667/actions/concurrency_groups`
              + `?per_page=100&after=cursor-1>; rel="next"`
          })
        : jsonResponse({
            total_count: 3,
            concurrency_groups: [concurrencyGroup("release-npm")]
          });
    }
  });

  await assert.rejects(
    store.concurrencyAcquisition("release-npm"),
    /count changed during pagination/u
  );
});

test("the concurrency proof rejects an incomplete final page", async () => {
  const store = workflowClient({
    repository: "1667-ai/1667",
    token: "token",
    apiUrl: API,
    fetch: async () => jsonResponse({
      total_count: 2,
      concurrency_groups: [concurrencyGroup("release-npm")]
    })
  });

  await assert.rejects(
    store.concurrencyAcquisition("release-npm"),
    /pagination is incomplete/u
  );
});

test("the concurrency proof has a request pagination bound", async () => {
  let requests = 0;
  const store = workflowClient({
    repository: "1667-ai/1667",
    token: "token",
    apiUrl: API,
    fetch: async () => {
      requests += 1;
      return jsonResponse({
        total_count: 10_001,
        concurrency_groups: [concurrencyGroup(`group-${requests}`)]
      }, {
        link: `<${API}repos/1667-ai/1667/actions/concurrency_groups`
          + `?per_page=100&after=cursor-${requests}>; rel="next"`
      });
    }
  });

  await assert.rejects(
    store.concurrencyAcquisition("release-npm"),
    /exceed the pagination bound/u
  );
  assert.equal(requests, 100);
});

function concurrencyGroup(name: string): {
  readonly group_name: string;
  readonly group_url: string;
  readonly last_acquired_at: string;
} {
  return {
    group_name: name,
    group_url: `${API}repos/1667-ai/1667/actions/concurrency_groups/${name}`,
    last_acquired_at: ACQUIRED
  };
}

function workflowClient(options: {
  readonly repository: string;
  readonly token: string;
  readonly apiUrl: string;
  readonly fetch: typeof fetch;
}): GitHubWorkflowClient {
  return new GitHubWorkflowClient(
    options.repository,
    new GitHubHttpTransport({
      ...options,
      maxResponseBytes: 1024 * 1024,
      userAgent: "1667-test-workflow-client"
    })
  );
}

function jsonResponse(
  value: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      date: DATE,
      ...headers
    }
  });
}

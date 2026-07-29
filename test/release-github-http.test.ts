import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubHttpTransport
} from "../scripts/release-github-http.js";

test("GitHub transport binds endpoint, credentials, headers, and JSON", async () => {
  let observedUrl = "";
  let observed: RequestInit | undefined;
  const transport = new GitHubHttpTransport({
    token: "secret",
    apiUrl: "https://api.github.test/api/v3/",
    maxResponseBytes: 1024,
    userAgent: "1667-test",
    fetch: async (input, init) => {
      observedUrl = String(input);
      observed = init;
      return jsonResponse('{"ok":true}');
    }
  });
  const response = await transport.request(
    "repos/1667-ai/1667/git/ref/tags/v1.2.3",
    { method: "GET", apiVersion: "2026-03-10" },
    "test GitHub"
  );

  assert.equal(
    observedUrl,
    "https://api.github.test/api/v3/repos/1667-ai/1667/git/ref/tags/v1.2.3"
  );
  const headers = new Headers(observed?.headers);
  assert.equal(headers.get("authorization"), "Bearer secret");
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("user-agent"), "1667-test");
  assert.equal(headers.get("x-github-api-version"), "2026-03-10");
  assert.equal(observed?.redirect, "error");
  assert.ok(observed?.signal instanceof AbortSignal);
  assert.deepEqual(
    { ...await transport.readJson(response, "test response") as object },
    { ok: true }
  );
});

test("GitHub transport rejects endpoints outside its API before fetch", async () => {
  let requests = 0;
  const transport = new GitHubHttpTransport({
    token: "secret",
    apiUrl: "https://api.github.test/api/v3/",
    maxResponseBytes: 1024,
    userAgent: "1667-test",
    fetch: async () => {
      requests += 1;
      return jsonResponse("{}");
    }
  });
  for (const endpoint of [
    "../rate_limit",
    "%2e%2e/rate_limit",
    "/rate_limit",
    "https://attacker.example/steal",
    "repos\\attacker",
    "rate_limit#steal"
  ]) {
    await assert.rejects(
      transport.request(endpoint, { method: "GET" }, "test GitHub"),
      /endpoint is (?:invalid|outside)/u,
      endpoint
    );
  }
  assert.equal(requests, 0);
});

test("GitHub transport composes external cancellation with its deadline", {
  timeout: 2_000
}, async () => {
  const external = new AbortController();
  const transport = new GitHubHttpTransport({
    token: "secret",
    apiUrl: "https://api.github.test/",
    maxResponseBytes: 1024,
    timeoutMs: 25,
    userAgent: "1667-test",
    requestSignal: () => external.signal,
    fetch: async (_input, init) => await rejectWhenAborted(init)
  });

  const deadlineStarted = Date.now();
  await assert.rejects(
    transport.request("rate_limit", { method: "GET" }, "test GitHub"),
    /request did not settle/u
  );
  assert.ok(Date.now() - deadlineStarted < 500);
  assert.equal(external.signal.aborted, false);

  const cancelled = new AbortController();
  const cancellation = new GitHubHttpTransport({
    token: "secret",
    maxResponseBytes: 1024,
    timeoutMs: 1_000,
    userAgent: "1667-test",
    requestSignal: () => cancelled.signal,
    fetch: async (_input, init) => await rejectWhenAborted(init)
  }).request("rate_limit", { method: "GET" }, "cancelled GitHub");
  const cancellationStarted = Date.now();
  cancelled.abort(new Error("cancelled"));
  await assert.rejects(cancellation, /request did not settle/u);
  assert.ok(Date.now() - cancellationStarted < 200);
});

test("GitHub transport rejects oversized, malformed, and duplicate JSON", async () => {
  const transport = new GitHubHttpTransport({
    token: "secret",
    maxResponseBytes: 32,
    userAgent: "1667-test"
  });
  await assert.rejects(
    transport.readJson(jsonResponse("x".repeat(33)), "bounded response"),
    /exceeds the response bound/u
  );
  await assert.rejects(
    transport.readJson(new Response(new Uint8Array([0x22, 0xff, 0x22]), {
      headers: { "content-type": "application/json" }
    }), "UTF-8 response"),
    /invalid JSON/u
  );
  await assert.rejects(
    transport.readJson(jsonResponse('{"a":1,"a":2}'), "duplicate response"),
    /invalid JSON/u
  );
});

function jsonResponse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "application/json" }
  });
}

async function rejectWhenAborted(init: RequestInit | undefined): Promise<Response> {
  const signal = init?.signal;
  assert.ok(signal instanceof AbortSignal);
  return await new Promise<Response>((_resolve, reject) => {
    const didNotAbort = setTimeout(
      () => reject(new Error("mock request did not abort")),
      1_000
    );
    signal.addEventListener("abort", () => {
      clearTimeout(didNotAbort);
      reject(signal.reason);
    }, { once: true });
  });
}

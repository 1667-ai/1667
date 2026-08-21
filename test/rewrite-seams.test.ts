import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AnchoredOutputFilter, longestBoundaryOverlap, stripEchoedContext } from "../server/generation-prompts.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { streamCompletion } from "../server/providers.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

// Live-tested small-model habits the seam verification must survive: echoing
// more preceding text than the anchor, wrapping the right anchor in the literal
// prompt tag, and reproducing the right anchor but forgetting the end marker.

const BEFORE = "The tavern keeper wiped the counter with a grey rag.";
const ANCHOR = BEFORE.slice(-24); // "counter with a grey rag."
const providerTest = ownedLoopbackHttpSupported() ? test : test.skip;

function drain(filter: AnchoredOutputFilter, chunks: readonly string[], size = Infinity): string {
  let visible = "";
  for (const chunk of chunks) {
    if (size === Infinity) {
      visible += filter.push(chunk);
      continue;
    }
    for (let at = 0; at < chunk.length; at += size) visible += filter.push(chunk.slice(at, at + size));
  }
  return visible + filter.finish();
}

test("an echo of more preceding text than the anchor still verifies the left seam", () => {
  const filter = new AnchoredOutputFilter(ANCHOR, "", "", true, { beforeTail: BEFORE });
  const visible = drain(filter, [`${BEFORE} Fresh replacement prose.`], 5);
  assert.equal(filter.matchedPrefix, true);
  assert.equal(visible, " Fresh replacement prose.");
});

test("a normalized (inexact) echo still fails the left seam", () => {
  const filter = new AnchoredOutputFilter(ANCHOR, "", "", true, { beforeTail: BEFORE });
  const visible = drain(filter, ["Counter with a grey rag. Fresh replacement prose."], 7);
  assert.equal(filter.matchedPrefix, false);
  assert.equal(visible, "Counter with a grey rag. Fresh replacement prose.");
});

test("a right anchor wrapped in the literal prompt tag satisfies the contract", () => {
  const filter = new AnchoredOutputFilter("", "Dawn found it", "[[end-rw-1]]", false, { anchorWrapTag: "rw-1-right" });
  const visible = drain(filter, ["fresh words <rw-1-right>Dawn found it</rw-1-right>[[end-rw-1]]"], 3);
  assert.equal(filter.matchedContract, true);
  assert.equal(visible, "fresh words ");
});

test("a right anchor at the end of the stream is accepted without its marker", () => {
  const filter = new AnchoredOutputFilter("", "Dawn found it", "[[end-rw-1]]", false, { anchorWrapTag: "rw-1-right" });
  const visible = drain(filter, ["fresh words Dawn found it", "  \n"], 4);
  assert.equal(filter.matchedContract, true);
  assert.equal(visible, "fresh words ");
});

test("an end marker without the right anchor still fails the contract", () => {
  const filter = new AnchoredOutputFilter("", "Dawn found it", "[[end-rw-1]]", false, { anchorWrapTag: "rw-1-right" });
  drain(filter, ["fresh words [[end-rw-1]]"]);
  assert.equal(filter.matchedContract, false);
});

test("prose continuing past the trailing anchor still fails the contract", () => {
  const filter = new AnchoredOutputFilter("", "Dawn found it", "[[end-rw-1]]", false, { anchorWrapTag: "rw-1-right" });
  drain(filter, ["fresh words Dawn found it and the story wandered on"]);
  assert.equal(filter.matchedContract, false);
});

test("longestBoundaryOverlap finds the run that ends at the boundary", () => {
  assert.equal(longestBoundaryOverlap(BEFORE, `${BEFORE} more`), BEFORE.length);
  assert.equal(longestBoundaryOverlap(BEFORE, "grey rag. Fresh prose"), "grey rag.".length);
  assert.equal(longestBoundaryOverlap(BEFORE, "Unrelated opening"), 0);
});

test("stripEchoedContext removes adjacent-story echoes at either end", () => {
  const before = "The tavern keeper wiped the counter. ";
  const after = " A stranger pushed through the door.";
  assert.equal(
    stripEchoedContext("wiped the counter. Rain hammered the stones.", before, after),
    "Rain hammered the stones."
  );
  assert.equal(
    stripEchoedContext("Rain hammered the stones. A stranger pushed through", before, after),
    "Rain hammered the stones."
  );
  // Short overlaps are far more likely legitimate prose than echo.
  assert.equal(stripEchoedContext("counter-intuitively, rain", before, after), "counter-intuitively, rain");
});

providerTest("openai-compatible retries a 400 that names an unsupported parameter", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push(body);
    if ("max_tokens" in body) return reject(response, "max_tokens", "unsupported_parameter");
    if ("temperature" in body) return reject(response, "temperature", "unsupported_value");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject2) => server.close((error) => error ? reject2(error) : resolve())));
  const settings: GenerationSettings = {
    provider: "openai-compatible",
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: "reasoning-model",
    apiKeyEnv: null,
    temperature: 0.6,
    maxTokens: 100,
    systemPrompt: "brief",
    contextWindow: null
  };

  let text = "";
  const prompt: PromptPlan = {
    operation: "rewrite",
    turns: [{
      role: "user",
      blocks: [{
        stability: "volatile",
        kind: "request",
        text: "hi",
        boundaryAfter: "none"
      }]
    }]
  };
  for await (const delta of streamCompletion(settings, prompt, new AbortController().signal)) {
    text += delta;
  }
  assert.equal(text, "ok");
  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.max_tokens, 100);
  assert.equal(requests[1]!.max_completion_tokens, 100, "max_tokens is renamed, not dropped");
  assert.equal("reasoning_effort" in requests[1]!, false, "a retry keeps the resolved reasoning field unchanged");
  assert.equal("max_tokens" in requests[1]!, false);
  assert.equal("temperature" in requests[2]!, false, "a rejected temperature is dropped");
  assert.equal("reasoning_effort" in requests[2]!, false);
});

providerTest("openai-compatible retries never rewrite or remove explicit effort", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push(body);
    if ("max_tokens" in body) return reject(response, "max_tokens", "unsupported_parameter");
    return reject(response, "reasoning_effort", "unsupported_parameter");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject2) => {
    server.close((error) => error ? reject2(error) : resolve());
  }));
  const settings = attachProviderRuntime({
    provider: "openai-compatible",
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: "reasoning-model",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 100,
    systemPrompt: "brief",
    contextWindow: null
  }, {
    preset: "custom",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort: "high",
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "supported",
      promptCaching: "unknown"
    }
  }, true);
  const prompt: PromptPlan = {
    operation: "rewrite",
    turns: [{
      role: "user",
      blocks: [{
        stability: "volatile",
        kind: "request",
        text: "hi",
        boundaryAfter: "none"
      }]
    }]
  };

  await assert.rejects(async () => {
    for await (const _delta of streamCompletion(
      settings,
      prompt,
      new AbortController().signal
    )) {
      // Drain.
    }
  }, /reasoning_effort/);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.reasoning_effort, "high");
});

function reject(response: ServerResponse, param: string, code: string): void {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: `Unsupported parameter: '${param}'.`, type: "invalid_request_error", param, code } }));
}

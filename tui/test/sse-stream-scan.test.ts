import { afterEach, expect, test } from "bun:test";
import {
  createTestApi as createApi,
  testHttpMetadata as metadata,
  testStoryPayload as storyPayload
} from "./http-api-fixture.js";
import { streamFake } from "../src/fake-stream.js";
import {
  assertWithinBudget,
  cpuBudget,
  startTiming
} from "../../test/performance-budget.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function sseWire(events: readonly Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** Deterministic, unevenly sized pieces (2-8 characters, matching the fake
 *  stream's own chunk sizing) covering `text` — small enough that some must
 *  land in the middle of a "\n\n" event separator, without paying the fake
 *  stream's real per-chunk delay for a payload this large. */
function unevenChunks(text: string): string[] {
  const chunks: string[] = [];
  let seed = 337;
  let offset = 0;
  while (offset < text.length) {
    seed = (seed * 48271) % 0x7fffffff;
    const size = 2 + (seed % 7);
    chunks.push(text.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

function readableFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[index]!));
      index += 1;
    }
  });
}

function mockFetchFor(chunks: readonly string[]): typeof fetch {
  return (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json(metadata());
    if (path === "/api/stories/story" && (init?.method ?? "GET") === "GET") {
      return Response.json(storyPayload("story"));
    }
    if (path === "/api/stories/story/summary-take") {
      return new Response(readableFrom(chunks), {
        headers: { "content-type": "text/event-stream" }
      });
    }
    throw new Error(`Unexpected API path: ${path}`);
  }) as typeof fetch;
}

test("the fake stream can sustain a rate above its default's ~125 chunk/second ceiling (issue #337)", async () => {
  // The default 8ms floor cannot exceed 1000/8 = 125 chunks/second no matter
  // how high wpm goes. Lowering the floor is the whole fix; this measures
  // the achieved rate rather than trusting that the option was wired
  // through correctly.
  const text = "word ".repeat(20_000);
  const started = Date.now();
  let count = 0;
  for await (const _chunk of streamFake(text, { wpm: 10_000_000, minDelayMs: 0 })) {
    count += 1;
    if (Date.now() - started > 400) break;
  }
  const elapsedSeconds = Math.max(0.001, (Date.now() - started) / 1000);
  expect(count / elapsedSeconds).toBeGreaterThan(125);
});

test("a delta separator split across two network chunks is still parsed, in order, byte-identical", async () => {
  const deltas = Array.from(
    { length: 400 },
    (_, index) => `chunk-${index}:${"x".repeat(index % 13)}`
  );
  const wire = sseWire([
    ...deltas.map((text) => ({ type: "delta", text })),
    { type: "done", nodeId: "the-new-take" }
  ]);
  const chunks = unevenChunks(wire);
  expect(chunks.length).toBeGreaterThan(deltas.length);
  expect(chunks.some((chunk) => chunk.length < 4)).toBeTrue();

  globalThis.fetch = mockFetchFor(chunks);
  const api = createApi("http://127.0.0.1:7373");
  await api.loadStory("story");
  const received: string[] = [];
  const nodeId = await api.createSummaryTake(
    "story",
    { nodeId: "root" },
    (text) => received.push(text),
    new AbortController().signal
  );

  expect(nodeId).toBe("the-new-take");
  expect(received).toEqual(deltas);
  expect(received.join("")).toBe(deltas.join(""));
});

test("a large final payload with no line break until the end still parses in bounded time", async () => {
  // 2MB with no separator until the very end — the exact shape a large
  // completion payload takes (issue #337). Rescanning the whole buffer on
  // every network chunk, as the old unbounded search did, costs a scan of
  // gigabytes by the time this finishes; resuming from the last search
  // position keeps the total work linear in the payload size.
  const hugeNodeId = "y".repeat(2_000_000);
  const wire = sseWire([
    { type: "delta", text: "partial line " },
    { type: "done", nodeId: hugeNodeId }
  ]);
  const chunkSize = 250;
  const chunks: string[] = [];
  for (let offset = 0; offset < wire.length; offset += chunkSize) {
    chunks.push(wire.slice(offset, offset + chunkSize));
  }
  expect(chunks.length).toBeGreaterThan(1_000);

  globalThis.fetch = mockFetchFor(chunks);
  const api = createApi("http://127.0.0.1:7373");
  await api.loadStory("story");

  const read = startTiming();
  const nodeId = await api.createSummaryTake(
    "story",
    { nodeId: "root" },
    () => {},
    new AbortController().signal
  );
  assertWithinBudget(
    { diagnostic: () => undefined },
    "large single-line SSE payload parse",
    cpuBudget(2_000),
    read()
  );

  expect(nodeId).toBe(hugeNodeId);
});

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { streamResponse } from "../server/stream-response.js";
import { SSE_HEARTBEAT_INTERVAL_MS, splitSseEvents } from "../shared/sse.js";
import { DELTA_BATCH_WINDOW_MS } from "../shared/worker-protocol.js";
import { FakeResponse } from "./fake-http-response.js";
import { platformPerformanceBudget } from "./performance-budget.js";

/** Splits every "data: ...\n\n" event `FakeResponse` recorded and parses its
 *  JSON payload — the same wire format a real SSE client reads. */
function recordedEvents(response: FakeResponse): Record<string, unknown>[] {
  return splitSseEvents(response.output).events.map(
    (data) => JSON.parse(data) as Record<string, unknown>
  );
}

/** Deterministic, unevenly sized pieces (2-6 characters) covering `text` —
 *  small enough, and plentiful enough, to exceed the 125-chunk-per-second
 *  ceiling a realistic typed-narration rate would otherwise impose (issue
 *  #337's own named test gap). A fast provider makes many such calls to
 *  `onDelta` with no gap between them at all. */
function fastChunks(text: string): string[] {
  const chunks: string[] = [];
  let seed = 337;
  let offset = 0;
  while (offset < text.length) {
    seed = (seed * 48271) % 0x7fffffff;
    const size = 2 + (seed % 5);
    chunks.push(text.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

test("a fast stream is batched into far fewer SSE writes, and the delivered text is byte-identical", async () => {
  const source = Array.from(
    { length: 4_000 },
    (_, index) => `word${index} `
  ).join("");
  const chunks = fastChunks(source);
  assert.ok(chunks.length > 500, "the fixture must exercise many deltas");

  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const gate = new Promise<void>((resolve) => setTimeout(resolve, 5));
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (onDelta) => {
      for (const chunk of chunks) await onDelta(chunk);
      // Give any scheduled 16ms window flushes a chance to interleave with
      // production, the way a real, faster-than-the-network provider would.
      await gate;
      return { ok: true };
    },
    (value) => value
  );
  await running;

  const events = recordedEvents(response);
  const deltaEvents = events.filter((event) => event.type === "delta");
  const done = events.at(-1);

  assert.equal(done?.["ok"], true);
  assert.equal(
    deltaEvents.map((event) => event.text as string).join(""),
    source
  );
  // The whole point of batching: far fewer events than deltas pushed.
  assert.ok(
    deltaEvents.length < chunks.length / 10,
    `expected batching to collapse ${chunks.length} deltas into well under `
    + `${Math.floor(chunks.length / 10)} SSE events, got ${deltaEvents.length}`
  );
});

test("a pending batch is flushed before the completion event, never after or reordered", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (onDelta) => {
      // Below the byte threshold, so nothing has been written yet when
      // `run` resolves — the flush this test is about has not happened.
      await onDelta("still buffered when the model finishes");
      return { ok: true };
    },
    (value) => value
  );
  await running;

  const events = recordedEvents(response);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "delta");
  assert.equal(events[0]?.text, "still buffered when the model finishes");
  assert.equal(events[1]?.["ok"], true);
});

test("a pending batch is flushed before the error event, never after or reordered", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (onDelta) => {
      await onDelta("buffered, then the model fails");
      throw new Error("provider exploded");
    },
    (value) => value
  );
  await running;

  const events = recordedEvents(response);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "delta");
  assert.equal(events[0]?.text, "buffered, then the model fails");
  assert.equal(events[1]?.type, "error");
});

test("a slow stream still delivers its first token promptly, without waiting for the stream to end", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (onDelta) => {
      await onDelta("one token");
      // Simulates a real gap between tokens far longer than the batching
      // window — the model is not finished, and nothing forces a flush
      // from the caller's side. Only the batching window's own timer can
      // deliver this token before the stream ends.
      await modelGate;
      return { ok: true };
    },
    (value) => value
  );

  const budgetMs = platformPerformanceBudget(DELTA_BATCH_WINDOW_MS * 10);
  const deadline = Date.now() + budgetMs;
  while (response.writes === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(response.writes, 1, "the lone token must reach the writer before the stream ends");
  const events = recordedEvents(response);
  assert.equal(events[0]?.type, "delta");
  assert.equal(events[0]?.text, "one token");

  releaseModel();
  await running;
  assert.equal(response.ends, 1);
});

test("a silent stream sends an SSE comment heartbeat before the model responds", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async () => {
      await modelGate;
      return { ok: true };
    },
    (value) => value
  );

  const heartbeatCount = () => response.output.match(/: heartbeat\n\n/g)?.length ?? 0;
  const deadline = Date.now() + SSE_HEARTBEAT_INTERVAL_MS * 4;
  while (heartbeatCount() < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(heartbeatCount() >= 2, "the silent stream must keep sending heartbeats");

  releaseModel();
  await running;
});

test("reasoning frames batch on their own channel, separate from and never mixed into story-prose delta frames", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (onDelta, _signal, onReasoning) => {
      await onReasoning({ text: "weigh", tokenCount: 1 });
      await onDelta("prose");
      await onReasoning({ text: " options", tokenCount: 2 });
      await onDelta(" continues");
      return { ok: true };
    },
    (value) => value
  );
  await running;

  const events = recordedEvents(response);
  const deltaEvents = events.filter((event) => event.type === "delta");
  const reasoningEvents = events.filter((event) => event.type === "reasoning");
  const done = events.at(-1);

  assert.equal(done?.["ok"], true);
  // Batched by DELTA_BATCH_WINDOW_MS with no gap between pushes, so both
  // channels typically arrive as one flushed frame each — but the exact
  // count is not the point: no reasoning byte reaches a "delta" frame, and
  // no prose byte reaches a "reasoning" frame.
  assert.equal(
    deltaEvents.map((event) => event.text as string).join(""),
    "prose continues"
  );
  assert.equal(
    reasoningEvents.map((event) => event.text as string).join(""),
    "weigh options"
  );
  // The running token count travels with whichever reasoning frame it
  // arrives in — the freshest known count, never a fabricated one.
  assert.equal(reasoningEvents.at(-1)?.["tokenCount"], 2);
});

test("a stream that ends mid-batch flushes rather than dropping the tail", async () => {
  const request = Readable.from([]) as unknown as IncomingMessage;
  const response = new FakeResponse();
  const running = streamResponse(
    request,
    response as unknown as ServerResponse,
    async (onDelta, signal) => {
      await onDelta("first ");
      await onDelta("second ");
      await onDelta("third");
      if (signal.aborted) return null;
      return { ok: true };
    },
    (value) => value
  );
  await running;

  const events = recordedEvents(response);
  const deltaText = events
    .filter((event) => event.type === "delta")
    .map((event) => event.text as string)
    .join("");
  assert.equal(deltaText, "first second third");
});

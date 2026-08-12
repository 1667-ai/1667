import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError, ServiceError } from "../server/errors.js";
import { promptCacheBoundaries } from "../server/prompt-cache-breakpoints.js";
import { streamCompletion } from "../server/providers.js";
import { continuationPlan } from "../shared/continuation-plan.js";
import type { ImageInputCapabilityResolution } from "../shared/image-input-capabilities.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import type { GenerationSettings, StoryNode } from "../shared/types.js";

/**
 * Integration coverage for image blocks through the provider pipeline:
 * ordering against a fake OpenAI and a fake Anthropic server, the refusal
 * gates that keep an unauthorized route byte-free, the no-fallback rule, the
 * cache-breakpoint exclusion, the prefill/echo override, and the base64
 * containment promise. Body-shape goldens for text-only prompts live in
 * test/provider-request-body.test.ts and are untouched by this file.
 */

const IMAGE_OBJECT_ID = "a".repeat(64);
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8]);
const IMAGE_BASE64 = Buffer.from(IMAGE_BYTES).toString("base64");

const SUPPORTED: ImageInputCapabilityResolution = {
  support: "supported",
  strategy: { kind: "explicit-ceiling", ceiling: 1_000 }
};

function imageAttachment(): StoryImageAttachment {
  return {
    objectId: IMAGE_OBJECT_ID,
    mediaType: "image/png",
    width: 512,
    height: 384,
    byteLength: IMAGE_BYTES.length
  };
}

function imageBytesMap(): ReadonlyMap<string, Uint8Array> {
  return new Map([[IMAGE_OBJECT_ID, IMAGE_BYTES]]);
}

function settings(
  provider: GenerationSettings["provider"],
  overrides: Partial<GenerationSettings> = {}
): GenerationSettings {
  return {
    provider,
    baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
    model: "fixture-model",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 64,
    systemPrompt: "Voice.",
    contextWindow: null,
    ...overrides
  };
}

/** A minimal plan: one system turn, and one user turn carrying an image
 *  block immediately before its instruction text. */
function imagePlan(image: StoryImageAttachment): PromptPlan {
  return {
    operation: "continue",
    turns: [
      {
        role: "system",
        blocks: [{ stability: "stable", kind: "author-brief", text: "Voice.", boundaryAfter: "candidate" }]
      },
      {
        role: "user",
        blocks: [
          { stability: "volatile", kind: "image", image, boundaryAfter: "none" },
          { stability: "volatile", kind: "request", text: "Describe the attached image.", boundaryAfter: "none" }
        ]
      }
    ]
  };
}

async function drain(stream: AsyncGenerator<string>): Promise<void> {
  for await (const _delta of stream) { /* drain */ }
}

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("OpenAI Chat Completions lowers an image block before its text, as a data URL", async () => {
  const image = imageAttachment();
  const plan = imagePlan(image);
  let requestBody: Record<string, unknown> | null = null;
  await withFetch(
    (async (input) => {
      assert.ok(input instanceof Request);
      requestBody = await input.clone().json() as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
    () => drain(streamCompletion(settings("openai-compatible"), plan, new AbortController().signal, {
      imageBytes: imageBytesMap(),
      imageCapability: SUPPORTED
    }))
  );
  const messages = (requestBody as unknown as { messages: Array<{ role: string; content: unknown }> }).messages;
  const userMessage = messages.find((message) => message.role === "user");
  assert.deepEqual(userMessage?.content, [
    { type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE_BASE64}` } },
    { type: "text", text: "Describe the attached image." }
  ]);
});

test("Anthropic Messages lowers an image block before its text, as base64 with a media type", async () => {
  const image = imageAttachment();
  const plan = imagePlan(image);
  let requestBody: Record<string, unknown> | null = null;
  await withFetch(
    (async (input) => {
      assert.ok(input instanceof Request);
      requestBody = await input.clone().json() as Record<string, unknown>;
      return new Response("data: {\"type\":\"message_stop\"}\n\n", {
        headers: { "content-type": "text/event-stream" }
      });
    }) as typeof fetch,
    () => drain(streamCompletion(settings("anthropic"), plan, new AbortController().signal, {
      imageBytes: imageBytesMap(),
      imageCapability: SUPPORTED
    }))
  );
  const body = requestBody as unknown as {
    system: unknown;
    messages: Array<{ role: string; content: unknown }>;
  };
  assert.deepEqual(body.messages[0]?.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_BASE64 } },
    { type: "text", text: "Describe the attached image." }
  ]);
  // Anthropic `system` stays text-only even on an image-bearing request.
  assert.equal(body.system, "Voice.");
});

test("no provider receives bytes for an unknown or unsupported image capability", async () => {
  const image = imageAttachment();
  const plan = imagePlan(image);
  let fetchCalls = 0;
  const refusingFetch = (async () => {
    fetchCalls += 1;
    throw new Error("a refused image request must never dispatch");
  }) as typeof fetch;
  await withFetch(refusingFetch, async () => {
    const unknown: ImageInputCapabilityResolution = { support: "unknown", reason: "unknown-model" };
    const unsupported: ImageInputCapabilityResolution = { support: "unsupported", reason: "explicit-unsupported" };
    for (const capability of [unknown, unsupported]) {
      await assert.rejects(
        drain(streamCompletion(settings("openai-compatible"), plan, new AbortController().signal, {
          imageBytes: imageBytesMap(),
          imageCapability: capability
        })),
        (error: unknown) => error instanceof ServiceError && error.code === "image_input_not_supported"
      );
    }
    // A caller that gives no capability at all fails the same way, closed by
    // default rather than open.
    await assert.rejects(
      drain(streamCompletion(settings("anthropic"), plan, new AbortController().signal, {
        imageBytes: imageBytesMap()
      })),
      (error: unknown) => error instanceof ServiceError && error.code === "image_input_not_supported"
    );
  });
  assert.equal(fetchCalls, 0);
});

test("dry-run and text-completion protocols refuse an image without dispatching anywhere", async () => {
  const image = imageAttachment();
  const plan = imagePlan(image);
  await assert.rejects(
    drain(streamCompletion(settings("dry-run"), plan, new AbortController().signal, {
      imageBytes: imageBytesMap(),
      imageCapability: SUPPORTED
    })),
    (error: unknown) => error instanceof ServiceError && error.code === "image_input_not_supported"
  );
  await assert.rejects(
    drain(streamCompletion(
      settings("text-completion", { baseUrl: "http://127.0.0.1:8080" }),
      plan,
      new AbortController().signal,
      { imageBytes: imageBytesMap(), imageCapability: SUPPORTED }
    )),
    (error: unknown) => error instanceof ServiceError && error.code === "image_input_not_supported"
  );
});

test("a provider image rejection does not retry as text-only", async () => {
  const image = imageAttachment();
  const plan = imagePlan(image);
  let fetchCalls = 0;
  let capturedError: ProviderError | null = null;
  await withFetch(
    (async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({ error: { message: "This model does not accept image input.", code: "invalid_image" } }),
        { status: 400 }
      );
    }) as typeof fetch,
    () => assert.rejects(
      drain(streamCompletion(settings("openai-compatible"), plan, new AbortController().signal, {
        imageBytes: imageBytesMap(),
        imageCapability: SUPPORTED
      })),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        capturedError = error;
        return true;
      }
    )
  );
  assert.equal(fetchCalls, 1, "a rejected image request is never retried without the image");
  assert.equal((capturedError as ProviderError | null)?.message.includes(IMAGE_BASE64), false);
  assert.equal((capturedError as ProviderError | null)?.body.includes(IMAGE_BASE64), false);
});

test("a block naming an object missing from the supplied bytes names only the object id, never any byte content", async () => {
  const image = imageAttachment();
  const plan = imagePlan(image);
  await assert.rejects(
    // imageBytes deliberately omitted: local admission must already have
    // refused any object the caller cannot supply, so this is a programming
    // error, not a request the writer could cause.
    drain(streamCompletion(settings("openai-compatible"), plan, new AbortController().signal, {
      imageCapability: SUPPORTED
    })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(IMAGE_OBJECT_ID));
      assert.equal(error.message.includes(IMAGE_BASE64), false);
      return true;
    }
  );
});

test("a cache breakpoint never lands on an image block", () => {
  const image = imageAttachment();
  const part: StoryNode = {
    id: "part-1",
    parentId: null,
    instruction: "Describe the picture.",
    text: "A quiet room, lit by one lantern.",
    model: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
    activeChildId: null,
    imageAttachments: [image]
  };
  const plan = continuationPlan(
    "Voice.", null, null, [part], "Continue.", false, true, null, [], [part]
  ).prompt;
  const userTurn = plan.turns.find((turn) => turn.role === "user");
  assert.equal(userTurn?.blocks[0]?.kind, "image");
  const boundaries = promptCacheBoundaries(plan);
  assert.ok(boundaries.length > 0, "the fixture must still produce at least one boundary to make this test meaningful");
  for (const boundary of boundaries) {
    const block = plan.turns[boundary.location.turn]?.blocks[boundary.location.block];
    assert.notEqual(block?.kind, "image");
  }
});

test("a request that carries a new image forces a new-passage turn: no prefill, no boundary echo", () => {
  const image = imageAttachment();
  const part: StoryNode = {
    id: "part-1",
    parentId: null,
    instruction: "Begin.",
    text: "The room held its breath",
    model: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
    activeChildId: null
  };
  // appendLast and assistantPrefill are both true: without a new image, this
  // combination would continue the unfinished passage with a prefill turn.
  const plan = continuationPlan(
    "Voice.", null, null, [part], "What is in this picture?",
    true, true, null, [], [part], [image]
  );
  assert.equal(plan.requiresEcho, false);
  assert.equal(plan.leftAnchor, "");
  const lastTurn = plan.prompt.turns.at(-1);
  assert.equal(lastTurn?.role, "user");
  // The operation contract leads the turn (issue #138 / PR #148): it must
  // stay stable-before-volatile, and the image and request blocks are both
  // volatile.
  assert.deepEqual(lastTurn?.blocks.map((block) => block.kind), ["operation-contract", "image", "request"]);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { continueStory } from "../server/generation-http.js";
import { GenerationAdmissionRegistry } from "../server/generation-admission.js";
import { PromptCacheRuntime, LEGACY_PROMPT_CACHE_CONTEXT } from "../server/provider-cache-policy.js";
import { ServiceError } from "../server/errors.js";
import { StoryStore } from "../server/stories.js";
import type { SettingsStore } from "../server/settings.js";
import type { StoredImageInputCapability } from "../server/settings-state-slot.js";
import type { GenerationSettings } from "../shared/types.js";
import { opaquePng } from "./image-fixtures.js";

/**
 * The live request path (server/generation-http.ts's `continueStory`) must
 * consult a stored image-input override before it lets an image reach a
 * provider, not only `shared/image-input-capabilities.ts`'s resolver in
 * isolation. `test/settings-schema-successor.test.ts` already proves the
 * settings-store read side in isolation (`SettingsV2Store.loadRuntime`'s
 * `imageInputCapability` plus `resolveImageInputCapability` called by hand);
 * these two tests instead drive the real `continueStory` function a request
 * actually takes, with a `SettingsStore` double standing in for disk I/O and
 * a mocked `globalThis.fetch` standing in for the network, so the assertions
 * are about `continueStory`'s own behavior, not the resolver's.
 *
 * Both tests use `StoryStore` for real: real Draft Image staging, real
 * `resolveDraftImage`/`loadImage`, and (for the authorized case) real commit.
 */

async function library(t: test.TestContext): Promise<{ stories: StoryStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-image-override-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  return { stories, dir };
}

function fakeSettingsStore(
  settings: GenerationSettings,
  capability: StoredImageInputCapability | null
): SettingsStore {
  return {
    // `settings` and `capability` come back from the one `loadGeneration`
    // call, matching `SettingsV2Store.loadRuntime`'s combined snapshot
    // (server/settings-v2-store.ts): `continueStory` no longer makes a
    // separate call to fetch the capability.
    loadGeneration: async () => ({
      settings,
      promptCache: LEGACY_PROMPT_CACHE_CONTEXT,
      imageInputCapability: capability
    })
  } as unknown as SettingsStore;
}

interface CapturedRequestBody {
  readonly messages?: Array<{ readonly role: string; readonly content: unknown }>;
}

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("a stored 'unsupported' override refuses the image before any provider request, even for a model the built-in table would authorize", async (t) => {
  const { stories } = await library(t);
  const story = await stories.create("Override refusal story");
  // "gpt-4o" is in shared/image-input-capabilities.ts's built-in OpenAI
  // table: with no override, this exact route would be authorized. The bytes
  // need not be a real PNG — refusal happens before any byte is verified.
  const staged = await stories.stageImage(story.id, {
    mediaType: "image/png",
    width: 4,
    height: 4,
    bytes: Buffer.from("stand-in bytes, never read")
  });

  const settings: GenerationSettings = {
    provider: "openai-compatible",
    // https, not a loopback address: server/provider-fetch.ts dispatches an
    // https URL through plain `fetch`, the layer this test mocks. A loopback
    // URL instead takes the owned-loopback socket path, which this mock
    // cannot see.
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 64,
    systemPrompt: "Write coherent prose.",
    contextWindow: 4_096
  };
  const settingsStore = fakeSettingsStore(settings, { imageInput: "unsupported" });

  let fetchCalls = 0;
  const refusingFetch = (async () => {
    fetchCalls += 1;
    throw new Error("a refused image request must never dispatch to a provider");
  }) as typeof fetch;

  await withFetch(refusingFetch, () => assert.rejects(
    continueStory(
      story.id,
      {
        parentId: null,
        instruction: "Describe the attached image.",
        genId: "override-refuse",
        images: [{ leaseId: staged.leaseId, objectId: staged.attachment.objectId }]
      },
      stories,
      settingsStore,
      new PromptCacheRuntime(),
      new GenerationAdmissionRegistry(),
      () => {},
      new AbortController().signal,
      { imageStore: stories }
    ),
    (error: unknown) => error instanceof ServiceError && error.code === "image_input_not_supported"
  ));
  assert.equal(fetchCalls, 0, "the stored override must refuse before any provider dispatch");
});

test("a stored 'supported' override with a token ceiling authorizes and reaches the provider with the image, for a model absent from the built-in table", async (t) => {
  const { stories, dir } = await library(t);
  const story = await stories.create("Override authorization story");
  const pngBytes = await opaquePng(8, 8);
  const staged = await stories.stageImage(story.id, {
    mediaType: "image/png",
    width: 8,
    height: 8,
    bytes: pngBytes
  });

  const settings: GenerationSettings = {
    provider: "openai-compatible",
    // https, not a loopback address: server/provider-fetch.ts dispatches an
    // https URL through plain `fetch`, the layer this test mocks. A loopback
    // URL instead takes the owned-loopback socket path, which this mock
    // cannot see.
    baseUrl: "https://api.openai.com/v1",
    // Not in shared/image-input-capabilities.ts's OPENAI_TILE_MODELS or
    // ANTHROPIC_PATCH_MODELS: with no override, this route can never be
    // authorized, no matter what the writer knows about the model.
    model: "totally-unlisted-vision-model",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 64,
    systemPrompt: "Write coherent prose.",
    // The fixed request guidance is just above a 4K context once the image
    // admission path includes its reserved input budget. Keep this fixture's
    // context large enough to exercise authorization and provider dispatch.
    contextWindow: 8_192
  };
  const settingsStore = fakeSettingsStore(
    settings,
    { imageInput: "supported", imageTokenCeiling: 4_096 }
  );

  let capturedBody: CapturedRequestBody | null = null;
  const respondingFetch = (async (input: RequestInfo | URL) => {
    assert.ok(input instanceof Request, "providers.ts dispatches a Request object");
    capturedBody = await input.clone().json() as CapturedRequestBody;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "A quiet room." }, finish_reason: null }] })}\n\n`
      + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } }
    );
  }) as typeof fetch;

  const result = await withFetch(respondingFetch, () => continueStory(
    story.id,
    {
      parentId: null,
      instruction: "Describe the attached image.",
      genId: "override-authorize",
      images: [{ leaseId: staged.leaseId, objectId: staged.attachment.objectId }]
    },
    stories,
    settingsStore,
    new PromptCacheRuntime(),
    new GenerationAdmissionRegistry(),
    () => {},
    new AbortController().signal,
    { imageStore: stories }
  ));

  assert.ok(result !== null, "an authorized generation must commit, not stop");
  // A plain type assertion, not control-flow narrowing: `capturedBody` is
  // written only from inside the mocked-fetch closure above, so TypeScript
  // cannot see that `withFetch` ran it before this line.
  const body = capturedBody as CapturedRequestBody | null;
  assert.ok(body !== null, "the stored override must let the request reach the provider");
  const userMessage = body.messages?.find((message) => message.role === "user");
  assert.ok(Array.isArray(userMessage?.content), "the user turn must carry structured content, not a plain string");
  const imageBlock = (userMessage?.content as Array<Record<string, unknown>>)
    .find((block) => block.type === "image_url");
  assert.ok(imageBlock !== undefined, "the outgoing provider request must carry the image block");

  // The commit above went through the direct, non-aggregate path
  // (`StoryStore.commitProviderEffect` -> `saveUnlocked`'s "v5" branch): the
  // one place a bare-V5 story picks up an Image Attachment with no aggregate
  // mutation request in play (server/story-service-generation.ts's
  // raw-store branch, taken whenever a request carries no
  // `expectedAggregateVersion`). Stopping at `result !== null` above is
  // exactly the gap that let a severe data-loss defect through: that same
  // commit used to write a successor-schema manifest bare, past the point
  // where any V5 reader — including this same release, reopening its own
  // file — could read it again. Only a fresh `StoryStore` over the same
  // directory proves the bytes on disk are still sound.
  const reopened = new StoryStore(dir);
  await reopened.init();
  const opened = await reopened.load(story.id);
  assert.equal(opened.id, story.id, "the story must still open after the write that attached an image");
  const metadata = await reopened.loadMetadata(story.id);
  assert.equal(metadata.id, story.id, "the story must still resolve lightweight metadata");
  const summaries = await reopened.list();
  assert.ok(summaries.some((summary) => summary.id === story.id), "the story must still appear in the library list");
  await assert.doesNotReject(
    () => reopened.remove(story.id),
    "the story must still be deletable"
  );
});

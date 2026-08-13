/**
 * Shared fixtures for Story Aside integration tests.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ServiceError } from "../server/errors.js";
import { StoryService } from "../server/story-service.js";
import { StoryStore } from "../server/stories.js";
import {
  InjectedStoryMutationCrash,
  StoryMutationStore,
  type StoryMutationStoreHooks
} from "../server/story-mutation-store.js";
import {
  FINGERPRINT,
  FIXED_NOW,
  MUTATION_ID,
  providerOperation,
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";

export function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}

export async function openService(t: import("node:test").TestContext): Promise<{
  dataDir: string;
  service: StoryService;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-svc-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { dataDir, service };
}

export function crashOnce(
  point: "afterPreparedBeforeStage" | "afterStage" | "afterPrepared" | "afterPublish"
): StoryMutationStoreHooks {
  let injected = false;
  return {
    [point]: () => {
      if (injected) return;
      injected = true;
      throw new InjectedStoryMutationCrash(point);
    }
  };
}

/** Seed one Side Note through the durable askAside provider path. */
export async function seedAsideNote(
  fixture: Awaited<ReturnType<typeof setup>>,
  mutationId = MUTATION_ID,
  fingerprint = FINGERPRINT
): Promise<NonNullable<Awaited<ReturnType<StoryStore["loadVersioned"]>>["aggregateVersion"]>> {
  await fixture.stories.mutate(STORY_ID, (story) => {
    if (story.nodes.length > 0) return;
    story.nodes = [{
      id: "root",
      parentId: null,
      instruction: "",
      text: "Line.",
      model: "m",
      createdAt: FIXED_NOW.toISOString(),
      activeChildId: null
    }];
    story.activeRootId = "root";
  });
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  const document = {
    schemaVersion: 1 as const,
    notes: [{ question: "Keep?", answer: "Yes." }]
  };
  await fixture.mutations.runProviderOperation(
    requestFor(mutationId, fingerprint, version),
    "askAside",
    providerOperation(
      async (stories, start) => {
        await start();
        await stories.commitProviderEffect(STORY_ID, {
          kind: "aside",
          expectedAsideDocumentId: undefined,
          document
        });
        return document;
      },
      () => document
    )
  );
  return (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
}

/** Ensure the story has a single root part for provider mutation tests. */
export async function ensureRootPart(stories: StoryStore): Promise<void> {
  await stories.mutate(STORY_ID, (story) => {
    story.nodes = [{
      id: "root",
      parentId: null,
      instruction: "",
      text: "Line.",
      model: "m",
      createdAt: FIXED_NOW.toISOString(),
      activeChildId: null
    }];
    story.activeRootId = "root";
  });
}

export function commitAsideDocument(
  document: { schemaVersion: 1; notes: readonly { question: string; answer: string }[] }
) {
  return providerOperation(
    async (stories, start) => {
      await start();
      await stories.commitProviderEffect(STORY_ID, {
        kind: "aside",
        expectedAsideDocumentId: undefined,
        document
      });
      return document;
    },
    () => document
  );
}

export { InjectedStoryMutationCrash, StoryMutationStore };

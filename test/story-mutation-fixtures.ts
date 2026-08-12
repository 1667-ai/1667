import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Story } from "../shared/types.js";
import { ServiceError } from "../server/errors.js";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import type { ProviderMutationMethod } from "../server/mutation-ledger-types.js";
import type { ProviderStoryRun } from "../server/story-provider-contract.js";
import type { StoryAggregateSession } from "../server/story-aggregate-session.js";
import { hashStoryV5ManifestBytes } from "../server/story-manifest-hash.js";
import {
  StoryMutationStore,
  type StoryMutationStoreHooks
} from "../server/story-mutation-store.js";
import { StoryStore } from "../server/stories.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";

export class PinObservingStoryStore extends StoryStore {
  activeProviderPins = 0;
  failNextCleanupSchedule = false;

  override pinProviderSnapshot(session: StoryAggregateSession): () => void {
    const release = super.pinProviderSnapshot(session);
    this.activeProviderPins += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeProviderPins -= 1;
      }
      release();
    };
  }

  override async schedulePendingCleanup(id: string): Promise<void> {
    if (this.failNextCleanupSchedule) {
      this.failNextCleanupSchedule = false;
      throw new Error("Injected cleanup scheduling failure");
    }
    await super.schedulePendingCleanup(id);
  }
}

export function providerOperation<
  Method extends ProviderMutationMethod,
  Value
>(
  work: (
    stories: ProviderStoryRuntime<Method>,
    providerStarted: () => Promise<void>
  ) => Promise<Value>,
  replayValue: () => Value
): ProviderStoryRun<Method, Value> {
  return {
    signal: new AbortController().signal,
    work: async ({ stories, providerStarted }) =>
      await work(stories, providerStarted),
    replayValue
  };
}

export const STORY_ID = "q-local-story";
export const MUTATION_ID =
  "m1.1767225600000.0123456789abcdef0123456789abcdef";
export const OTHER_MUTATION_ID =
  "m1.1767225600000.1123456789abcdef0123456789abcdef";
export const THIRD_MUTATION_ID =
  "m1.1767225600000.4123456789abcdef0123456789abcdef";
export const FOURTH_MUTATION_ID =
  "m1.1767225600000.5123456789abcdef0123456789abcdef";
export const DELETE_MUTATION_ID =
  "m1.1767225600000.2123456789abcdef0123456789abcdef";
export const ACK_MUTATION_ID =
  "m1.1767225600000.3123456789abcdef0123456789abcdef";
export const FINGERPRINT = "a".repeat(64);
export const OTHER_FINGERPRINT = "b".repeat(64);
export const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

export interface SetupOptions {
  /** Forwarded to the `StoryStore` this fixture builds, when `createStories`
   *  is left at its default. `StoryMutationStore` no longer takes a copy of
   *  its own: it reads activation straight off the `StoryStore` it is given,
   *  so a custom `createStories` factory's own choice is always the one that
   *  applies, and the two can never be set to disagree. Absent matches
   *  production: the successor story write path stays off. */
  readonly imageInputActivation?: boolean;
}

export async function setup(
  t: Pick<import("node:test").TestContext, "after">,
  prefix: string,
  hooks: StoryMutationStoreHooks = {},
  createStories?: (storiesDir: string) => StoryStore,
  options: SetupOptions = {}
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storiesDir = path.join(dataDir, "stories");
  const stories = createStories !== undefined
    ? createStories(storiesDir)
    : new StoryStore(storiesDir, undefined, undefined, undefined, undefined, options.imageInputActivation);
  await stories.init();
  await stories.save(storyFixture());
  const manifestFile = path.join(storiesDir, STORY_ID, "manifest.json");
  const v5Hash = hashStoryV5ManifestBytes(await readFile(manifestFile));
  const ledger = new MutationLedgerStore(dataDir);
  const coordinator = createMutationCoordinator();
  const mutations = new StoryMutationStore(
    stories,
    coordinator,
    dataDir,
    { ledger, hooks, now: () => FIXED_NOW }
  );
  await mutations.init();
  return {
    dataDir,
    stories,
    ledger,
    coordinator,
    mutations,
    manifestFile,
    v5Hash
  };
}

export function request(manifestHash: string) {
  return requestFor(MUTATION_ID, FINGERPRINT, {
    kind: "v5",
    manifestHash
  });
}

export function requestFor(
  mutationId: string,
  fingerprint: string,
  expectedAggregateVersion: NonNullable<
    Awaited<ReturnType<StoryStore["loadVersioned"]>>["aggregateVersion"]
  >
) {
  return {
    transportOperationId: "operation-local",
    mutationId,
    fingerprint,
    scope: `story:${STORY_ID}`,
    expectedAggregateVersion
  };
}

export function storyFixture(): Story {
  return {
    id: STORY_ID,
    title: "Original",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

export function hasServiceError(
  code: string
): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}

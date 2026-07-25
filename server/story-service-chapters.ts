import type { Story, StoryPayload } from "../shared/types.js";
import {
  chapterBreakRemovalFingerprint,
  createChapterBreak,
  parseRemovedChapterBreak,
  removeChapterBreak,
  renameChapterBreak,
  restoreChapterBreak,
  type RemovedChapterBreak
} from "./chapter-breaks.js";
import { ServiceError } from "./errors.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import type {
  LocalStoryMutationMethod,
  StoryMutationStore
} from "./story-mutation-store.js";
import { buildStoryPayload } from "./story-payload.js";
import {
  STORY_UNCHANGED,
  type StoryStore
} from "./stories.js";

export interface StoryServiceChapterDependencies {
  readonly stories: StoryStore;
  readonly storyMutations: StoryMutationStore;
  readonly ensureOpen: () => void;
}

/** Chapter-divider persistence, separate from provider-backed summarization. */
export class StoryServiceChapters {
  constructor(
    private readonly dependencies: StoryServiceChapterDependencies
  ) {}

  async createChapterBreak(
    id: string,
    parentPartId: string,
    title: string,
    chapterBreakId?: string,
    mutationRequest?: unknown
  ): Promise<{ payload: StoryPayload; breakId: string }> {
    this.dependencies.ensureOpen();
    if (mutationRequest !== undefined) {
      if (chapterBreakId === undefined) {
        throw new ServiceError(
          500,
          "Receipt-backed chapter creation requires a deterministic break ID",
          "internal"
        );
      }
      const committed = await this.dependencies.storyMutations.runLocal(
        mutationRequest,
        "createChapterBreak",
        (story) => {
          const created = createChapterBreak(
            story,
            parentPartId,
            title,
            chapterBreakId
          );
          return created.id;
        },
        () => chapterBreakId
      );
      return {
        payload: payloadFromCommit(committed),
        breakId: committed.value
      };
    }
    let breakId = "";
    const story = await this.dependencies.stories.mutate(id, (fresh) => {
      breakId = createChapterBreak(
        fresh,
        parentPartId,
        title,
        chapterBreakId
      ).id;
    });
    return { payload: buildStoryPayload(story), breakId };
  }

  async renameChapterBreak(
    id: string,
    breakId: string,
    title: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "renameChapterBreak",
        (story) => {
          const current = story.chapterBreaks.find(
            (chapterBreak) => chapterBreak.id === breakId
          );
          const unchanged = current?.title === title;
          renameChapterBreak(story, breakId, title);
          return unchanged ? STORY_UNCHANGED : undefined;
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { renameChapterBreak(story, breakId, title); }
    ));
  }

  async deleteChapterBreak(
    id: string,
    breakId: string,
    mutationRequest?: unknown,
    expectedRemoved?: RemovedChapterBreak
  ): Promise<{ payload: StoryPayload; removed: RemovedChapterBreak }> {
    this.dependencies.ensureOpen();
    let removed: RemovedChapterBreak | undefined;
    if (mutationRequest !== undefined) {
      if (expectedRemoved === undefined) {
        throw new ServiceError(
          500,
          "Receipt-backed chapter removal requires its deterministic undo payload",
          "internal"
        );
      }
      const committed = await this.dependencies.storyMutations.runLocal(
        mutationRequest,
        "removeChapterBreak",
        (story) => {
          const actual = removeChapterBreak(story, breakId);
          if (chapterBreakRemovalFingerprint(actual)
            !== chapterBreakRemovalFingerprint(expectedRemoved)) {
            throw new ServiceError(
              409,
              "Chapter-break removal input no longer matches the aggregate.",
              "conflict"
            );
          }
          return actual;
        },
        () => expectedRemoved
      );
      return {
        payload: payloadFromCommit(committed),
        removed: committed.value
      };
    }
    const story = await this.dependencies.stories.mutate(
      id,
      (fresh) => { removed = removeChapterBreak(fresh, breakId); }
    );
    if (removed === undefined) {
      throw new ServiceError(
        500,
        "Chapter-break removal lost its result",
        "internal"
      );
    }
    return { payload: buildStoryPayload(story), removed };
  }

  async restoreChapterBreak(
    id: string,
    breakId: string,
    value: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    const removed = parseRemovedChapterBreak(value);
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "restoreChapterBreak",
        (story) => { restoreChapterBreak(story, breakId, removed); }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { restoreChapterBreak(story, breakId, removed); }
    ));
  }

  async previewChapterBreakRemoval(id: string, breakId: string) {
    this.dependencies.ensureOpen();
    return await this.dependencies.stories.withAggregateSession(
      id,
      async (session) => {
        const removed = removeChapterBreak(
          await session.loadLive(),
          breakId
        );
        return {
          removed,
          removedFingerprint: chapterBreakRemovalFingerprint(removed),
          aggregateVersion: session.snapshot.storageKind === "v5"
            ? {
              kind: "v5" as const,
              manifestHash: session.snapshot.manifestHash
            }
            : {
              kind: "v6" as const,
              revision: session.snapshot.manifest.revision
            }
        };
      }
    );
  }

  private async localStoryPayload(
    mutationRequest: unknown,
    method: LocalStoryMutationMethod,
    mutate: (
      story: Story,
      session: StoryAggregateSession
    ) => void | typeof STORY_UNCHANGED
      | Promise<void | typeof STORY_UNCHANGED>
  ): Promise<StoryPayload> {
    const committed = await this.dependencies.storyMutations.runLocal(
      mutationRequest,
      method,
      mutate
    );
    return buildStoryPayload(committed.story, {
      ...committed.aggregateVersion
    });
  }
}

function payloadFromCommit(
  committed: Awaited<ReturnType<StoryMutationStore["runLocal"]>>
): StoryPayload {
  return buildStoryPayload(committed.story, {
    ...committed.aggregateVersion
  });
}

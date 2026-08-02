import { activePath } from "../shared/story-tree.js";
import { activeLineFingerprintSource } from "../shared/story-text.js";
import type { Story, StoryPayload } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import { currentModel } from "./generation-http.js";
import { DEFAULT_INSTRUCTION } from "./generation-prompts.js";
import type { GenerationAdmissionRegistry } from "./generation-admission.js";
import { commitNode } from "./node-commit.js";
import {
  parseCreateNode,
  parseEditNode,
  parsePruneUnusedTakes,
  parseSwitchOptions,
  parseTakeFromCut
} from "./service-input.js";
import type { SettingsStore } from "./settings.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import { putStoryTag, removeStoryTag } from "./story-tags.js";
import { createFacts, deleteFact, patchFact } from "./story-facts.js";
import { setAuthorsNote } from "./story-authors-note.js";
import { resolveAuthorsNoteDepth } from "../shared/authors-note.js";
import { setAuthorBrief } from "./story-author-brief.js";
import { HASH_PATTERN, sha256 } from "./story-format.js";
import type {
  LocalStoryMutationMethod,
  StoryMutationStore
} from "./story-mutation-store.js";
import {
  applyHumanEdit,
  commitTake,
  createEditedTake,
  createTakeFromCut,
  deleteSubtree,
  pruneUnusedTakes as pruneUnusedStoryTakes,
  switchLine as switchTreeLine
} from "./story-nodes.js";
import { buildStoryPayload } from "./story-payload.js";
import { STORY_UNCHANGED, type StoryStore } from "./stories.js";

export interface StoryServiceLocalDependencies {
  readonly stories: StoryStore;
  readonly settings: SettingsStore;
  readonly generationAdmission: GenerationAdmissionRegistry;
  readonly storyMutations: StoryMutationStore;
  readonly dataFormat: () => number;
  readonly ensureOpen: () => void;
}

/** Direct-author story commands, including their successor-Q adapters. */
export class StoryServiceLocal {
  constructor(private readonly dependencies: StoryServiceLocalDependencies) {}

  async renameStory(
    id: string,
    title: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    const normalized = title.trim();
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "renameStory",
        (story) => {
          if (story.title === normalized) return STORY_UNCHANGED;
          story.title = normalized;
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { story.title = normalized; }
    ));
  }

  async setAuthorsNote(
    id: string,
    note: string,
    depth?: number,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (this.dependencies.dataFormat() < 4) {
      throw new ServiceError(
        409,
        "Setting an Author's Note requires a project on data format 4; this directory is not upgraded.",
        "data_directory_version_unsupported"
      );
    }
    const normalized = note.trim().length === 0 ? "" : note;
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "setAuthorsNote",
        (story) => {
          // Clearing an already-clear note is unchanged regardless of the
          // requested depth: a clear ignores depth, so nothing net changes.
          if (normalized === "" && (story.authorsNote ?? "") === "") return STORY_UNCHANGED;
          const depthUnchanged = depth === undefined
            || resolveAuthorsNoteDepth(story.authorsNoteDepth) === depth;
          if ((story.authorsNote ?? "") === normalized && depthUnchanged) return STORY_UNCHANGED;
          setAuthorsNote(story, normalized, depth);
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { setAuthorsNote(story, normalized, depth); }
    ));
  }

  async setAuthorBrief(
    id: string,
    brief: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (this.dependencies.dataFormat() < 4) {
      throw new ServiceError(
        409,
        "Setting an Author Brief requires a project on data format 4; this directory is not upgraded.",
        "data_directory_version_unsupported"
      );
    }
    const normalized = brief.trim().length === 0 ? "" : brief;
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "setAuthorBrief",
        (story) => {
          if ((story.authorBrief ?? "") === normalized) return STORY_UNCHANGED;
          setAuthorBrief(story, normalized);
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => { setAuthorBrief(story, normalized); }
    ));
  }

  async switchLine(
    id: string,
    nodeId: string,
    value: unknown = {},
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    const options = parseSwitchOptions(value);
    if (options.expectedLineFingerprint !== undefined
      && !HASH_PATTERN.test(options.expectedLineFingerprint)) {
      throw new ServiceError(400, "Invalid expected line fingerprint");
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "switchLine",
        (story) => {
          if (options.expectedLineFingerprint !== undefined
            && sha256(activeLineFingerprintSource(story.title, activePath(story)))
              !== options.expectedLineFingerprint) return STORY_UNCHANGED;
          return switchTreeLine(story, nodeId, options)
            ? undefined
            : STORY_UNCHANGED;
        }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.switchLine(id, nodeId, options)
    );
  }

  async createNode(
    id: string,
    value: unknown,
    nodeId?: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    const body = parseCreateNode(value);
    if (mutationRequest !== undefined) {
      const rawText = body.text;
      if (rawText.trim().length === 0) {
        throw new ServiceError(400, "Nothing to save");
      }
      const genId = body.genId ?? null;
      const providedInstruction = body.instruction ?? "";
      const instruction = genId === null
        ? providedInstruction
        : providedInstruction.trim() || DEFAULT_INSTRUCTION;
      const model = genId === null
        ? "human"
        : this.dependencies.generationAdmission.modelFor(id, genId)
          ?? await currentModel(this.dependencies.settings);
      return await this.localStoryPayload(
        mutationRequest,
        "createNode",
        async (story, session) => {
          if (nodeId !== undefined
            && story.nodes.some((node) => node.id === nodeId)) {
            return STORY_UNCHANGED;
          }
          if (body.sourceNodeId !== undefined) {
            await session.hydratePath(story, body.sourceNodeId);
            createEditedTake(
              story,
              body.sourceNodeId,
              body.expectedTextHash,
              instruction,
              rawText.trim(),
              nodeId
            );
            return;
          }
          const requestedAppendTo = body.appendTo ?? null;
          const appendCrossesBreak = requestedAppendTo !== null
            && story.chapterBreaks.some(
              (chapterBreak) => chapterBreak.parentPartId === requestedAppendTo
            );
          const appendTo = appendCrossesBreak ? null : requestedAppendTo;
          if (appendTo !== null) await session.hydratePath(story, appendTo);
          const commit = commitTake(story, {
            parentId: appendCrossesBreak
              ? requestedAppendTo
              : appendTo === null ? body.parentId ?? null : null,
            appendTo,
            expectedTextHash: appendTo !== null && body.appendTo !== undefined
              ? body.expectedTextHash
              : null,
            instruction,
            text: appendTo === null ? rawText.trim() : rawText,
            model,
            genId,
            ...(nodeId === undefined ? {} : { nodeId })
          });
          return commit.duplicate ? STORY_UNCHANGED : undefined;
        }
      );
    }
    return buildStoryPayload(await commitNode(
      this.dependencies.stories,
      this.dependencies.settings,
      this.dependencies.generationAdmission,
      id,
      body,
      nodeId
    ));
  }

  async editNode(
    id: string,
    nodeId: string,
    value: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    const edit = parseEditNode(value);
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "editNode",
        async (story, session) => {
          await session.hydratePath(story, nodeId);
          const node = story.nodes.find((candidate) => candidate.id === nodeId);
          const unchanged = node !== undefined
            && (edit.text === undefined || edit.text === node.text)
            && (edit.instruction === undefined
              || edit.instruction === node.instruction);
          applyHumanEdit(story, nodeId, edit);
          return unchanged ? STORY_UNCHANGED : undefined;
        }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.editNode(id, nodeId, edit)
    );
  }

  async deleteNode(
    id: string,
    nodeId: string,
    expectedSubtreeCount: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (typeof expectedSubtreeCount !== "number"
      || !Number.isSafeInteger(expectedSubtreeCount)) {
      throw new ServiceError(400, "expectedSubtreeCount must be an integer");
    }
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "deleteNode",
        (story) => { deleteSubtree(story, nodeId, expectedSubtreeCount); }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.deleteNode(
      id,
      nodeId,
      expectedSubtreeCount
    ));
  }

  async pruneUnusedTakes(
    id: string,
    value: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    const expected = parsePruneUnusedTakes(value);
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "pruneUnusedTakes",
        (story) => pruneUnusedStoryTakes(story, expected) === 0
          ? STORY_UNCHANGED
          : undefined
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.pruneUnusedTakes(id, expected)
    );
  }

  async takeFromCut(
    id: string,
    nodeId: string,
    value: unknown,
    takeId?: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    const body = parseTakeFromCut(value);
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "takeFromCut",
        async (story, session) => {
          if (takeId !== undefined
            && story.nodes.some((node) => node.id === takeId)) {
            return STORY_UNCHANGED;
          }
          await session.hydratePath(story, nodeId);
          createTakeFromCut(
            story,
            nodeId,
            body.offset,
            body.expected ?? null,
            takeId
          );
        }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.createTakeFromCut(
        id,
        nodeId,
        body.offset,
        body.expected ?? null,
        takeId
      )
    );
  }

  async putBookmark(
    id: string,
    nodeId: string,
    name: string,
    label: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "putBookmark",
        (story) => {
          const existing = story.tags.find(
            (tag) => tag.nodeId === nodeId
          );
          const unchanged = existing?.name === name
            && existing.status === label
            && (label !== "Canon" || story.tags.every(
              (tag) => tag.nodeId === nodeId
                || tag.status !== "Canon"
            ));
          putStoryTag(story, nodeId, name, label);
          return unchanged ? STORY_UNCHANGED : undefined;
        }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.setTag(id, nodeId, name, label)
    );
  }

  async deleteBookmark(
    id: string,
    nodeId: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "deleteBookmark",
        (story) => { removeStoryTag(story, nodeId); }
      );
    }
    return buildStoryPayload(
      await this.dependencies.stories.deleteBookmark(id, nodeId)
    );
  }

  async createFact(
    id: string,
    body: unknown,
    factId?: (index: number) => string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "createFact",
        (story) => {
          return createFacts(
            story,
            body,
            (index) => factId?.(index) ?? crypto.randomUUID()
          ) ? undefined : STORY_UNCHANGED;
        }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => createFacts(
        story,
        body,
        (index) => factId?.(index) ?? crypto.randomUUID()
      )
        ? undefined
        : STORY_UNCHANGED
    ));
  }

  async patchFact(
    id: string,
    factId: string,
    body: unknown,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "patchFact",
        (story) => { patchFact(story, factId, body); }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => patchFact(story, factId, body)
    ));
  }

  async deleteFact(
    id: string,
    factId: string,
    mutationRequest?: unknown
  ): Promise<StoryPayload> {
    this.dependencies.ensureOpen();
    if (mutationRequest !== undefined) {
      return await this.localStoryPayload(
        mutationRequest,
        "deleteFact",
        (story) => { deleteFact(story, factId); }
      );
    }
    return buildStoryPayload(await this.dependencies.stories.mutate(
      id,
      (story) => deleteFact(story, factId)
    ));
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

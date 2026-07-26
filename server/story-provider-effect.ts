import { deriveChapters, summaryNodeInstruction } from "../shared/chapters.js";
import { activePath, nodeById } from "../shared/story-tree.js";
import type { Story, StoryNode } from "../shared/types.js";
import { GenerationResultError, ServiceError } from "./errors.js";
import { sha256 } from "./story-format.js";
import { setStoryAutonameId } from "./story-metadata.js";
import { setNodeRewriteId } from "./story-node-text.js";
import {
  appendContinuationToNode,
  commitTake,
  createInactiveTakeFromCut,
  createTake,
  hasCommittedGeneration,
  newNode,
  titleFrom,
  type TakeCommit
} from "./story-nodes.js";
import {
  requireSummaryActive,
  summarizedPath,
  summarySourceFingerprint,
  type SummaryCommitIds,
  type SummaryPoint
} from "./summary-take.js";

export interface AutonameStoryEffect {
  readonly kind: "autoname";
  readonly expectedTitle: string;
  readonly title: string;
  readonly autonameId?: string;
}

export interface ContinueStoryEffect extends TakeCommit {
  readonly kind: "continue";
  readonly expectedParentActiveChildId: string | null;
  readonly expectedAppendActiveChildId: string | null;
  readonly expectedActiveRootId: string | null;
  readonly expectedActiveLeafId: string | null;
  readonly cancelled?: AbortSignal;
}

export interface RewriteNodeEffect {
  readonly kind: "rewrite";
  readonly nodeId: string;
  readonly expectedText: string;
  readonly expectedInstruction: string;
  readonly expectedUpdatedAt?: string;
  readonly text: string;
  readonly attribution?: StoryNode["attribution"];
  readonly updatedAt: string;
  readonly rewriteId?: string;
  readonly cancelled?: AbortSignal;
}

export interface SummaryTakeEffect {
  readonly kind: "summary-take";
  readonly point: SummaryPoint;
  readonly expected: string | null;
  readonly sourceFingerprint: string;
  readonly summary: string;
  readonly model: string;
  readonly instruction: string;
  readonly commitIds: SummaryCommitIds;
  readonly committedAt?: string;
  readonly cancelled?: AbortSignal;
}

export interface ChapterSummaryEffect {
  readonly kind: "chapter-summary";
  readonly breakId: string;
  readonly sourceFingerprint: string;
  readonly summary: string;
  readonly model: string;
  readonly summaryNodeId?: string;
  readonly rewriteId?: string;
  readonly committedAt?: string;
  readonly cancelled?: AbortSignal;
}

export type ProviderStoryEffect =
  | AutonameStoryEffect
  | ContinueStoryEffect
  | RewriteNodeEffect
  | SummaryTakeEffect
  | ChapterSummaryEffect;

export interface ProviderStoryEffectByMethod {
  readonly autonameStory: AutonameStoryEffect;
  readonly summarizeChapter: ChapterSummaryEffect;
  readonly continueStory: ContinueStoryEffect;
  readonly rewriteNode: RewriteNodeEffect;
  readonly createSummaryTake: SummaryTakeEffect;
}

type ProviderStoryEffectValueForKind<
  Kind extends ProviderStoryEffect["kind"]
> = Kind extends "autoname" | "continue" | "chapter-summary"
    ? Story
    : Kind extends "rewrite"
      ? boolean
      : Kind extends "summary-take"
        ? StoryNode
        : never;

export type ProviderStoryEffectValue<Effect extends ProviderStoryEffect> =
  ProviderStoryEffectValueForKind<Effect["kind"]>;

export interface AppliedProviderStoryEffect<Value = Story | StoryNode | boolean> {
  readonly changed: boolean;
  readonly value: Value;
}

export type HydrateProviderPath = (
  story: Story,
  nodeId: string
) => Promise<void>;

/**
 * Apply one provider result to the story that is current at commit time.
 *
 * Effects name the operation, its source guard, and its provider-owned output.
 * They deliberately do not describe a generic Story diff: fields outside the
 * operation remain current automatically, including fields added in the future.
 */
export function applyProviderStoryEffect<Effect extends ProviderStoryEffect>(
  story: Story,
  effect: Effect,
  hydratePath: HydrateProviderPath
): Promise<
  AppliedProviderStoryEffect<ProviderStoryEffectValue<Effect>>
>;
export async function applyProviderStoryEffect(
  story: Story,
  effect: ProviderStoryEffect,
  hydratePath: HydrateProviderPath
): Promise<AppliedProviderStoryEffect> {
  switch (effect.kind) {
    case "autoname":
      return applyAutoname(story, effect);
    case "continue":
      return await applyContinuation(story, effect, hydratePath);
    case "rewrite":
      return await applyRewrite(story, effect, hydratePath);
    case "summary-take":
      return await applySummaryTake(story, effect, hydratePath);
    case "chapter-summary":
      return applyChapterSummary(story, effect);
    default: {
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}

function applyAutoname(
  story: Story,
  effect: AutonameStoryEffect
): AppliedProviderStoryEffect<Story> {
  if (story.title !== effect.expectedTitle) {
    throw new GenerationResultError(
      409,
      "The story title changed while the model was naming it. Try again if you still want a new name."
    );
  }
  story.title = effect.title;
  setStoryAutonameId(story, effect.autonameId);
  return { changed: true, value: story };
}

async function applyContinuation(
  story: Story,
  effect: ContinueStoryEffect,
  hydratePath: HydrateProviderPath
): Promise<AppliedProviderStoryEffect<Story>> {
  requireNotCancelled(effect.cancelled, "Story writing was cancelled");
  if (effect.appendTo !== null) {
    if (nodeById(story, effect.appendTo) === null) {
      throw new GenerationResultError(
        409,
        "The node being continued was deleted while writing; nothing was saved."
      );
    }
    await hydratePath(story, effect.appendTo);
    requireNotCancelled(effect.cancelled, "Story writing was cancelled");
  }
  if (effect.genId !== null && hasCommittedGeneration(story, effect.genId)) {
    return { changed: false, value: story };
  }
  if (effect.appendTo === null
    && effect.parentId !== null
    && nodeById(story, effect.parentId) === null) {
    throw new GenerationResultError(
      409,
      "The parent node was deleted while writing; nothing was saved."
    );
  }
  const appendCrossesNewBreak = effect.appendTo !== null
    && story.chapterBreaks.some(
      (chapterBreak) => chapterBreak.parentPartId === effect.appendTo
    );
  const commit = {
    ...effect,
    parentId: appendCrossesNewBreak ? effect.appendTo : effect.parentId,
    appendTo: appendCrossesNewBreak ? null : effect.appendTo,
    expectedTextHash: appendCrossesNewBreak
      ? null
      : effect.expectedTextHash
  };
  const parent = commit.parentId === null
    ? null
    : nodeById(story, commit.parentId);
  const appendTarget = commit.appendTo === null
    ? null
    : nodeById(story, commit.appendTo);
  const appendWriterMoved = appendTarget !== null
    && activePath(story).at(-1)?.id !== appendTarget.id;
  const currentActiveLeafId = activePath(story).at(-1)?.id ?? null;
  const writerMoved = commit.appendTo === null && (
    story.activeRootId !== effect.expectedActiveRootId
    || currentActiveLeafId !== effect.expectedActiveLeafId
    || (parent !== null && parent.activeChildId !== (
      appendCrossesNewBreak
        ? effect.expectedAppendActiveChildId
        : effect.expectedParentActiveChildId
    ))
  );
  try {
    if (appendWriterMoved) {
      if (commit.expectedTextHash === null) {
        throw new Error("appendTo requires expectedTextHash");
      }
      appendContinuationToNode(
        appendTarget,
        commit.expectedTextHash,
        commit.text,
        commit.model,
        commit.genId ?? undefined,
        commit.committedAt
      );
    } else if (writerMoved) {
      const added = newNode(
        commit.parentId,
        commit.instruction,
        commit.text,
        commit.model,
        {
          ...(commit.nodeId === undefined ? {} : { id: commit.nodeId }),
          ...(commit.genId === null
            ? { human: true as const }
            : { genId: commit.genId })
        }
      );
      if (commit.committedAt !== undefined) {
        added.createdAt = commit.committedAt;
      }
      createTake(story, added, { activate: false });
      if (story.nodes.length === 1 && story.title === "Untitled") {
        story.title = titleFrom(
          commit.genId === null ? added.text : commit.instruction
        );
      }
    } else {
      commitTake(story, commit);
    }
  } catch (error) {
    throw new GenerationResultError(
      409,
      error instanceof Error
        ? error.message
        : "The story changed while writing; nothing was saved."
    );
  }
  return { changed: true, value: story };
}

async function applyRewrite(
  story: Story,
  effect: RewriteNodeEffect,
  hydratePath: HydrateProviderPath
): Promise<AppliedProviderStoryEffect<boolean>> {
  requireNotCancelled(effect.cancelled, "Story rewriting was cancelled");
  const target = nodeById(story, effect.nodeId);
  if (target === null) {
    throw new GenerationResultError(
      409,
      "The node changed while rewriting; nothing was saved."
    );
  }
  await hydratePath(story, effect.nodeId);
  requireNotCancelled(effect.cancelled, "Story rewriting was cancelled");
  if (target.text !== effect.expectedText
    || target.instruction !== effect.expectedInstruction
    || target.updatedAt !== effect.expectedUpdatedAt) {
    throw new GenerationResultError(
      409,
      "The node changed while rewriting; nothing was saved."
    );
  }
  target.text = effect.text;
  target.attribution = effect.attribution;
  target.updatedAt = effect.updatedAt;
  setNodeRewriteId(target, effect.rewriteId);
  return { changed: true, value: true };
}

async function applySummaryTake(
  story: Story,
  effect: SummaryTakeEffect,
  hydratePath: HydrateProviderPath
): Promise<AppliedProviderStoryEffect<StoryNode>> {
  const existing = effect.commitIds.summaryNodeId === undefined
    ? undefined
    : story.nodes.find((node) => node.id === effect.commitIds.summaryNodeId);
  if (existing !== undefined) return { changed: false, value: existing };
  if (nodeById(story, effect.point.nodeId) === null) {
    throw new GenerationResultError(
      409,
      "The story changed while its summary was being written. Try again."
    );
  }
  requireSummaryActive(effect.cancelled);
  await hydratePath(story, effect.point.nodeId);
  requireSummaryActive(effect.cancelled);
  const prefix = summarizedPath(story, effect.point, effect.expected);
  if (summarySourceFingerprint(story.title, prefix, effect.point)
    !== effect.sourceFingerprint) {
    throw new GenerationResultError(
      409,
      "The story changed while its summary was being written. Try again."
    );
  }
  let parentId = effect.point.nodeId;
  if (effect.point.offset !== null) {
    const cut = createInactiveTakeFromCut(
      story,
      effect.point.nodeId,
      effect.point.offset,
      effect.expected,
      effect.commitIds.cutNodeId
    );
    if (effect.committedAt !== undefined) cut.createdAt = effect.committedAt;
    parentId = cut.id;
  }
  const node = newNode(
    parentId,
    effect.instruction,
    effect.summary,
    effect.model,
    {
      role: "summary",
      ...(effect.commitIds.summaryNodeId === undefined
        ? {}
        : { id: effect.commitIds.summaryNodeId })
    }
  );
  if (effect.committedAt !== undefined) node.createdAt = effect.committedAt;
  createTake(story, node, { activate: false });
  return { changed: true, value: node };
}

function applyChapterSummary(
  story: Story,
  effect: ChapterSummaryEffect
): AppliedProviderStoryEffect<Story> {
  requireNotCancelled(effect.cancelled, "Chapter summarization was cancelled");
  let chapter: ReturnType<typeof chapterSummarySource>;
  try {
    chapter = chapterSummarySource(story, effect.breakId);
  } catch (error) {
    if (error instanceof ServiceError) {
      throw new GenerationResultError(error.status, error.message);
    }
    throw error;
  }
  if (chapterSourceFingerprint(story, effect.breakId)
    !== effect.sourceFingerprint) {
    throw new GenerationResultError(
      409,
      "The chapter changed while its summary was being written. Try again."
    );
  }
  const extent = chapter.extent!;
  const madeAt = effect.committedAt ?? new Date().toISOString();
  const instruction = summaryNodeInstruction(story.title);
  if (chapter.summary === null) {
    const node = newNode(
      extent.toPartId,
      instruction,
      effect.summary,
      effect.model,
      {
        id: effect.summaryNodeId,
        role: "summary",
        chapterBreakId: effect.breakId,
        coveredExtent: { ...extent },
        madeAt
      }
    );
    node.createdAt = madeAt;
    setNodeRewriteId(node, effect.rewriteId);
    createTake(story, node, { activate: false });
  } else {
    chapter.summary.text = effect.summary;
    setNodeRewriteId(chapter.summary, effect.rewriteId);
    chapter.summary.instruction = instruction;
    chapter.summary.model = effect.model;
    chapter.summary.updatedAt = madeAt;
    chapter.summary.madeAt = madeAt;
    chapter.summary.coveredExtent = { ...extent };
    delete chapter.summary.editedByUser;
    delete chapter.summary.attribution;
  }
  return { changed: true, value: story };
}

export function chapterSourceFingerprint(story: Story, breakId: string): string {
  const chapter = chapterSummarySource(story, breakId);
  return sha256(JSON.stringify({
    title: story.title,
    breakId: chapter.closedBy?.id,
    extent: chapter.extent,
    summary: chapter.summary === null ? null : {
      id: chapter.summary.id,
      text: chapter.summary.text,
      madeAt: chapter.summary.madeAt,
      editedByUser: chapter.summary.editedByUser
    },
    parts: chapter.parts.map((part) => ({
      id: part.id,
      text: part.text,
      instruction: part.instruction,
      updatedAt: part.updatedAt
    }))
  }));
}

export function chapterSummarySource(story: Story, breakId: string) {
  const chapter = deriveChapters(
    activePath(story),
    story.chapterBreaks,
    story.nodes
  ).find((candidate) => candidate.closedBy?.id === breakId);
  if (chapter === undefined) {
    throw new ServiceError(
      409,
      "The chapter break is not on the active storyline"
    );
  }
  if (chapter.closedBy === null || chapter.extent === null) {
    throw new ServiceError(409, "The current chapter cannot be summarized");
  }
  return chapter;
}

function requireNotCancelled(
  signal: AbortSignal | undefined,
  message: string
): void {
  if (signal?.aborted === true) {
    throw new GenerationResultError(409, message);
  }
}

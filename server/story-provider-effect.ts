import { deriveChapters, summaryNodeInstruction } from "../shared/chapters.js";
import { activePath, isChapterSummary, nodeById } from "../shared/story-tree.js";
import { resolveRewriteDestination, type RewriteDestination, type Story, type StoryNode } from "../shared/types.js";
import type { CapturedTokenProbabilities } from "../shared/token-probabilities.js";
import type { GenerationRecord } from "../shared/generation-record.js";
import type { CapturedReasoning } from "../shared/reasoning.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import {
  GenerationResultError,
  GenerationStoppedError,
  ServiceError
} from "./errors.js";
import { sha256 } from "./story-format.js";
import { setStoryAutonameId } from "./story-metadata.js";
import { nodeRewriteId, setNodeRewriteId } from "./story-node-text.js";
import { appendPendingGenerationRecord } from "./story-node-generation-records.js";
import { generationRecordRetargetedToNewTake, generationRecordSettledInPlace } from "./generation-record-finalize.js";
import { attachTakeTokenProbabilities } from "./story-node-token-probabilities.js";
import { attachTakeReasoning, clearTakeReasoning } from "./story-node-reasoning.js";
import {
  appendContinuationToNode,
  assertNoAppendImageAttachments,
  attachTakeImageAttachments,
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
import { serializeAsideDocument, type AsideDocument } from "../shared/aside.js";
import { setPendingAsideDocument } from "./story-aside-pending.js";

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
  /** Captured by the stream when the profile asked for token probabilities
   *  and the provider returned usable ones; null or absent otherwise. Both a
   *  genuinely new take and an append store it, aligned to whatever text
   *  this commit actually stores — see TakeCommit.tokenProbabilities.
   *  Optional so callers unconcerned with this feature (tests, other commit
   *  sources) need not think about it; the one production construction site,
   *  `continueStory` in server/generation-http.ts, always supplies it. */
  readonly tokenProbabilities?: CapturedTokenProbabilities | null;
  /** Captured by the stream when a thought arrived and retention allowed
   *  storing it; null or absent otherwise. Both a genuinely new take and an
   *  append attach it, unaligned — see TakeCommit.reasoning and
   *  server/story-node-reasoning.ts. */
  readonly reasoning?: CapturedReasoning | null;
  /** Only ever set by a continuation commit that resolved Image Attachments
   *  for the take being generated. See `TakeCommit.imageAttachments`
   *  (server/story-nodes.ts) for the append restriction this must honor. */
  readonly imageAttachments?: readonly StoryImageAttachment[] | null;
  readonly cancelled?: AbortSignal;
  /** Narrows `TakeCommit.generationRecord` from optional to required: every
   *  successful continuation is a provider effect, and a provider effect
   *  must carry a Generation Record — complete or an explicit `unsupported`
   *  stand-in, never absent. `TakeCommit` itself stays optional because it
   *  also backs genuinely human/legacy commit paths (a human take, a
   *  stop-and-save settle with no captured handoff, starter-vault seeding)
   *  that have no generation to record at all. */
  readonly generationRecord: GenerationRecord;
}

export interface RewriteNodeEffect {
  readonly kind: "rewrite";
  readonly nodeId: string;
  readonly expectedText: string;
  readonly expectedInstruction: string;
  readonly expectedUpdatedAt?: string;
  readonly text: string;
  readonly attribution?: StoryNode["attribution"];
  readonly rewrittenSpans?: StoryNode["rewrittenSpans"];
  readonly updatedAt: string;
  readonly rewriteId?: string;
  /** The new take's id. Deterministic when the caller supplies one (worker
   *  mutations always do), so `story.nodes.some(n => n.id === takeId)` is a
   *  committed marker exactly like `SummaryTakeEffect.commitIds.summaryNodeId`.
   *  Only minted into the tree when `destination` resolves to "take". */
  readonly takeId?: string;
  /** Absent resolves to "in-place" — see `resolveRewriteDestination`. A
   *  chapter summary overrides this to "in-place" regardless (see below). */
  readonly destination?: RewriteDestination;
  /** Captured by the stream when this rewrite attempt produced a thought and
   *  retention allowed storing it; null or absent otherwise. An in-place
   *  rewrite that captures none clears whatever thought the target node had
   *  before — see `clearTakeReasoning` in server/story-node-reasoning.ts for
   *  why a stale thought must not survive replaced text. A take-destination
   *  rewrite mints a fresh node, so there is nothing to clear either way. */
  readonly reasoning?: CapturedReasoning | null;
  readonly cancelled?: AbortSignal;
  /** Every successful rewrite is a provider effect and must carry a
   *  Generation Record — see ContinueStoryEffect.generationRecord. */
  readonly generationRecord: GenerationRecord;
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
  /** Captured by the stream when the summary attempt produced a thought and
   *  retention allowed storing it; null or absent otherwise. */
  readonly reasoning?: CapturedReasoning | null;
  readonly cancelled?: AbortSignal;
  /** Every successful summary take is a provider effect and must carry a
   *  Generation Record — see ContinueStoryEffect.generationRecord. */
  readonly generationRecord: GenerationRecord;
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
  /** Every successful chapter summary is a provider effect and must carry a
   *  Generation Record — see ContinueStoryEffect.generationRecord. */
  readonly generationRecord: GenerationRecord;
}

export interface AsideStoryEffect {
  readonly kind: "aside";
  /** Aside object ID observed before provider dispatch. */
  readonly expectedAsideDocumentId: Story["asideDocumentId"];
  readonly document: AsideDocument;
  readonly cancelled?: AbortSignal;
}

export type ProviderStoryEffect =
  | AutonameStoryEffect
  | ContinueStoryEffect
  | RewriteNodeEffect
  | SummaryTakeEffect
  | ChapterSummaryEffect
  | AsideStoryEffect;

export interface ProviderStoryEffectByMethod {
  readonly autonameStory: AutonameStoryEffect;
  readonly summarizeChapter: ChapterSummaryEffect;
  readonly continueStory: ContinueStoryEffect;
  readonly rewriteNode: RewriteNodeEffect;
  readonly createSummaryTake: SummaryTakeEffect;
  readonly askAside: AsideStoryEffect;
}

type ProviderStoryEffectValueForKind<
  Kind extends ProviderStoryEffect["kind"]
> = Kind extends "autoname" | "continue" | "chapter-summary" | "aside"
    ? Story
    : Kind extends "rewrite" | "summary-take"
      ? StoryNode
      : never;

export type ProviderStoryEffectValue<Effect extends ProviderStoryEffect> =
  ProviderStoryEffectValueForKind<Effect["kind"]>;

export interface AppliedProviderStoryEffect<Value = Story | StoryNode> {
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
    case "aside":
      return applyAside(story, effect);
    default: {
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}

function applyAside(
  story: Story,
  effect: AsideStoryEffect
): AppliedProviderStoryEffect<Story> {
  if (effect.cancelled?.aborted === true) {
    throw new GenerationStoppedError("Aside was cancelled before it could be saved.");
  }
  if (story.asideDocumentId !== effect.expectedAsideDocumentId) {
    throw new GenerationResultError(
      409,
      "Side Notes changed while the answer was being written; nothing was saved. Try again."
    );
  }
  story.asideDocumentId = sha256(serializeAsideDocument(effect.document));
  setPendingAsideDocument(story, effect.document);
  return { changed: true, value: story };
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
      : effect.expectedTextHash,
    // Normalize null to absent here, once, so every branch below reads a
    // plain TakeCommit. Every branch — append or new take, racing or not —
    // now forwards this field; see TakeCommit.tokenProbabilities.
    tokenProbabilities: effect.tokenProbabilities ?? undefined,
    generationRecord: appendCrossesNewBreak
      ? generationRecordRetargetedToNewTake(effect.generationRecord)
      : effect.generationRecord,
    // Same normalization, for the same reason; see TakeCommit.reasoning.
    reasoning: effect.reasoning ?? undefined,
    // Same normalization, for the same reason; see TakeCommit.imageAttachments.
    imageAttachments: effect.imageAttachments ?? undefined
  };
  assertNoAppendImageAttachments(commit);
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
      const node = appendContinuationToNode(
        appendTarget,
        commit.expectedTextHash,
        commit.text,
        commit.model,
        commit.genId ?? undefined,
        commit.committedAt,
        commit.tokenProbabilities,
        commit.reasoning
      );
      appendPendingGenerationRecord(node, commit.generationRecord);
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
      if (commit.tokenProbabilities !== undefined && commit.tokenProbabilities !== null) {
        attachTakeTokenProbabilities(added, commit.tokenProbabilities, commit.text, 0);
      }
      appendPendingGenerationRecord(added, commit.generationRecord);
      attachTakeReasoning(added, commit.reasoning);
      attachTakeImageAttachments(added, commit.imageAttachments);
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
): Promise<AppliedProviderStoryEffect<StoryNode>> {
  requireNotCancelled(effect.cancelled, "Story rewriting was cancelled");
  const requested = resolveRewriteDestination(effect.destination);
  const target = nodeById(story, effect.nodeId);
  // A chapter summary is a dead end (`createTake` refuses a chapter-summary
  // parent) and `createEditedTake` already refuses to sibling one, so it
  // always replaces in place, no matter which destination was requested.
  // Keep this the one place that decides it — nowhere else re-checks
  // `isChapterSummary` for a rewrite.
  const inPlace = requested !== "take" || (target !== null && isChapterSummary(target));
  if (inPlace) {
    // In place mode mints no new node, so there is nothing for a replay to
    // find in `story.nodes` — the marker is `rewriteId` stamped on the
    // target instead, the same idea take mode's `takeId` presence serves
    // below. This is the branch a review once called unreachable and #310
    // removed; it is reachable again now that in-place is possible.
    if (target !== null && effect.rewriteId !== undefined && nodeRewriteId(target) === effect.rewriteId) {
      return { changed: false, value: target };
    }
  } else if (effect.takeId !== undefined) {
    const existing = story.nodes.find((candidate) => candidate.id === effect.takeId);
    if (existing !== undefined) return { changed: false, value: existing };
  }
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
  if (inPlace) {
    target.text = effect.text;
    target.attribution = effect.attribution;
    target.rewrittenSpans = effect.rewrittenSpans;
    target.updatedAt = effect.updatedAt;
    setNodeRewriteId(target, effect.rewriteId);
    appendPendingGenerationRecord(target, generationRecordSettledInPlace(effect.generationRecord));
    // The replaced text invalidates whatever thought described the old text;
    // clear it before deciding whether this attempt produced a fresh one to
    // take its place (server/story-node-reasoning.ts).
    clearTakeReasoning(target);
    attachTakeReasoning(target, effect.reasoning);
    return { changed: true, value: target };
  }
  // Sibling of the source, same field-carrying decisions as
  // `createEditedTake` (server/story-nodes.ts): human and role travel,
  // chapter-summary-only fields travel defensively, generation identity and
  // descendants deliberately do not. `createTake` applies the retarget rule,
  // tag movement, and active-path switching unchanged.
  const node = newNode(target.parentId, target.instruction, effect.text, target.model, {
    ...(effect.takeId === undefined ? {} : { id: effect.takeId }),
    ...(target.human === true ? { human: true as const } : {}),
    ...(target.role === "summary" ? { role: target.role } : {}),
    ...(target.coveredExtent === undefined ? {} : { coveredExtent: { ...target.coveredExtent } }),
    ...(target.madeAt === undefined ? {} : { madeAt: target.madeAt })
  });
  node.createdAt = effect.updatedAt;
  node.attribution = effect.attribution;
  node.rewrittenSpans = effect.rewrittenSpans;
  setNodeRewriteId(node, effect.rewriteId);
  createTake(story, node);
  appendPendingGenerationRecord(node, effect.generationRecord);
  attachTakeReasoning(node, effect.reasoning);
  return { changed: true, value: node };
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
  appendPendingGenerationRecord(node, effect.generationRecord);
  attachTakeReasoning(node, effect.reasoning);
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
    appendPendingGenerationRecord(node, effect.generationRecord);
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
    appendPendingGenerationRecord(chapter.summary, effect.generationRecord);
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
    throw new GenerationStoppedError(message);
  }
}

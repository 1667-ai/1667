import { randomUUID } from "node:crypto";
import {
  activeLeaf,
  activePath,
  childrenOf,
  descendantLine,
  indexTree,
  isChapterSummary,
  nodeById,
  subtreeIds,
  switchToNode,
  unusedTakePruneSelection
} from "../shared/story-tree.js";
import { appendContinuationText } from "../shared/story-text.js";
import {
  MAX_STORY_LINE_COPY_PARTS,
  type CoveredExtent,
  type EditNodeRequest,
  type HumanEditAttribution,
  type PruneUnusedTakesRequest,
  type Story,
  type StoryNode
} from "../shared/types.js";
import type { CapturedTokenProbabilities } from "../shared/token-probabilities.js";
import type { GenerationRecord } from "../shared/generation-record.js";
import type { CapturedReasoning } from "../shared/reasoning.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import { sliceWellFormedUtf16Prefix } from "../shared/unicode.js";
import { ServiceError as HttpError } from "./errors.js";
import { attributionAfterHumanEdit, rewrittenSpansAfterHumanEdit } from "../shared/human-edit.js";
import { HASH_PATTERN, sha256 } from "./story-format.js";
import { setNodeRewriteId } from "./story-node-text.js";
import { appendPendingGenerationRecord } from "./story-node-generation-records.js";
import { attachTakeTokenProbabilities } from "./story-node-token-probabilities.js";
import { attachTakeReasoning } from "./story-node-reasoning.js";
import { reanchorPrunedAsideSessions } from "./aside-session-store.js";

export interface NewNodeOptions {
  id?: string;
  human?: true;
  role?: "summary";
  genId?: string;
  chapterBreakId?: string;
  coveredExtent?: CoveredExtent;
  madeAt?: string;
}

export function newNode(
  parentId: string | null,
  instruction: string,
  text: string,
  model: string,
  options: NewNodeOptions = {}
): StoryNode {
  const { id = randomUUID(), ...storedOptions } = options;
  return {
    id,
    parentId,
    instruction,
    text,
    model,
    createdAt: new Date().toISOString(),
    ...storedOptions,
    activeChildId: null
  };
}

export function requireNode(story: Story, nodeId: string): StoryNode {
  const node = nodeById(story, nodeId);
  if (node === null) throw new HttpError(404, `Node not found: ${nodeId}`);
  return node;
}

/** Plan 007 retarget rule — a commit never refuses because the line moved
 * while a model streamed. Parent still on the active path: the new take wins
 * the pointer and any earlier sibling survives as a browsable take. Parent no
 * longer active: silent non-active insert, the reader is never yanked. The
 * pre-tree refuse-on-branch-change contract died with branches. */
export function createTake(story: Story, node: StoryNode, options: { activate?: boolean } = {}): StoryNode {
  const parent = node.parentId === null ? null : requireNode(story, node.parentId);
  if (parent !== null && isChapterSummary(parent)) throw new HttpError(400, "A chapter summary is a dead end");
  const path = activePath(story);
  const retarget = options.activate !== false
    && (parent === null || path.some((candidate) => candidate.id === parent.id));
  const parentWasLineEnd = parent !== null && path.at(-1)?.id === parent.id;
  story.nodes.push(node);
  if (!retarget) return node;
  if (parent !== null && parentWasLineEnd) {
    const tag = story.tags.find((candidate) => candidate.nodeId === parent.id);
    if (tag !== undefined) tag.nodeId = node.id;
  }
  switchToNode(story, node.id);
  return node;
}

export function createTakeFromCut(
  story: Story,
  nodeId: string,
  offset: unknown,
  expected: string | null,
  newNodeId?: string
): StoryNode {
  const target = activePath(story).find((node) => node.id === nodeId);
  if (target === undefined) throw new HttpError(404, `Node not found on the active path: ${nodeId}`);
  return createCutTake(story, target, offset, expected, true, newNodeId);
}

/** Preserve a summary's exact selection boundary without changing the line the
 * reader may have switched to while the model streamed. */
export function createInactiveTakeFromCut(
  story: Story,
  nodeId: string,
  offset: unknown,
  expected: string | null,
  newNodeId?: string
): StoryNode {
  return createCutTake(story, requireNode(story, nodeId), offset, expected, false, newNodeId);
}

/** Copy a take into a sibling, then attribute only the prose changed by the
 * author. Generation identity and descendants belong to the source take and
 * are deliberately not copied. */
export function createEditedTake(
  story: Story,
  sourceNodeId: string,
  expectedTextHash: string,
  instruction: string,
  text: string,
  newNodeId?: string
): StoryNode {
  validateTextHash(expectedTextHash);
  const source = requireNode(story, sourceNodeId);
  if (sha256(source.text) !== expectedTextHash) {
    throw new HttpError(409, "The take changed while you were editing — reload and try again.");
  }
  if (isChapterSummary(source)) {
    throw new HttpError(400, "Chapter summaries must be edited in place.");
  }
  const node = newNode(source.parentId, instruction, text, source.model, {
    ...(newNodeId === undefined ? {} : { id: newNodeId }),
    ...(source.human === true ? { human: true as const } : {}),
    ...(source.role === "summary" ? { role: source.role } : {}),
    ...(source.coveredExtent === undefined ? {} : { coveredExtent: { ...source.coveredExtent } }),
    ...(source.madeAt === undefined ? {} : { madeAt: source.madeAt })
  });
  if (text !== source.text) {
    node.attribution = attributionAfterHumanEdit(source.attribution, source.text, text);
    // Writing over a rewritten span reclaims it as human, the same as an
    // in-place edit does (`applyHumanEdit` below) — a fork changes who wrote
    // the prose, not the rule for how that ownership moves.
    const rewrittenSpans = rewrittenSpansAfterHumanEdit(source.rewrittenSpans, source.text, text);
    if (rewrittenSpans.length > 0) node.rewrittenSpans = rewrittenSpans;
  } else {
    if (source.attribution !== undefined) {
      node.attribution = source.attribution === null
        ? null
        : {
          ...source.attribution,
          ranges: source.attribution.ranges.map((range) => ({ ...range }))
        };
    }
    if (source.rewrittenSpans !== undefined) {
      node.rewrittenSpans = source.rewrittenSpans.map((range) => ({ ...range }));
    }
  }
  return createTake(story, node);
}

export interface PasteStoryLineIds {
  /** Deterministic id for the clone at this position in the pasted chain
   *  (0 = the node attached directly under the target). Omit for a fresh
   *  random id per clone. */
  nodeId?: (index: number) => string;
}

export function assertStoryLineCopySize(partCount: number): void {
  if (partCount > MAX_STORY_LINE_COPY_PARTS) {
    throw new HttpError(
      400,
      `A story line of more than ${MAX_STORY_LINE_COPY_PARTS.toLocaleString()} parts is too large to paste.`
    );
  }
}

/**
 * Copy the active descendant path below `sourceNodeId` — every part it
 * currently continues into, in order, not the anchor itself — and attach a
 * clone of that whole path under `targetParentId` in one atomic step. The
 * cloned path becomes the active story line: `switchToNode` retargets every
 * `activeChildId` pointer from the story's true root down through the target
 * to the new leaf, exactly as choosing that leaf on the Story Map would.
 *
 * Field policy, decided once here rather than ad hoc per field: prose,
 * instruction, human-take marker, and human-edit attribution are authored
 * content, so every clone carries them forward. The synthetic `copied`
 * model states how this take entered the story without claiming that one
 * provider generated it. A clone never carries generation identity,
 * rewritten spans, captured token probabilities, a chapter break, or a Tag.
 * Those fields describe the source take's generation or structural identity.
 * Chapter summaries never enter into this at all: a summary is a structural
 * dead end, so it can be neither copied from nor pasted onto.
 */
export function pasteStoryLine(
  story: Story,
  sourceNodeId: string,
  targetParentId: string,
  expectedLeafId: string,
  ids: PasteStoryLineIds = {}
): StoryNode[] {
  const source = requireNode(story, sourceNodeId);
  if (isChapterSummary(source)) throw new HttpError(400, "A chapter summary is a dead end");
  const target = requireNode(story, targetParentId);
  if (isChapterSummary(target)) throw new HttpError(400, "A chapter summary is a dead end");
  if (subtreeIds(story, sourceNodeId).includes(targetParentId)) {
    throw new HttpError(400, "Cannot paste a story line below itself or one of its own parts.");
  }

  const chain = descendantLine(story, sourceNodeId);
  if (chain.length === 0) throw new HttpError(400, "This story part has no story line below it to copy.");
  if (chain.at(-1)!.id !== expectedLeafId) {
    throw new HttpError(409, "The story line changed since it was copied — copy it again.");
  }
  assertStoryLineCopySize(chain.length);

  const clones: StoryNode[] = [];
  let parentId = target.id;
  chain.forEach((original, index) => {
    const clone = newNode(parentId, original.instruction, original.text, "copied", {
      ...(ids.nodeId === undefined ? {} : { id: ids.nodeId(index) }),
      ...(original.human === true ? { human: true as const } : {})
    });
    clone.attribution = clipAttribution(original.attribution, original.text.length);
    if (clones.length > 0) clones.at(-1)!.activeChildId = clone.id;
    clones.push(clone);
    parentId = clone.id;
  });
  story.nodes.push(...clones);

  const parentWasLineEnd = activeLeaf(story)?.id === target.id;
  if (parentWasLineEnd) {
    const tag = story.tags.find((candidate) => candidate.nodeId === target.id);
    if (tag !== undefined) tag.nodeId = clones.at(-1)!.id;
  }
  switchToNode(story, clones[0]!.id);
  return clones;
}

function createCutTake(
  story: Story,
  target: StoryNode,
  offset: unknown,
  expected: string | null,
  activate = true,
  newNodeId?: string
): StoryNode {
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset <= 0 || offset >= target.text.length) {
    throw new HttpError(400, "Cut offset must fall inside the node text");
  }
  if (expected !== null && (expected.length > offset || target.text.slice(offset - expected.length, offset) !== expected)) {
    throw new HttpError(409, "The selection no longer matches the source text — reload the story.");
  }
  const text = target.text.slice(0, offset).trimEnd();
  const node = newNode(target.parentId, target.instruction, text, target.model, {
    ...(newNodeId === undefined ? {} : { id: newNodeId }),
    ...(target.role === "summary" ? { role: target.role } : {})
  });
  node.attribution = clipAttribution(target.attribution, text.length);
  return createTake(story, node, { activate });
}

export interface TakeCommit {
  parentId: string | null;
  appendTo: string | null;
  expectedTextHash: string | null;
  instruction: string;
  text: string;
  model: string;
  /** null = human take (no generation). */
  genId: string | null;
  nodeId?: string;
  committedAt?: string;
  /** Only ever set by a continuation commit that captured the model's token
   *  probabilities (issue #291 phase 3). Every other commit path — human
   *  takes, starter-vault seeding — leaves this absent. Both the new-take and
   *  the `appendTo` branch below attach it, aligned to whichever text this
   *  commit actually stores (issue #291 addendum) — see
   *  `attachTakeTokenProbabilities` in server/story-node-token-probabilities.ts. An append
   *  that lands on an already-recorded take replaces the stored record
   *  rather than merging into it: the viewer shows the most recent
   *  generation, never a combination of several. */
  tokenProbabilities?: CapturedTokenProbabilities | null;
  /** The Generation Record this commit's model request produced, when the
   *  caller captured one (server/generation-record-finalize.ts). Absent or
   *  null for a human take or a commit source unconcerned with this feature
   *  — mirrors TakeCommit.tokenProbabilities exactly. */
  generationRecord?: GenerationRecord | null;
  /** Only ever set by a commit that captured a thought and whose retention
   *  allowed keeping it. Mirrors `tokenProbabilities` above, except an
   *  append that lands on a take with no fresh thought this attempt leaves
   *  the take's existing thought untouched rather than clearing it — see
   *  `server/story-node-reasoning.ts`. */
  reasoning?: CapturedReasoning | null;
  /** Only ever set by a continuation commit that resolved Image Attachments
   *  for the take being generated (inherited, drafted, or both; see
   *  `server/generation-http.ts`). A stored part records the exact provider
   *  input it was generated from, so this must never be set together with
   *  `appendTo`: an append mutates an EXISTING part, and `commitTake` below
   *  refuses that combination rather than silently dropping it. Absent or
   *  empty both mean no images, matching `StoryNode.imageAttachments`'s own
   *  "absence means none, empty is invalid" rule. */
  imageAttachments?: readonly StoryImageAttachment[] | null;
}

/** Refuse a commit that would add an Image Attachment to an append: an
 *  append mutates a part that a model already generated from a specific
 *  provider input, so a new image can only ever start a new child take
 *  (settled decision, image-input rollout plan). Every caller upstream of
 *  this function (`server/generation-http.ts`) must already have refused
 *  such a request before committing; this is the shared last-resort guard,
 *  not the primary refusal a writer sees. */
export function assertNoAppendImageAttachments(commit: Pick<TakeCommit, "appendTo" | "imageAttachments">): void {
  if (commit.appendTo === null) return;
  if (commit.imageAttachments === undefined || commit.imageAttachments === null) return;
  if (commit.imageAttachments.length === 0) return;
  throw new Error("An append commit must never carry an Image Attachment");
}

export function hasCommittedGeneration(
  story: Pick<Story, "nodes">,
  genId: string
): boolean {
  return story.nodes.some((node) => node.genId === genId);
}

/** The one commit path shared by human takes, stop-saves, and stream
 * completions: genId idempotency, append-vs-new-take dispatch, and the
 * first-node auto-title must stay identical no matter which route runs.
 * Caller holds the story lock and saves unless `duplicate`. */
export function commitTake(story: Story, commit: TakeCommit): { duplicate: boolean } {
  if (commit.genId !== null && hasCommittedGeneration(story, commit.genId)) {
    return { duplicate: true };
  }
  assertNoAppendImageAttachments(commit);
  if (commit.appendTo !== null) {
    if (commit.expectedTextHash === null) throw new HttpError(400, "appendTo requires expectedTextHash");
    const node = appendToActiveLeaf(
      story,
      commit.appendTo,
      commit.expectedTextHash,
      commit.text,
      commit.model,
      commit.genId ?? undefined,
      commit.committedAt,
      commit.tokenProbabilities,
      commit.reasoning
    );
    if (commit.generationRecord !== undefined && commit.generationRecord !== null) {
      appendPendingGenerationRecord(node, commit.generationRecord);
    }
    return { duplicate: false };
  }
  const node = newNode(
    commit.parentId,
    commit.instruction,
    commit.text,
    commit.model,
    {
      ...(commit.nodeId === undefined ? {} : { id: commit.nodeId }),
      ...(commit.genId === null ? { human: true as const } : { genId: commit.genId })
    }
  );
  if (commit.committedAt !== undefined) node.createdAt = commit.committedAt;
  createTake(story, node);
  if (commit.tokenProbabilities !== undefined && commit.tokenProbabilities !== null) {
    attachTakeTokenProbabilities(node, commit.tokenProbabilities, commit.text, 0);
  }
  if (commit.generationRecord !== undefined && commit.generationRecord !== null) {
    appendPendingGenerationRecord(node, commit.generationRecord);
  }
  attachTakeReasoning(node, commit.reasoning);
  attachTakeImageAttachments(node, commit.imageAttachments);
  if (story.nodes.length === 1 && story.title === "Untitled") {
    story.title = titleFrom(commit.genId === null ? node.text : commit.instruction);
  }
  return { duplicate: false };
}

/** Attach a new take's resolved Image Attachments, when it has any. Unlike
 *  `attachTakeTokenProbabilities`/`attachTakeReasoning`, the ordered list IS
 *  the stored value, with no separate object hash to mint at encode time,
 *  so this sets `StoryNode.imageAttachments` directly rather than going
 *  through a pending side table. `server/story-codec.ts`'s
 *  `encodeStoryBundle` already reads this property straight off the node
 *  (clones it into the stored shape when the successor schema is active),
 *  and `server/story-payload.ts`'s response projection already clones it
 *  too, so a direct property assignment is both correct and the established
 *  pattern for this field. Absent or empty input leaves the node untouched:
 *  a freshly created node already has no `imageAttachments` property, and
 *  storing an empty array is invalid (`shared/image-attachment.ts`). */
export function attachTakeImageAttachments(
  node: StoryNode,
  attachments: readonly StoryImageAttachment[] | null | undefined
): void {
  if (attachments === undefined || attachments === null || attachments.length === 0) return;
  node.imageAttachments = attachments;
}

export function titleFrom(instruction: string): string {
  const words = instruction.split(/\s+/).filter((w) => w.length > 0).slice(0, 7).join(" ");
  const clipped = sliceWellFormedUtf16Prefix(words, 48);
  return clipped === words ? words : `${clipped}…`;
}

export function clipAttribution(
  attribution: HumanEditAttribution | null | undefined,
  textLength: number
): HumanEditAttribution | null | undefined {
  if (attribution === undefined || attribution === null) return attribution;
  return {
    source: "human",
    ranges: attribution.ranges
      .filter((range) => range.start < textLength)
      .map((range) => ({ start: range.start, end: Math.min(range.end, textLength) })),
    ...(attribution.deletedCharacters === undefined
      ? {}
      : { deletedCharacters: attribution.deletedCharacters })
  };
}

export function appendToActiveLeaf(
  story: Story,
  nodeId: string,
  expectedTextHash: string,
  continuation: string,
  model: string,
  genId?: string,
  committedAt?: string,
  tokenProbabilities?: CapturedTokenProbabilities | null,
  reasoning?: CapturedReasoning | null
): StoryNode {
  validateTextHash(expectedTextHash);
  const node = requireNode(story, nodeId);
  if (activeLeaf(story)?.id !== node.id) {
    throw new HttpError(409, "The node being continued is no longer the active leaf.");
  }
  return appendContinuationToNode(
    node,
    expectedTextHash,
    continuation,
    model,
    genId,
    committedAt,
    tokenProbabilities,
    reasoning
  );
}

export function appendContinuationToNode(
  node: StoryNode,
  expectedTextHash: string,
  continuation: string,
  model: string,
  genId?: string,
  committedAt?: string,
  tokenProbabilities?: CapturedTokenProbabilities | null,
  reasoning?: CapturedReasoning | null
): StoryNode {
  validateTextHash(expectedTextHash);
  if (node.role === "summary") {
    throw new HttpError(400, "Cannot write inside a summary — continue the story with a new node.");
  }
  if (sha256(node.text) !== expectedTextHash) {
    throw new HttpError(409, "The node being continued changed while writing.");
  }
  // The take's stored text before the append is exactly `node.text` here —
  // `appendContinuationText` is a plain concatenation — so this is the one
  // point that knows both what the append's steps recorded and where in the
  // take's final text their tail actually lands (issue #291 addendum).
  const segmentStart = node.text.length;
  node.text = appendContinuationText(node.text, continuation);
  setNodeRewriteId(node, undefined);
  node.model = model;
  node.updatedAt = committedAt ?? new Date().toISOString();
  if (genId !== undefined) node.genId = genId;
  if (tokenProbabilities !== undefined && tokenProbabilities !== null) {
    attachTakeTokenProbabilities(node, tokenProbabilities, continuation, segmentStart);
  }
  attachTakeReasoning(node, reasoning);
  return node;
}

export function applyHumanEdit(story: Story, nodeId: string, request: EditNodeRequest): StoryNode {
  validateTextHash(request.expectedTextHash);
  const node = requireNode(story, nodeId);
  if (sha256(node.text) !== request.expectedTextHash) {
    throw new HttpError(409, "The node changed while you were editing — reload and try again.");
  }
  let changed = false;
  let chapterSummaryTextChanged = false;
  if (request.text !== undefined && request.text !== node.text) {
    node.attribution = attributionAfterHumanEdit(node.attribution, node.text, request.text);
    // Same reclaim rule as `createEditedTake`: prose the writer just edited
    // is theirs now, whether or not the model rewrote it first.
    const rewrittenSpans = rewrittenSpansAfterHumanEdit(node.rewrittenSpans, node.text, request.text);
    if (rewrittenSpans.length > 0) node.rewrittenSpans = rewrittenSpans;
    else delete node.rewrittenSpans;
    node.text = request.text;
    if (isChapterSummary(node)) {
      node.editedByUser = true;
      chapterSummaryTextChanged = true;
    }
    changed = true;
  }
  if (request.instruction !== undefined && request.instruction !== node.instruction) {
    node.instruction = request.instruction;
    changed = true;
  }
  if (changed) {
    setNodeRewriteId(node, undefined);
    const now = new Date().toISOString();
    node.updatedAt = now;
    if (chapterSummaryTextChanged) node.madeAt = now;
  }
  return node;
}

export function deleteSubtree(story: Story, nodeId: string, expectedSubtreeCount: number): void {
  requireNode(story, nodeId);
  if (!Number.isSafeInteger(expectedSubtreeCount) || expectedSubtreeCount < 1) {
    throw new HttpError(400, "expectedSubtreeCount must be a positive integer");
  }
  const deadIds = new Set(subtreeIds(story, nodeId));
  if (deadIds.size !== expectedSubtreeCount) {
    throw new HttpError(409, "The subtree changed before deletion — reload the story.");
  }
  deleteNodeSet(story, deadIds);
}

export function pruneUnusedTakes(story: Story, expected: PruneUnusedTakesRequest): number {
  if (story.updatedAt !== expected.expectedStoryRevision) {
    throw new HttpError(409, "The story changed after the prune preview — reload it and review again.");
  }
  const selection = unusedTakePruneSelection(story);
  if (selection.takeIds.length !== expected.expectedTakeCount
    || selection.nodeIds.length !== expected.expectedPartCount) {
    throw new HttpError(409, "The prune selection changed — reload the story and review it again.");
  }
  deleteNodeSet(story, new Set(selection.nodeIds));
  return selection.takeIds.length;
}

function deleteNodeSet(story: Story, deadIds: Set<string>): void {
  const removedBreakIds = new Set(story.chapterBreaks
    .filter((chapterBreak) => deadIds.has(chapterBreak.parentPartId))
    .map((chapterBreak) => chapterBreak.id));
  for (const candidate of story.nodes) {
    if (isChapterSummary(candidate) && removedBreakIds.has(candidate.chapterBreakId)) deadIds.add(candidate.id);
  }

  const tree = indexTree(story);
  const survivingSibling = (parentId: string | null, removedId: string): StoryNode | null => {
    const siblings = childrenOf(tree, parentId);
    const offset = siblings.findIndex((candidate) => candidate.id === removedId);
    const before = offset < 0 ? [] : siblings.slice(0, offset);
    const after = offset < 0 ? siblings : siblings.slice(offset + 1);
    return after.find((candidate) => !deadIds.has(candidate.id))
      ?? before.findLast((candidate) => !deadIds.has(candidate.id))
      ?? null;
  };
  if (story.activeRootId !== null && deadIds.has(story.activeRootId)) {
    story.activeRootId = survivingSibling(null, story.activeRootId)?.id ?? null;
  }
  for (const parent of story.nodes) {
    if (deadIds.has(parent.id) || parent.activeChildId === null || !deadIds.has(parent.activeChildId)) continue;
    parent.activeChildId = survivingSibling(parent.id, parent.activeChildId)?.id ?? null;
  }

  story.nodes = story.nodes.filter((candidate) => !deadIds.has(candidate.id));
  story.tags = story.tags.filter((tag) => !deadIds.has(tag.nodeId));
  story.recentNodeIds = story.recentNodeIds.filter((recentId) => !deadIds.has(recentId));
  story.chapterBreaks = story.chapterBreaks.filter((chapterBreak) => !removedBreakIds.has(chapterBreak.id));
  for (const fact of story.facts) if (fact.sourcePartId !== undefined && deadIds.has(fact.sourcePartId)) delete fact.sourcePartId;
  reanchorPrunedAsideSessions(story);
}

export function switchLine(
  story: Story,
  nodeId: string,
  options: { stopAtNode?: boolean } = {}
): boolean {
  const target = nodeById(story, nodeId);
  if (target === null) throw new HttpError(404, `Node not found: ${nodeId}`);
  if (isChapterSummary(target)) throw new HttpError(404, `Node not found: ${nodeId}`);
  const targetParent = target.parentId === null ? null : requireNode(story, target.parentId);
  const tag = targetParent !== null && targetParent.activeChildId === null
    ? story.tags.find((candidate) => candidate.nodeId === targetParent.id)
    : undefined;
  const beforeLine = activePath(story).map((node) => node.id);
  const beforeTagNodeId = tag?.nodeId;
  switchToNode(story, nodeId, options);
  const nextLeaf = activeLeaf(story);
  if (tag !== undefined && nextLeaf !== null) tag.nodeId = nextLeaf.id;
  const afterLine = activePath(story);
  return beforeTagNodeId !== tag?.nodeId
    || beforeLine.length !== afterLine.length
    || beforeLine.some((id, index) => id !== afterLine[index]?.id);
}

function validateTextHash(value: string): void {
  if (!HASH_PATTERN.test(value)) throw new HttpError(400, "Invalid expectedTextHash");
}

export { countWords } from "../shared/story-text.js";

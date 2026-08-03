import { randomUUID } from "node:crypto";
import {
  activeLeaf,
  activePath,
  childrenOf,
  indexTree,
  isChapterSummary,
  nodeById,
  subtreeIds,
  switchToNode,
  unusedTakePruneSelection
} from "../shared/story-tree.js";
import { appendContinuationText } from "../shared/story-text.js";
import type { CoveredExtent, EditNodeRequest, HumanEditAttribution, PruneUnusedTakesRequest, Story, StoryNode } from "../shared/types.js";
import type { TokenProbabilityRecord } from "../shared/token-probabilities.js";
import { sliceWellFormedUtf16Prefix } from "../shared/unicode.js";
import { ServiceError as HttpError } from "./errors.js";
import { attributionAfterHumanEdit, rewrittenSpansAfterHumanEdit } from "../shared/human-edit.js";
import { HASH_PATTERN, sha256 } from "./story-format.js";
import { attachTakeTokenProbabilities, setNodeRewriteId } from "./story-node-text.js";

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
   *  `attachTakeTokenProbabilities` in server/story-node-text.ts. An append
   *  that lands on an already-recorded take replaces the stored record
   *  rather than merging into it: the viewer shows the most recent
   *  generation, never a combination of several. */
  tokenProbabilities?: TokenProbabilityRecord | null;
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
  if (commit.appendTo !== null) {
    if (commit.expectedTextHash === null) throw new HttpError(400, "appendTo requires expectedTextHash");
    appendToActiveLeaf(
      story,
      commit.appendTo,
      commit.expectedTextHash,
      commit.text,
      commit.model,
      commit.genId ?? undefined,
      commit.committedAt,
      commit.tokenProbabilities
    );
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
  if (story.nodes.length === 1 && story.title === "Untitled") {
    story.title = titleFrom(commit.genId === null ? node.text : commit.instruction);
  }
  return { duplicate: false };
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
  tokenProbabilities?: TokenProbabilityRecord | null
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
    tokenProbabilities
  );
}

export function appendContinuationToNode(
  node: StoryNode,
  expectedTextHash: string,
  continuation: string,
  model: string,
  genId?: string,
  committedAt?: string,
  tokenProbabilities?: TokenProbabilityRecord | null
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

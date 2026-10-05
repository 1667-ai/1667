import { DEFAULT_INSTRUCTION } from "./continuation-plan.js";
import { boundedNodeStubPreviewText, nodeStubHasInstruction } from "./node-stub.js";
import { estimateTokens } from "./tokens.js";
import {
  MAX_RECENT_LINES,
  type NodeStub,
  type StoryNode,
  type StoryPayload
} from "./types.js";

/** The preview of a streamed node is cut from at most this much text. */
export const STREAM_PREVIEW_SOURCE_UNITS = 512;

/** What a take being written is, as far as a map needs to draw it. The text
 * and its word count may be empty: the shape of the story is what the map
 * shows, and it is the same for every frame of the stream. */
export interface PendingTake {
  readonly targetId: string;
  readonly parentId: string | null;
  readonly instruction: string;
  readonly startedAt: string;
  readonly genId?: string;
  readonly text: string;
  readonly words: number;
}

export interface PendingTakeProjection {
  readonly projected: StoryPayload;
  readonly node: StoryNode;
  readonly stub: NodeStub;
}

/** The payload a take being written will leave behind, without changing the
 * authoritative one: the claimed take as the new end of the reading line, its
 * parent's counts and the tags that move with the line. Null when the parent
 * is not on the reading line. Shared by the TUI's stream projection and the
 * web map. */
export function projectPendingTake(payload: StoryPayload, take: PendingTake): PendingTakeProjection | null {
  const parentIndex = take.parentId === null
    ? -1
    : payload.path.findIndex((node) => node.id === take.parentId);
  if (take.parentId !== null && parentIndex < 0) return null;
  const instruction = take.instruction.trim().length > 0
    ? take.instruction.trim()
    : DEFAULT_INSTRUCTION;
  const node: StoryNode = {
    id: take.targetId,
    parentId: take.parentId,
    instruction,
    text: take.text,
    model: "writing",
    createdAt: take.startedAt,
    ...(take.genId === undefined ? {} : { genId: take.genId }),
    activeChildId: null
  };
  const path = payload.path.slice(0, parentIndex + 1).map((part) =>
    part.id === take.parentId ? { ...part, activeChildId: take.targetId } : part
  );
  path.push(node);

  const targetExists = payload.nodes.some((stub) => stub.id === take.targetId);
  const parent = take.parentId === null
    ? null
    : payload.nodes.find((stub) => stub.id === take.parentId) ?? null;
  const leafDelta = !targetExists && parent !== null && parent.childCount > 0 ? 1 : 0;
  const ancestorIds = new Set(path.slice(0, -1).map((part) => part.id));
  let streamedStub: NodeStub | null = null;
  const nodes = payload.nodes.map((stub): NodeStub => {
    if (stub.id === take.targetId) {
      streamedStub = projectedStub(
        { ...stub, lastTouched: latestActivity(stub.lastTouched, take.startedAt) },
        node,
        take.words
      );
      return streamedStub;
    }
    if (!ancestorIds.has(stub.id)) return stub;
    return {
      ...stub,
      ...(stub.id === take.parentId ? {
        activeChildId: take.targetId,
        childCount: stub.childCount + Number(!targetExists)
      } : {}),
      lastTouched: latestActivity(stub.lastTouched, take.startedAt),
      ...(!targetExists ? { leafCount: stub.leafCount + leafDelta } : {})
    };
  });
  if (streamedStub === null) {
    streamedStub = newStreamStub(node, take.startedAt, take.words);
    nodes.push(streamedStub);
  }
  const previousLeafId = payload.path.at(-1)?.id ?? null;
  const tags = take.parentId !== null && take.parentId === previousLeafId
    ? payload.tags.map((tag) => tag.nodeId === take.parentId
      ? { ...tag, nodeId: take.targetId }
      : tag)
    : payload.tags;
  const recentNodeIds = previousLeafId === null || previousLeafId === take.targetId
    ? payload.recentNodeIds
    : [previousLeafId, ...payload.recentNodeIds.filter((id) => id !== previousLeafId)]
      .slice(0, MAX_RECENT_LINES);
  const projected: StoryPayload = {
    ...payload,
    path,
    nodes,
    tags,
    recentNodeIds,
    activeRootId: take.parentId === null ? take.targetId : payload.activeRootId
  };
  return { projected, node, stub: streamedStub };
}

/** Match the authoritative rollup's monotonic descendant maximum. */
export function latestActivity(current: string, streamed: string): string {
  return current > streamed ? current : streamed;
}

export function newStreamStub(node: StoryNode, lastTouched: string, words: number): NodeStub {
  const preview = boundedNodeStubPreviewText(node.text, STREAM_PREVIEW_SOURCE_UNITS);
  return {
    id: node.id,
    parentId: node.parentId,
    preview: preview.complete ? preview.text : "",
    words,
    tokens: estimateTokens(node.instruction) + estimateTokens(node.text),
    childCount: 0,
    leafCount: 1,
    lastTouched,
    hasInstruction: nodeStubHasInstruction(node.instruction),
    activeChildId: null
  };
}

export function projectedStub(stub: NodeStub, node: StoryNode, words: number): NodeStub {
  const projected = { ...stub };
  applyStreamedText(projected, node, words);
  return projected;
}

export function applyStreamedText(
  stub: NodeStub,
  node: StoryNode,
  words: number
): void {
  const preview = boundedNodeStubPreviewText(node.text, STREAM_PREVIEW_SOURCE_UNITS);
  stub.preview = preview.complete ? preview.text : "";
  stub.words = words;
  stub.tokens = estimateTokens(node.instruction) + estimateTokens(node.text);
  stub.hasInstruction = nodeStubHasInstruction(node.instruction);
  if (stub.chapterBreakId !== undefined) {
    stub.text = node.text;
    stub.instruction = node.instruction;
  }
}

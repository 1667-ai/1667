import { DEFAULT_INSTRUCTION } from "../../shared/continuation-plan.js";
import { nodeStubHasInstruction, nodeStubPreviewText } from "../../shared/node-stub.js";
import { appendContinuationText, countWords } from "../../shared/story-text.js";
import { estimateTokens } from "../../shared/tokens.js";
import { MAX_RECENT_LINES, type NodeStub, type StoryNode, type StoryPayload } from "../../shared/types.js";
import type { StreamView } from "./state.js";
import {
  streamHasSubstantiveText,
  streamTrimmedText
} from "./stream-text.js";

export interface StreamProjectionOptions {
  /** MAP must show a claimed take before its first substantive token lands. */
  includePendingTake?: boolean;
}

/** Project the exact payload an in-flight stream can commit without mutating
 * the authoritative snapshot. New-take bytes follow server trim semantics;
 * append bytes retain their exact continuation boundary. */
export function projectStreamedPayload(
  payload: StoryPayload,
  stream: StreamView | null,
  options: StreamProjectionOptions = {}
): StoryPayload {
  if (stream === null) return payload;
  const substantive = streamHasSubstantiveText(stream);
  if (!substantive && (!options.includePendingTake || stream.append)) return payload;
  return stream.append
    ? projectAppend(payload, stream)
    : projectTake(payload, stream, substantive ? streamTrimmedText(stream) : "");
}

function projectTake(payload: StoryPayload, stream: StreamView, text: string): StoryPayload {
  const parentIndex = stream.parentId === null
    ? -1
    : payload.path.findIndex((node) => node.id === stream.parentId);
  if (stream.parentId !== null && parentIndex < 0) return payload;
  const instruction = stream.instruction.trim() || DEFAULT_INSTRUCTION;
  const node: StoryNode = {
    id: stream.targetId,
    parentId: stream.parentId,
    instruction,
    text,
    model: "writing",
    createdAt: stream.startedAt,
    ...(stream.genId === undefined ? {} : { genId: stream.genId }),
    activeChildId: null
  };
  const path = payload.path.slice(0, parentIndex + 1).map((part) =>
    part.id === stream.parentId ? { ...part, activeChildId: stream.targetId } : part
  );
  path.push(node);

  const targetExists = payload.nodes.some((stub) => stub.id === stream.targetId);
  const parent = stream.parentId === null
    ? null
    : payload.nodes.find((stub) => stub.id === stream.parentId) ?? null;
  const leafDelta = !targetExists && parent !== null && parent.childCount > 0 ? 1 : 0;
  const ancestorIds = new Set(path.slice(0, -1).map((part) => part.id));
  const nodes = payload.nodes.map((stub): NodeStub => {
    if (stub.id === stream.targetId) {
      return projectedStub({ ...stub, lastTouched: latestActivity(stub.lastTouched, stream.startedAt) }, node);
    }
    if (!ancestorIds.has(stub.id)) return stub;
    return {
      ...stub,
      ...(stub.id === stream.parentId ? {
        activeChildId: stream.targetId,
        childCount: stub.childCount + Number(!targetExists)
      } : {}),
      lastTouched: latestActivity(stub.lastTouched, stream.startedAt),
      ...(!targetExists ? { leafCount: stub.leafCount + leafDelta } : {})
    };
  });
  if (!targetExists) nodes.push(newStreamStub(node, stream.startedAt));
  const previousLeafId = payload.path.at(-1)?.id ?? null;
  const tags = stream.parentId !== null && stream.parentId === previousLeafId
    ? payload.tags.map((tag) => tag.nodeId === stream.parentId
      ? { ...tag, nodeId: stream.targetId }
      : tag)
    : payload.tags;
  const recentNodeIds = previousLeafId === null || previousLeafId === stream.targetId
    ? payload.recentNodeIds
    : [previousLeafId, ...payload.recentNodeIds.filter((id) => id !== previousLeafId)]
      .slice(0, MAX_RECENT_LINES);
  return {
    ...payload,
    path,
    nodes,
    tags,
    recentNodeIds,
    activeRootId: stream.parentId === null ? stream.targetId : payload.activeRootId
  };
}

function projectAppend(payload: StoryPayload, stream: StreamView): StoryPayload {
  const targetIndex = payload.path.findIndex((node) => node.id === stream.targetId);
  if (targetIndex < 0) return payload;
  const target = payload.path[targetIndex]!;
  const node: StoryNode = {
    ...target,
    text: appendContinuationText(target.text, stream.text),
    updatedAt: stream.startedAt,
    ...(stream.genId === undefined ? {} : { genId: stream.genId })
  };
  const path = payload.path.map((part, index) => index === targetIndex ? node : part);
  const activeIds = new Set(path.slice(0, targetIndex + 1).map((part) => part.id));
  const nodes = payload.nodes.map((stub) => {
    if (!activeIds.has(stub.id)) return stub;
    const touched = { ...stub, lastTouched: latestActivity(stub.lastTouched, stream.startedAt) };
    return stub.id === node.id
      ? projectedStub({ ...touched, updatedAt: stream.startedAt }, node)
      : touched;
  });
  return { ...payload, path, nodes };
}

/** Match the authoritative rollup's monotonic descendant maximum. */
function latestActivity(current: string, streamed: string): string {
  return current > streamed ? current : streamed;
}

function newStreamStub(node: StoryNode, lastTouched: string): NodeStub {
  return {
    id: node.id,
    parentId: node.parentId,
    preview: nodeStubPreviewText(node.text),
    words: countWords(node.text),
    tokens: estimateTokens(node.instruction) + estimateTokens(node.text),
    childCount: 0,
    leafCount: 1,
    lastTouched,
    hasInstruction: nodeStubHasInstruction(node.instruction),
    activeChildId: null
  };
}

function projectedStub(stub: NodeStub, node: StoryNode): NodeStub {
  const text = {
    preview: nodeStubPreviewText(node.text),
    words: countWords(node.text),
    tokens: estimateTokens(node.instruction) + estimateTokens(node.text),
    hasInstruction: nodeStubHasInstruction(node.instruction)
  };
  return stub.chapterBreakId === undefined
    ? { ...stub, ...text }
    : { ...stub, ...text, text: node.text, instruction: node.instruction };
}

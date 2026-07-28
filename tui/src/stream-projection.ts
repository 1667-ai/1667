import { DEFAULT_INSTRUCTION } from "../../shared/continuation-plan.js";
import { nodeStubHasInstruction, nodeStubPreviewText } from "../../shared/node-stub.js";
import {
  appendContinuationText,
  appendWordCount,
  WORD_COUNT_START,
  type IncrementalWordCount
} from "../../shared/story-text.js";
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

/** One live projection per (base payload, stream) pair. Delta batches only
 * grow the streamed text, never the tree shape, so the projected payload
 * keeps its identity across frames and the structural story-index memo
 * (shared/story-model.ts) hits instead of re-running its O(nodes) passes.
 * Only the streamed node and its stub change, and they change in place —
 * safe because the story index stores no text-bearing stub field. */
interface ProjectionEntry {
  /** Trusted by reference: a StreamView is replaced, never rewritten. */
  stream: StreamView;
  /** Settled text the append projection extends; "" for a new take. */
  settledText: string;
  /** stream.text length already folded into wordState. */
  scannedLength: number;
  /** stream.text length the projected node text reflects. */
  projectedLength: number;
  wordState: IncrementalWordCount;
  projected: StoryPayload;
  node: StoryNode;
  /** Null only when the payload has no stub for the streamed path node. */
  stub: NodeStub | null;
}

const PROJECTIONS = new WeakMap<StoryPayload, ProjectionEntry>();

/** Project the exact payload an in-flight stream can commit without mutating
 * the authoritative snapshot. New-take bytes follow server trim semantics;
 * append bytes retain their exact continuation boundary.
 *
 * The returned payload is a live per-stream view: its structure is frozen for
 * the stream's lifetime, while the streamed node's text-bearing fields
 * advance in place as delta batches land. Reading it after an await observes
 * newer text, never an inconsistent structure. */
export function projectStreamedPayload(
  payload: StoryPayload,
  stream: StreamView | null,
  options: StreamProjectionOptions = {}
): StoryPayload {
  if (stream === null) return payload;
  const substantive = streamHasSubstantiveText(stream);
  if (!substantive && (!options.includePendingTake || stream.append)) return payload;
  return projectionFor(payload, stream, substantive)?.projected ?? payload;
}

/** Combined settled+streamed text for the append target — the memoized
 * projection's one string per delta batch, shared by the frame and the wrap
 * planner. Falls back to a direct join when the stream cannot attach. */
export function projectedAppendText(payload: StoryPayload, stream: StreamView, target: StoryNode): string {
  const entry = projectionFor(payload, stream, true);
  return entry?.node.text ?? appendContinuationText(target.text, stream.text);
}

function projectionFor(
  payload: StoryPayload,
  stream: StreamView,
  substantive: boolean
): ProjectionEntry | null {
  const cached = PROJECTIONS.get(payload);
  if (cached !== undefined && cached.stream === stream) {
    refreshProjection(cached, stream, substantive);
    return cached;
  }
  const entry = stream.append
    ? appendProjection(payload, stream)
    : takeProjection(payload, stream, substantive ? streamTrimmedText(stream) : "");
  if (entry !== null) PROJECTIONS.set(payload, entry);
  return entry;
}

/** Fold only the new delta into the running word count, then rewrite the
 * streamed node and stub in place. The projected payload, arrays, and every
 * untouched stub keep their identity for downstream memos. */
function refreshProjection(entry: ProjectionEntry, stream: StreamView, substantive: boolean): void {
  if (stream.text.length === entry.projectedLength) return;
  if (stream.text.length > entry.scannedLength) {
    entry.wordState = appendWordCount(entry.wordState, stream.text.slice(entry.scannedLength));
    entry.scannedLength = stream.text.length;
  }
  entry.node.text = stream.append
    ? appendContinuationText(entry.settledText, stream.text)
    : substantive ? streamTrimmedText(stream) : "";
  if (entry.stub !== null) applyStreamedText(entry.stub, entry.node, entry.wordState.words);
  entry.projectedLength = stream.text.length;
}

function takeProjection(payload: StoryPayload, stream: StreamView, text: string): ProjectionEntry | null {
  const parentIndex = stream.parentId === null
    ? -1
    : payload.path.findIndex((node) => node.id === stream.parentId);
  if (stream.parentId !== null && parentIndex < 0) return null;
  // Word counting ignores whitespace, so the raw stream bytes count the same
  // words as the trimmed take text and later deltas can extend the tally.
  const wordState = appendWordCount(WORD_COUNT_START, stream.text);
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
  let streamedStub: NodeStub | null = null;
  const nodes = payload.nodes.map((stub): NodeStub => {
    if (stub.id === stream.targetId) {
      streamedStub = projectedStub(
        { ...stub, lastTouched: latestActivity(stub.lastTouched, stream.startedAt) },
        node,
        wordState.words
      );
      return streamedStub;
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
  if (streamedStub === null) {
    streamedStub = newStreamStub(node, stream.startedAt, wordState.words);
    nodes.push(streamedStub);
  }
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
  const projected: StoryPayload = {
    ...payload,
    path,
    nodes,
    tags,
    recentNodeIds,
    activeRootId: stream.parentId === null ? stream.targetId : payload.activeRootId
  };
  return projectionEntry(stream, "", wordState, projected, node, streamedStub);
}

function appendProjection(payload: StoryPayload, stream: StreamView): ProjectionEntry | null {
  const targetIndex = payload.path.findIndex((node) => node.id === stream.targetId);
  if (targetIndex < 0) return null;
  const target = payload.path[targetIndex]!;
  // One full scan of the settled part per generation; every later frame only
  // counts the freshly streamed delta.
  const wordState = appendWordCount(appendWordCount(WORD_COUNT_START, target.text), stream.text);
  const node: StoryNode = {
    ...target,
    text: appendContinuationText(target.text, stream.text),
    updatedAt: stream.startedAt,
    ...(stream.genId === undefined ? {} : { genId: stream.genId })
  };
  const path = payload.path.map((part, index) => index === targetIndex ? node : part);
  const activeIds = new Set(path.slice(0, targetIndex + 1).map((part) => part.id));
  let streamedStub: NodeStub | null = null;
  const nodes = payload.nodes.map((stub) => {
    if (!activeIds.has(stub.id)) return stub;
    const touched = { ...stub, lastTouched: latestActivity(stub.lastTouched, stream.startedAt) };
    if (stub.id !== node.id) return touched;
    streamedStub = projectedStub({ ...touched, updatedAt: stream.startedAt }, node, wordState.words);
    return streamedStub;
  });
  const projected: StoryPayload = { ...payload, path, nodes };
  return projectionEntry(stream, target.text, wordState, projected, node, streamedStub);
}

function projectionEntry(
  stream: StreamView,
  settledText: string,
  wordState: IncrementalWordCount,
  projected: StoryPayload,
  node: StoryNode,
  stub: NodeStub | null
): ProjectionEntry {
  return {
    stream,
    settledText,
    scannedLength: stream.text.length,
    projectedLength: stream.text.length,
    wordState,
    projected,
    node,
    stub
  };
}

/** Match the authoritative rollup's monotonic descendant maximum. */
function latestActivity(current: string, streamed: string): string {
  return current > streamed ? current : streamed;
}

function newStreamStub(node: StoryNode, lastTouched: string, words: number): NodeStub {
  return {
    id: node.id,
    parentId: node.parentId,
    preview: nodeStubPreviewText(node.text),
    words,
    tokens: estimateTokens(node.instruction) + estimateTokens(node.text),
    childCount: 0,
    leafCount: 1,
    lastTouched,
    hasInstruction: nodeStubHasInstruction(node.instruction),
    activeChildId: null
  };
}

function projectedStub(stub: NodeStub, node: StoryNode, words: number): NodeStub {
  const projected = { ...stub };
  applyStreamedText(projected, node, words);
  return projected;
}

function applyStreamedText(stub: NodeStub, node: StoryNode, words: number): void {
  stub.preview = nodeStubPreviewText(node.text);
  stub.words = words;
  stub.tokens = estimateTokens(node.instruction) + estimateTokens(node.text);
  stub.hasInstruction = nodeStubHasInstruction(node.instruction);
  if (stub.chapterBreakId !== undefined) {
    stub.text = node.text;
    stub.instruction = node.instruction;
  }
}

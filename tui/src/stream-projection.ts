import { DEFAULT_INSTRUCTION } from "../../shared/continuation-plan.js";
import { nodeStubHasInstruction, nodeStubPreviewText } from "../../shared/node-stub.js";
import {
  appendContinuationText,
  appendWordCount,
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
 * keeps its identity across frames and the story-index memo
 * (shared/story-model.ts) hits instead of re-running its O(nodes) passes.
 * Only the streamed node and its stub change, and they change in place. */
interface ProjectionEntry {
  stream: StreamView;
  targetId: string;
  append: boolean;
  instruction: string;
  startedAt: string;
  genId: string | undefined;
  /** Settled text the append projection extends; "" for a new take. */
  settledText: string;
  /** stream.text length already folded into wordState. */
  scannedLength: number;
  wordState: IncrementalWordCount;
  projected: StoryPayload;
  node: StoryNode;
  /** Null only when the payload has no stub for the streamed path node. */
  stub: NodeStub | null;
}

const PROJECTIONS = new WeakMap<StoryPayload, ProjectionEntry>();

interface CombinedText {
  settled: string;
  streamed: string;
  combined: string;
}

const COMBINED_TEXTS = new WeakMap<StreamView, CombinedText>();

/** Materialize the settled+streamed append text once per delta batch. The
 * projection and the wrap planner share the one string instead of each
 * concatenating their own copy per frame. */
export function combinedAppendText(identity: StreamView, settled: string, streamed: string): string {
  const cached = COMBINED_TEXTS.get(identity);
  if (cached !== undefined && cached.settled === settled && cached.streamed === streamed) {
    return cached.combined;
  }
  const combined = appendContinuationText(settled, streamed);
  COMBINED_TEXTS.set(identity, { settled, streamed, combined });
  return combined;
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
  const cached = PROJECTIONS.get(payload);
  if (cached !== undefined && reusableProjection(cached, stream)) {
    return refreshedProjection(cached, stream, substantive);
  }
  const entry = stream.append
    ? appendProjection(payload, stream)
    : takeProjection(payload, stream, substantive ? streamTrimmedText(stream) : "");
  if (entry === null) return payload;
  PROJECTIONS.set(payload, entry);
  return entry.projected;
}

/** Everything except the streamed text must match; any structural change
 * rebuilds the projection from scratch. */
function reusableProjection(entry: ProjectionEntry, stream: StreamView): boolean {
  return entry.stream === stream
    && entry.targetId === stream.targetId
    && entry.append === stream.append
    && entry.instruction === stream.instruction
    && entry.startedAt === stream.startedAt
    && entry.genId === stream.genId
    && stream.text.length >= entry.scannedLength;
}

/** Fold only the new delta into the running word count, then rewrite the
 * streamed node and stub in place. The projected payload, arrays, and every
 * untouched stub keep their identity for downstream memos. */
function refreshedProjection(
  entry: ProjectionEntry,
  stream: StreamView,
  substantive: boolean
): StoryPayload {
  if (stream.text.length > entry.scannedLength) {
    entry.wordState = appendWordCount(entry.wordState, stream.text.slice(entry.scannedLength));
    entry.scannedLength = stream.text.length;
  }
  entry.node.text = stream.append
    ? combinedAppendText(stream, entry.settledText, stream.text)
    : substantive ? streamTrimmedText(stream) : "";
  if (entry.stub !== null) applyStreamedText(entry.stub, entry.node, entry.wordState.words);
  return entry.projected;
}

function takeProjection(payload: StoryPayload, stream: StreamView, text: string): ProjectionEntry | null {
  const parentIndex = stream.parentId === null
    ? -1
    : payload.path.findIndex((node) => node.id === stream.parentId);
  if (stream.parentId !== null && parentIndex < 0) return null;
  // Word counting ignores whitespace, so the raw stream bytes count the same
  // words as the trimmed take text and later deltas can extend the tally.
  const wordState = appendWordCount(zeroWordCount(), stream.text);
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
      return streamedStub = projectedStub(
        { ...stub, lastTouched: latestActivity(stub.lastTouched, stream.startedAt) },
        node,
        wordState.words
      );
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
  const wordState = appendWordCount(appendWordCount(zeroWordCount(), target.text), stream.text);
  const node: StoryNode = {
    ...target,
    text: combinedAppendText(stream, target.text, stream.text),
    updatedAt: stream.startedAt,
    ...(stream.genId === undefined ? {} : { genId: stream.genId })
  };
  const path = payload.path.map((part, index) => index === targetIndex ? node : part);
  const activeIds = new Set(path.slice(0, targetIndex + 1).map((part) => part.id));
  let streamedStub: NodeStub | null = null;
  const nodes = payload.nodes.map((stub) => {
    if (!activeIds.has(stub.id)) return stub;
    const touched = { ...stub, lastTouched: latestActivity(stub.lastTouched, stream.startedAt) };
    return stub.id === node.id
      ? streamedStub = projectedStub({ ...touched, updatedAt: stream.startedAt }, node, wordState.words)
      : touched;
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
    targetId: stream.targetId,
    append: stream.append,
    instruction: stream.instruction,
    startedAt: stream.startedAt,
    genId: stream.genId,
    settledText,
    scannedLength: stream.text.length,
    wordState,
    projected,
    node,
    stub
  };
}

function zeroWordCount(): IncrementalWordCount {
  return { words: 0, insideWord: false };
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

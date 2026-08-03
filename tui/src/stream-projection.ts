import { DEFAULT_INSTRUCTION } from "../../shared/continuation-plan.js";
import {
  activeHumanAttribution,
  attributionAfterReplacement,
  rewrittenSpansAfterReplacement
} from "../../shared/human-edit.js";
import { nodeStubHasInstruction, nodeStubPreviewText } from "../../shared/node-stub.js";
import {
  appendContinuationText,
  appendWordCount,
  WORD_COUNT_START,
  type IncrementalWordCount
} from "../../shared/story-text.js";
import { estimateTokens } from "../../shared/tokens.js";
import {
  MAX_RECENT_LINES,
  type HumanEditAttribution,
  type NodeStub,
  type StoryNode,
  type StoryPayload,
  type TextRange
} from "../../shared/types.js";
import type { StreamView } from "./state.js";
import {
  streamHasSubstantiveText,
  streamMode,
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
  /** The rewrite target's attribution before this stream began, so every
   *  delta batch can recompute node.attribution from the same original
   *  ranges instead of compounding shifts frame over frame. Null for take
   *  and append: append only ever extends settled text (nothing earlier
   *  shifts), and a take starts from no attribution at all. */
  targetAttribution: HumanEditAttribution | null;
  /** Same frozen-baseline treatment as `targetAttribution`, for the spans an
   *  earlier rewrite left behind. Undefined for take and append. */
  targetRewrittenSpans: readonly TextRange[] | undefined;
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
  // A rewrite target already exists on the path — unlike a claimed new take,
  // there is no "pending" shape worth showing before real replacement text
  // lands, so it stays unprojected (and the passage never blinks empty).
  if (!substantive
    && (streamMode(stream) !== "take" || !options.includePendingTake)) {
    return payload;
  }
  return projectionFor(payload, stream, substantive)?.projected ?? payload;
}

/** Combined settled+streamed node for an append or rewrite target — the
 * memoized projection's one node per delta batch, shared by the frame and
 * the wrap planner, carrying both the spliced text and (for a rewrite) the
 * recomputed attribution — so both readers derive the same human-edit runs
 * from the same node instead of one of them re-deriving from stale spans.
 * The fallback covers a stream that cannot attach, and mirrors its own mode:
 * a fallback that joined rewrite bytes onto the end would put the
 * replacement where the splice never goes. */
export function projectedPart(payload: StoryPayload, stream: StreamView, target: StoryNode): StoryNode {
  const entry = projectionFor(payload, stream, true);
  if (entry !== null) return entry.node;
  if (streamMode(stream) === "rewrite") {
    const rewrite = stream.rewrite!;
    const replacement = streamTrimmedText(stream);
    return {
      ...target,
      text: spliceRewriteText(target.text, rewrite, replacement),
      attribution: attributionAfterReplacement(
        activeHumanAttribution(target), rewrite.start, rewrite.end, replacement.length, target.text.length
      ),
      rewrittenSpans: rewrittenSpansAfterReplacement(target.rewrittenSpans, rewrite.start, rewrite.end, replacement.length)
    };
  }
  return { ...target, text: appendContinuationText(target.text, stream.text) };
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
  let entry: ProjectionEntry | null;
  switch (streamMode(stream)) {
    case "rewrite":
      entry = rewriteProjection(payload, stream, substantive ? streamTrimmedText(stream) : "");
      break;
    case "append":
      entry = appendProjection(payload, stream);
      break;
    case "take":
      entry = takeProjection(payload, stream, substantive ? streamTrimmedText(stream) : "");
      break;
  }
  if (entry !== null) PROJECTIONS.set(payload, entry);
  return entry;
}

/** Fold only the new delta into the running word count, then rewrite the
 * streamed node and stub in place. The projected payload, arrays, and every
 * untouched stub keep their identity for downstream memos. */
function refreshProjection(entry: ProjectionEntry, stream: StreamView, substantive: boolean): void {
  if (stream.text.length === entry.projectedLength) return;
  const mode = streamMode(stream);
  switch (mode) {
    case "rewrite": {
      // A rewrite splices new words into the middle of settled prose, so the
      // seams themselves can gain or lose whitespace/word boundaries that an
      // incremental tally of only the new bytes cannot see. Recount the whole
      // projected node every delta batch instead — one part's worth of work,
      // never the story's.
      const rewrite = stream.rewrite!;
      const replacement = substantive ? streamTrimmedText(stream) : "";
      entry.node.text = spliceRewriteText(entry.settledText, rewrite, replacement);
      entry.node.attribution = attributionAfterReplacement(
        entry.targetAttribution, rewrite.start, rewrite.end, replacement.length, entry.settledText.length
      );
      entry.node.rewrittenSpans = rewrittenSpansAfterReplacement(
        entry.targetRewrittenSpans, rewrite.start, rewrite.end, replacement.length
      );
      entry.wordState = appendWordCount(WORD_COUNT_START, entry.node.text);
      entry.scannedLength = stream.text.length;
      break;
    }
    case "append":
    case "take":
      if (stream.text.length > entry.scannedLength) {
        entry.wordState = appendWordCount(entry.wordState, stream.text.slice(entry.scannedLength));
        entry.scannedLength = stream.text.length;
      }
      entry.node.text = mode === "append"
        ? appendContinuationText(entry.settledText, stream.text)
        : substantive ? streamTrimmedText(stream) : "";
      break;
  }
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
  return projectionEntry(stream, "", wordState, projected, node, streamedStub, null, undefined);
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
  return projectionEntry(stream, target.text, wordState, projected, node, streamedStub, null, undefined);
}

/** The target keeps its id and path position; only its text changes, spliced
 * exactly where the server will splice the committed replacement. Its
 * attribution is recomputed the same way `applyRewrite`
 * (server/story-provider-effect.ts) commits it, so a human-authored passage
 * never paints the model's mid-splice words as the writer's own. */
function rewriteProjection(payload: StoryPayload, stream: StreamView, text: string): ProjectionEntry | null {
  const rewrite = stream.rewrite;
  if (rewrite === undefined) return null;
  const targetIndex = payload.path.findIndex((node) => node.id === stream.targetId);
  if (targetIndex < 0) return null;
  const target = payload.path[targetIndex]!;
  const spliced = spliceRewriteText(target.text, rewrite, text);
  const wordState = appendWordCount(WORD_COUNT_START, spliced);
  const targetAttribution = activeHumanAttribution(target);
  const targetRewrittenSpans = target.rewrittenSpans;
  const node: StoryNode = {
    ...target,
    text: spliced,
    attribution: attributionAfterReplacement(targetAttribution, rewrite.start, rewrite.end, text.length, target.text.length),
    rewrittenSpans: rewrittenSpansAfterReplacement(targetRewrittenSpans, rewrite.start, rewrite.end, text.length),
    updatedAt: stream.startedAt
  };
  const path = payload.path.map((part, index) => index === targetIndex ? node : part);
  let streamedStub: NodeStub | null = null;
  const nodes = payload.nodes.map((stub) => {
    if (stub.id !== node.id) return stub;
    streamedStub = projectedStub(
      { ...stub, lastTouched: latestActivity(stub.lastTouched, stream.startedAt) },
      node,
      wordState.words
    );
    return streamedStub;
  });
  const projected: StoryPayload = { ...payload, path, nodes };
  return projectionEntry(stream, target.text, wordState, projected, node, streamedStub, targetAttribution, targetRewrittenSpans);
}

/** Splice the streamed replacement into settled text at the rewrite's
 * boundary — the same [start, end) the server will splice on commit. */
function spliceRewriteText(
  settledText: string,
  rewrite: NonNullable<StreamView["rewrite"]>,
  replacement: string
): string {
  return settledText.slice(0, rewrite.start) + replacement + settledText.slice(rewrite.end);
}

function projectionEntry(
  stream: StreamView,
  settledText: string,
  wordState: IncrementalWordCount,
  projected: StoryPayload,
  node: StoryNode,
  stub: NodeStub | null,
  targetAttribution: HumanEditAttribution | null,
  targetRewrittenSpans: readonly TextRange[] | undefined
): ProjectionEntry {
  return {
    stream,
    settledText,
    scannedLength: stream.text.length,
    projectedLength: stream.text.length,
    wordState,
    projected,
    node,
    stub,
    targetAttribution,
    targetRewrittenSpans
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

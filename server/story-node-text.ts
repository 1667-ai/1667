import type { StoryNode } from "../shared/types.js";
import { nodeStubPreviewText } from "../shared/node-stub.js";
import { countWords } from "../shared/story-text.js";
import { estimateTokens } from "../shared/tokens.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
import { StoryFormatError, type ObjectHash, type StoredNodeV1 } from "./story-format.js";

interface StoredNodeTextState {
  revisionId: ObjectHash;
  instruction: string;
  preview: string;
  words: number;
  tokens: number;
  /** null means the immutable revision is intentionally not hydrated. */
  originalText: string | null;
  reusable: boolean;
}

const storedText = new WeakMap<StoryNode, StoredNodeTextState>();
const rewriteIds = new WeakMap<StoryNode, string>();

export function attachStoredNodeText(node: StoryNode, stored: StoredNodeV1, text: string | null): void {
  const rawPreview = stored.preview ?? (text === null ? undefined : nodeStubPreviewText(text));
  const preview = rawPreview === undefined ? undefined : dropLegacySplitHighSurrogate(rawPreview);
  const words = stored.words ?? (text === null ? undefined : countWords(text));
  const tokens = stored.tokens ?? (text === null ? undefined : estimateTokens(node.instruction) + estimateTokens(text));
  if (preview === undefined || words === undefined || tokens === undefined) {
    throw new StoryFormatError(`Node ${node.id} is missing lazy-load metadata`);
  }
  storedText.set(node, {
    revisionId: stored.revisionId,
    instruction: node.instruction,
    preview,
    words,
    tokens,
    originalText: text,
    reusable: stored.syntheticEmpty !== true
  });
  setNodeRewriteId(node, stored.rewriteId);
  if (text !== null) verifyStoredStub(node, text);
}

export function hydrateStoredNodeText(node: StoryNode, text: string): void {
  const state = storedText.get(node);
  if (state === undefined) return;
  node.text = text;
  state.originalText = text;
  verifyStoredStub(node, text);
}

export function refreshStoredNodeText(node: StoryNode, stored: StoredNodeV1): void {
  const current = storedText.get(node);
  // Same revision with unchanged text was verified when first attached; skip
  // the per-save stub rescan of every unchanged path node.
  if (current !== undefined && current.revisionId === stored.revisionId
    && current.instruction === node.instruction
    && (current.originalText === null || current.originalText === node.text)
    && (stored.preview ?? current.preview) === current.preview
    && (stored.words ?? current.words) === current.words
    && (stored.tokens ?? current.tokens) === current.tokens) {
    current.reusable = stored.syntheticEmpty !== true;
    return;
  }
  attachStoredNodeText(node, stored, current?.originalText === null ? null : node.text);
}

export function isNodeTextHydrated(node: StoryNode): boolean {
  return storedText.get(node)?.originalText !== null;
}

export function nodeRewriteId(node: StoryNode): string | undefined {
  return rewriteIds.get(node);
}

export function setNodeRewriteId(node: StoryNode, rewriteId: string | undefined): void {
  if (rewriteId === undefined) rewriteIds.delete(node);
  else rewriteIds.set(node, rewriteId);
}

export function reusableStoredRevisionId(node: StoryNode): ObjectHash | undefined {
  const state = storedText.get(node);
  if (state === undefined) return undefined;
  return state.reusable && (state.originalText === null || state.originalText === node.text)
    ? state.revisionId
    : undefined;
}

export function nodeStubPreview(node: StoryNode): string {
  const state = storedText.get(node);
  if (state !== undefined && (state.originalText === null || state.originalText === node.text)) {
    if (!hasUnpairedSurrogate(state.preview)) return state.preview;
    if (state.originalText === null) {
      throw new StoryFormatError(`Node ${node.id} has malformed lazy-load preview metadata`);
    }
  }
  return nodeStubPreviewText(node.text);
}

export function nodeStubWords(node: StoryNode): number {
  const state = storedText.get(node);
  return state !== undefined && (state.originalText === null || state.originalText === node.text)
    ? state.words
    : countWords(node.text);
}

export function nodeStubTokens(node: StoryNode): number {
  const state = storedText.get(node);
  return state !== undefined && state.instruction === node.instruction
    && (state.originalText === null || state.originalText === node.text)
    ? state.tokens
    : estimateTokens(node.instruction) + estimateTokens(node.text);
}

function verifyStoredStub(node: StoryNode, text: string): void {
  const state = storedText.get(node)!;
  const safePreview = nodeStubPreviewText(text);
  const legacyPreview = text.slice(0, 100);
  if ((state.preview !== safePreview && state.preview !== legacyPreview) || countWords(text) !== state.words) {
    throw new StoryFormatError(`Node ${node.id} stub metadata does not match its revision`);
  }
  // Tokens are an estimate, not integrity data — retuning the estimator must
  // not invalidate stored bundles. Adopt the current estimate instead.
  state.tokens = estimateTokens(node.instruction) + estimateTokens(text);
  state.instruction = node.instruction;
}

function dropLegacySplitHighSurrogate(preview: string): string {
  const last = preview.charCodeAt(preview.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? preview.slice(0, -1) : preview;
}

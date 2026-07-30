import { indexTree, isChapterSummary } from "./story-tree.js";
import type { Story, StoryFact, StoryNode } from "./types.js";

/** Which corpus a hit came from. Prose is a part's text, a prompt is the
 * instruction that made it, and a fact is one canon note. */
export type SearchHitKind = "prose" | "prompt" | "fact";

/** The whole tree of one story, or every story in the vault. */
export type SearchScope = "tree" | "vault";

export interface SearchHit {
  storyId: string;
  storyTitle: string;
  kind: SearchHitKind;
  /** The part that holds a prose or prompt hit; the fact id for a fact hit. */
  targetId: string;
  /** 1-based depth of the part in its tree. 0 for a fact. */
  depth: number;
  /** One whitespace-normalized line around the match. */
  snippet: string;
  /** Match position inside `snippet`, in UTF-16 units. */
  snippetMatch: number;
  matchLength: number;
  /** Surrounding prose for the preview pane. */
  context: string;
  /** Match position inside `context`, in UTF-16 units. */
  contextMatch: number;
}

export interface SearchRequest {
  query: string;
  scope: SearchScope;
  /** The open story. Tree scope searches it; vault scope names it. */
  storyId: string;
  caseSensitive: boolean;
}

export interface SearchResponse {
  query: string;
  scope: SearchScope;
  caseSensitive: boolean;
  hits: SearchHit[];
  /** True when the scan stopped at the hit cap; stories after it went unread. */
  capped: boolean;
  /** How many stories the scan read. */
  storiesSearched: number;
}

/** One query cannot return more than this. A writer navigates hits; past this
 * count the answer is a narrower query, not a longer list. */
export const SEARCH_HIT_LIMIT = 500;

/** Shortest query that runs. One character matches almost everything. */
export const SEARCH_MIN_QUERY = 2;

/** Longest query that runs. Past this a query is a pasted passage rather than
 *  something to search for, and every hit would carry a preview the size of the
 *  paste. */
export const SEARCH_MAX_QUERY = 256;

const SNIPPET_BEFORE = 24;
const SNIPPET_LENGTH = 160;
const CONTEXT_BEFORE = 140;
const CONTEXT_LENGTH = 420;

/** One searchable field, extracted once so repeated keystrokes only scan. */
export interface SearchCorpusEntry {
  kind: SearchHitKind;
  targetId: string;
  depth: number;
  text: string;
}

export interface SearchCorpus {
  storyId: string;
  storyTitle: string;
  /** The story revision this corpus was built from. */
  updatedAt: string;
  entries: SearchCorpusEntry[];
}

export function searchQueryIsRunnable(query: string): boolean {
  const length = query.trim().length;
  return length >= SEARCH_MIN_QUERY && length <= SEARCH_MAX_QUERY;
}

/** Every searchable field of one story in reading order: each part's prose
 *  then its prompt, shallowest first, and the facts last. Node text must be
 *  hydrated before this runs. */
export function buildSearchCorpus(story: Story): SearchCorpus {
  const depths = nodeDepths(story);
  const ordered = [...story.nodes].sort((left, right) =>
    (depths.get(left.id) ?? 0) - (depths.get(right.id) ?? 0));
  const entries: SearchCorpusEntry[] = [];
  for (const node of ordered) {
    // A chapter summary hangs off the tree without standing in it: no line can
    // run through one, so a hit inside it belongs to the part it was written
    // at. Reporting it there is what lets a client name the part it will open
    // without needing that story's tree — which, across the vault, it lacks.
    const landing = isChapterSummary(node) && node.parentId !== null
      ? node.parentId
      : node.id;
    const depth = depths.get(landing) ?? 0;
    if (node.text.length > 0) {
      entries.push({ kind: "prose", targetId: landing, depth, text: node.text });
    }
    if (node.instruction.length > 0) {
      entries.push({ kind: "prompt", targetId: landing, depth, text: node.instruction });
    }
  }
  for (const fact of story.facts) {
    entries.push({ kind: "fact", targetId: fact.id, depth: 0, text: factText(fact) });
  }
  return { storyId: story.id, storyTitle: story.title, updatedAt: story.updatedAt, entries };
}

/** Every match in one prepared corpus, in corpus order. */
export function searchCorpus(
  corpus: SearchCorpus,
  query: string,
  caseSensitive: boolean,
  limit: number
): SearchHit[] {
  if (query.length === 0 || limit <= 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of corpus.entries) {
    if (hits.length >= limit) break;
    collectMatches(hits, limit, matcher(query, caseSensitive), entry.text, (snippet, context) => ({
      storyId: corpus.storyId,
      storyTitle: corpus.storyTitle,
      kind: entry.kind,
      targetId: entry.targetId,
      depth: entry.depth,
      ...snippet,
      ...context
    }));
  }
  return hits;
}

/** Match against the text as it is stored.
 *
 * Folding a copy of the text to lower case and searching that would be simpler,
 * but case folding is not length-preserving — `İ` folds to two UTF-16 units —
 * so every offset taken from the folded copy can point at the wrong place in
 * the real text, and those offsets travel to the client as highlight bounds. */
function matcher(query: string, caseSensitive: boolean): RegExp {
  // Unicode mode matches code points, so a lone surrogate in the query cannot
  // match half an astral character in the prose and report a highlight that
  // splits the pair. Every character the escape below can produce is a legal
  // `u`-mode escape.
  return new RegExp(escapeRegExp(query), caseSensitive ? "gu" : "giu");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A fact reads as one row, so its tag travels with its body. */
function factText(fact: StoryFact): string {
  return fact.tag === null || fact.tag.trim().length === 0
    ? fact.text
    : `${fact.tag} · ${fact.text}`;
}

interface SnippetWindow {
  snippet: string;
  snippetMatch: number;
  matchLength: number;
}

interface ContextWindow {
  context: string;
  contextMatch: number;
}

function collectMatches(
  hits: SearchHit[],
  limit: number,
  pattern: RegExp,
  raw: string,
  build: (snippet: SnippetWindow, context: ContextWindow) => SearchHit
): void {
  pattern.lastIndex = 0;
  while (hits.length < limit) {
    const match = pattern.exec(raw);
    if (match === null) return;
    const length = match[0].length;
    hits.push(build(
      snippetWindow(raw, match.index, length),
      contextWindow(raw, match.index, length)
    ));
    // Overlapping matches would report the same row twice, and a zero-length
    // match would never advance at all.
    pattern.lastIndex = match.index + Math.max(1, length);
  }
}

/** The match on one line, with the surrounding words that fit beside it.
 *  Both ends stop at a word boundary: a snippet that starts mid-word reads as
 *  damage rather than as context. */
function snippetWindow(raw: string, at: number, length: number): SnippetWindow {
  const lead = normalizeSpace(raw.slice(windowStart(raw, at - SNIPPET_BEFORE * 2), at));
  const cutLead = lead.length > SNIPPET_BEFORE || at > SNIPPET_BEFORE * 2;
  const leadKept = cutLead ? trimToWordStart(lead.slice(windowStart(lead, lead.length - SNIPPET_BEFORE))) : lead;
  const prefix = cutLead ? `…${leadKept}` : leadKept;
  const match = normalizeSpace(raw.slice(at, at + length));
  const tailRoom = Math.max(0, SNIPPET_LENGTH - prefix.length - match.length);
  const tailRaw = normalizeSpace(
    raw.slice(at + length, windowEnd(raw, at + length + tailRoom * 2))
  );
  const tail = tailRaw.length > tailRoom
    ? `${trimToWordEnd(tailRaw.slice(0, windowEnd(tailRaw, tailRoom - 1)))}…`
    : tailRaw;
  return { snippet: `${prefix}${match}${tail}`, snippetMatch: prefix.length, matchLength: match.length };
}

/** Drop a leading partial word, keeping the space that separated it. */
function trimToWordStart(text: string): string {
  const boundary = text.indexOf(" ");
  return boundary === -1 || boundary > text.length / 2 ? text : text.slice(boundary + 1);
}

/** Drop a trailing partial word. */
function trimToWordEnd(text: string): string {
  const boundary = text.lastIndexOf(" ");
  return boundary <= 0 || boundary < text.length / 2 ? text : text.slice(0, boundary);
}

/** Enough real prose around the match to fill the preview pane.
 *
 *  The window always reaches past the end of the match. A match longer than the
 *  window would otherwise leave `contextMatch + matchLength` pointing outside
 *  the context it travels with, which the client rejects — one long query would
 *  fail the whole response rather than just its own preview. */
function contextWindow(raw: string, at: number, length: number): ContextWindow {
  const start = windowStart(raw, at - CONTEXT_BEFORE);
  const end = windowEnd(raw, Math.max(start + CONTEXT_LENGTH, at + length));
  const prefix = start > 0 ? "…" : "";
  const suffix = end < raw.length ? "…" : "";
  const body = normalizeSpace(raw.slice(start, end));
  // Collapsing whitespace moves the match, so re-measure the lead instead of
  // reusing the raw distance.
  const lead = normalizeSpace(raw.slice(start, at));
  return { context: `${prefix}${body}${suffix}`, contextMatch: prefix.length + lead.length };
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/gu, " ");
}

/** Window edges are counted in UTF-16 units, so one can fall between the two
 *  halves of an astral character. Step off the low half rather than shipping a
 *  lone surrogate the renderer cannot measure.
 *
 *  Only a complete pair moves an edge. Storage rejects an unpaired surrogate
 *  before prose is ever written (`assertWellFormedUnicode`), so this is defence
 *  in depth rather than a case that arrives — but treating a lone low surrogate
 *  at index 0 as half of something returned -1, and a negative index slices
 *  from the far end of the string. */
function windowStart(raw: string, index: number): number {
  const start = Math.max(0, Math.min(raw.length, index));
  return start > 0
    && isLowSurrogate(raw.charCodeAt(start))
    && isHighSurrogate(raw.charCodeAt(start - 1))
    ? start - 1
    : start;
}

function windowEnd(raw: string, index: number): number {
  const end = Math.max(0, Math.min(raw.length, index));
  return end > 0
    && isHighSurrogate(raw.charCodeAt(end - 1))
    && isLowSurrogate(raw.charCodeAt(end))
    ? end - 1
    : end;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Depth by parent chain, walked iteratively: a long line is deeper than a
 *  recursive walk can safely nest. */
function nodeDepths(story: Story): Map<string, number> {
  const tree = indexTree(story);
  const depths = new Map<string, number>();
  const pending: Array<{ node: StoryNode; depth: number }> = (tree.childrenByParentId.get(null) ?? [])
    .map((node) => ({ node, depth: 1 }));
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (depths.has(node.id)) continue;
    depths.set(node.id, depth);
    for (const child of tree.childrenByParentId.get(node.id) ?? []) {
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  return depths;
}

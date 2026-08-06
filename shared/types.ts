import { assertStoryAggregateVersion } from "./story-aggregate-version.js";
import { isValidAuthorsNoteDepth, MAX_AUTHORS_NOTE_CHARS, MAX_AUTHORS_NOTE_DEPTH } from "./authors-note.js";
import { MAX_AUTHOR_BRIEF_CHARS } from "./author-brief.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";
import { FactActivationError } from "./fact-metadata.js";
import { parseFactMetadata } from "./fact-validation.js";
import type { FactActivation, FactPriority, FactRecursion, FactSecondaryMode } from "./fact-metadata.js";
import {
  SamplingValidationError,
  validateSamplingBannedStrings,
  validateSamplingPhraseBias
} from "./sampling-validation-policy.js";
import type { SamplingPhraseBiasEntryV2 } from "./settings-v2-types.js";

export interface TextRange {
  /** UTF-16 offsets, matching String.slice and textarea selection offsets. */
  start: number;
  end: number;
}

/** The spans introduced or replaced by a direct author edit. An empty range
 *  list still identifies a deletion-only variant as human-made. */
export interface HumanEditAttribution {
  source: "human";
  ranges: TextRange[];
  /** User-perceived (grapheme) characters removed. Absent when none or unknown. */
  deletedCharacters?: number;
}

/** Keep persisted and rendered attribution bounded for pathological edits. */
export const MAX_HUMAN_EDIT_RANGES = 256;

/** Keep persisted and rendered rewritten spans bounded, in the spirit of
 *  MAX_HUMAN_EDIT_RANGES — the two lists are unrelated in meaning but face
 *  the same pathological-edit risk. */
export const MAX_REWRITTEN_SPANS = 256;

export const MAX_FACTS = 128;
export const MAX_FACT_TEXT_CHARS = 4_000;
export const MAX_FACT_TAG_CHARS = 48;

export type { FactActivation, FactPriority, FactRecursion, FactSecondaryMode };

export interface FactInput {
  tag?: string | null;
  text: string;
  activation?: FactActivation;
  keys?: string[];
  secondaryKeys?: string[];
  secondaryMode?: FactSecondaryMode;
  scanDepth?: number;
  recursion?: FactRecursion;
  /** Default "normal" when omitted. */
  priority?: FactPriority;
  /** Positive estimated-token cap; a Fact over its own cap is dropped, never truncated. */
  budgetTokens?: number;
  sourcePartId?: string;
}

export interface FactPatch {
  tag?: string | null;
  text?: string;
  activation?: FactActivation;
  keys?: string[];
  secondaryKeys?: string[] | null;
  secondaryMode?: FactSecondaryMode | null;
  scanDepth?: number | null;
  recursion?: FactRecursion | null;
  priority?: FactPriority;
  /** null clears a previously set per-Fact budget. */
  budgetTokens?: number | null;
}

/** Wire body of POST /api/stories/:id/facts. */
export type CreateFactsRequest = FactInput | { facts: FactInput[] };

/** Wire body of POST /api/stories/:id/facts/:factId/reorder. */
export interface ReorderFactRequest {
  /** The Fact's new position among story.facts, 0-based. Clamped server-side. */
  toIndex: number;
}

export interface StoryFact {
  id: string;
  tag: string | null;
  text: string;
  activation: FactActivation;
  keys: string[];
  /** Gate keys. Empty or absent means no gate. */
  secondaryKeys?: string[];
  secondaryMode?: FactSecondaryMode;
  scanDepth?: number;
  recursion?: FactRecursion;
  createdAt: string;
  updatedAt: string;
  /** Shedding rank under window pressure; absent means "normal". */
  priority?: FactPriority;
  /** Estimated-token cap on this Fact alone; absent means uncapped. */
  budgetTokens?: number;
  sourcePartId?: string;
}

export interface CoveredExtent {
  fromPartId: string;
  toPartId: string;
}

export interface ChapterBreak {
  id: string;
  parentPartId: string;
  title: string;
  createdAt: string;
}

export interface StoryNode {
  id: string;
  /** null = a root: a take of the story's beginning. */
  parentId: string | null;
  instruction: string;
  text: string;
  model: string;
  createdAt: string;
  /** Set on any in-place mutation (human edit, rewrite, append). */
  updatedAt?: string;
  /** Human-edit spans of the current text. */
  attribution?: HumanEditAttribution | null;
  /** Spans of the current text that a rewrite replaced. A node can carry both
   *  human spans and rewritten spans at once — writing over a rewritten span
   *  reclaims it as human, and the two lists move independently — so this
   *  cannot live inside `attribution`. Absent means no rewritten spans. */
  rewrittenSpans?: TextRange[];
  /** This take began when the user typed at a seam (or composer Write). */
  human?: true;
  genId?: string;
  role?: "summary";
  chapterBreakId?: string;
  coveredExtent?: CoveredExtent;
  madeAt?: string;
  editedByUser?: true;
  /** This take's captured token probabilities. Presence only — the record
   *  itself is fetched on demand via
   *  GET /api/stories/:id/nodes/:nodeId/token-probabilities, never carried
   *  automatically with the story. See shared/token-probabilities.ts. */
  tokenProbabilities?: true;
  /** Which child continues the line through this node. null = no preference
   *  recorded (leaf, or story ends here on purpose). Must be a child's id. */
  activeChildId: string | null;
}

export const TAG_STATUSES = ["", "Canon", "Alt", "Draft", "Discarded", "Summary"] as const;

export type TagStatus = (typeof TAG_STATUSES)[number];

export function isTagStatus(value: string): value is TagStatus {
  return (TAG_STATUSES as readonly string[]).includes(value);
}

/** A name and status pinned to the end of one story line: the only durable
 * handle on a version of the story. An untagged line has no name beyond its
 * first few words and no protection from pruning.
 *
 * Not to be confused with `StoryFact.tag`, which is a short label on a single
 * fact. This tags a story line; that labels a fact. */
export interface Tag {
  /** The tagged leaf. One tag per node. */
  nodeId: string;
  name: string;
  status: TagStatus;
  color: string;
  createdAt: string;
}

export const MAX_RECENT_LINES = 5;

interface NodeStubBase {
  id: string;
  parentId: string | null;
  preview: string;
  words: number;
  tokens: number;
  childCount: number;
  leafCount: number;
  lastTouched: string;
  updatedAt?: string;
  human?: true;
  /** See StoryNode.tokenProbabilities. */
  tokenProbabilities?: true;
  hasInstruction: boolean;
  activeChildId: string | null;
}

/** Ordinary prose and legacy summary-take stubs. A legacy role:"summary"
 * node has no chapterBreakId and remains valid protocol-v3 data. */
export interface OrdinaryNodeStub extends NodeStubBase {
  role?: "summary";
  chapterBreakId?: undefined;
  text?: string;
  instruction?: string;
  coveredExtent?: CoveredExtent;
  madeAt?: string;
  editedByUser?: true;
}

/** Provider-ready chapter summary guaranteed by HTTP protocol v3. */
export interface ChapterSummaryNodeStub extends NodeStubBase {
  role: "summary";
  chapterBreakId: string;
  text: string;
  instruction: string;
  coveredExtent?: CoveredExtent;
  madeAt?: string;
  editedByUser?: true;
}

export type NodeStub = OrdinaryNodeStub | ChapterSummaryNodeStub;

export function isChapterSummaryNodeStub(node: NodeStub): node is ChapterSummaryNodeStub {
  return node.chapterBreakId !== undefined;
}

export interface StoryPayload {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  origin?: StoryOrigin;
  authorsNote?: string;
  /** How many story parts from the end the note lands before. Absent means
   *  the default placement (immediately before the last part). See
   *  `resolveAuthorsNoteDepth`. */
  authorsNoteDepth?: number;
  /** Story-scoped override of `writing.defaultAuthorBrief`; absent falls back
   *  to the machine-wide value. See `resolveAuthorBrief`. */
  authorBrief?: string;
  /** Adds to the routed profile's own `phraseBias`, rather than replacing it
   *  — a vault-wide list of habits to avoid stays useful while one story
   *  adds its own words (issue #341). A story entry that conflicts with a
   *  profile entry overrides it instead of blocking the request; a conflict
   *  between two entries in the same scope still blocks, exactly as a
   *  profile-only conflict always has. See
   *  `server/sampling-phrase-bias.ts`'s `combineSamplingBiasSources`, the
   *  one place that combines the two scopes, for the exact rule. Absent
   *  means the story contributes nothing beyond the profile's own value. */
  phraseBias?: readonly SamplingPhraseBiasEntryV2[];
  /** Same story-adds-to-profile relationship as `phraseBias`, for the
   *  banned-strings list. */
  bannedStrings?: readonly string[];
  firstChapterTitle?: string;
  nodes: NodeStub[];
  path: StoryNode[];
  activeRootId: string | null;
  tags: Tag[];
  recentNodeIds: string[];
  facts: StoryFact[];
  /** Estimated-token cap across every emitted Fact; absent means uncapped. */
  factsBudgetTokens?: number;
  chapterBreaks: ChapterBreak[];
  /** Successor-Q optimistic-concurrency token. Predecessor responses omit it. */
  aggregateVersion?: import("./story-aggregate-version.js").StoryAggregateVersion;
}

/** Runtime protocol-v3 boundary. Call once when an HTTP payload enters the
 * client; presentation and request projection can then trust NodeStub's union. */
export function assertPromptReadyStoryPayload(value: unknown): asserts value is StoryPayload {
  const candidate = requireRecord(value, "The server did not return a story payload.");
  if (!Array.isArray(candidate.nodes)) throw new Error("The server did not return a story payload.");
  // Lead with the protocol-v3 diagnostic even when an incompatible fixture is
  // otherwise incomplete; this is the one field older servers cannot supply.
  for (const item of candidate.nodes) {
    const node = requireRecord(item, "The server returned an invalid story node stub.");
    if (node.chapterBreakId === undefined) continue;
    if (
      typeof node.chapterBreakId !== "string"
      || node.role !== "summary"
      || typeof node.text !== "string"
      || typeof node.instruction !== "string"
    ) {
      throw new Error(`Chapter summary ${node.id} is not provider-ready; reconnect to a protocol-v3 server.`);
    }
  }
  requireStrings(candidate, "story payload", "id", "title", "createdAt", "updatedAt");
  requireNullableString(candidate, "activeRootId", "story payload");
  const path = requireArray(candidate, "path", "story payload");
  const tags = requireArray(candidate, "tags", "story payload");
  const recentNodeIds = requireArray(candidate, "recentNodeIds", "story payload");
  const facts = requireArray(candidate, "facts", "story payload");
  const chapterBreaks = requireArray(candidate, "chapterBreaks", "story payload");
  candidate.nodes.forEach(assertNodeStub);
  path.forEach(assertStoryNode);
  tags.forEach(assertTag);
  if (!recentNodeIds.every((id) => typeof id === "string")) {
    throw new Error("The server returned invalid story payload.recentNodeIds.");
  }
  facts.forEach(assertStoryFact);
  if (candidate.factsBudgetTokens !== undefined) {
    requirePositiveInteger(candidate.factsBudgetTokens, "story payload", "factsBudgetTokens");
  }
  chapterBreaks.forEach(assertChapterBreak);
  if (candidate.origin !== undefined) assertStoryOrigin(candidate.origin);
  if (
    candidate.firstChapterTitle !== undefined
    && typeof candidate.firstChapterTitle !== "string"
  ) {
    throw new Error("The server returned an invalid story payload.firstChapterTitle.");
  }
  assertAuthorsNote(candidate.authorsNote);
  assertAuthorsNoteDepth(candidate.authorsNoteDepth);
  assertAuthorBrief(candidate.authorBrief);
  assertStoryPhraseBias(candidate.phraseBias);
  assertStoryBannedStrings(candidate.bannedStrings);
  if (candidate.aggregateVersion !== undefined) {
    assertStoryAggregateVersion(
      candidate.aggregateVersion,
      "story payload.aggregateVersion"
    );
  }
}

function assertNodeStub(value: unknown): void {
  const node = requireRecord(value, "The server returned an invalid story node stub.");
  requireStrings(node, "story node stub", "id", "preview", "lastTouched");
  requireNullableString(node, "parentId", "story node stub");
  requireNullableString(node, "activeChildId", "story node stub");
  requireNumbers(node, "story node stub", "words", "tokens", "childCount", "leafCount");
  if (typeof node.hasInstruction !== "boolean") invalidField("story node stub", "hasInstruction");
  optionalString(node, "updatedAt", "story node stub");
  optionalString(node, "text", "story node stub");
  optionalString(node, "instruction", "story node stub");
  optionalString(node, "madeAt", "story node stub");
  optionalLiteral(node, "human", true, "story node stub");
  optionalLiteral(node, "editedByUser", true, "story node stub");
  optionalLiteral(node, "tokenProbabilities", true, "story node stub");
  optionalLiteral(node, "role", "summary", "story node stub");
  if (node.chapterBreakId !== undefined && typeof node.chapterBreakId !== "string") {
    invalidField("story node stub", "chapterBreakId");
  }
  if (node.coveredExtent !== undefined) assertCoveredExtent(node.coveredExtent, "story node stub.coveredExtent");
}

export function assertStoryNode(value: unknown): asserts value is StoryNode {
  const node = requireRecord(value, "The server returned an invalid story path node.");
  requireStrings(node, "story path node", "id", "instruction", "text", "model", "createdAt");
  requireNullableString(node, "parentId", "story path node");
  requireNullableString(node, "activeChildId", "story path node");
  for (const field of ["updatedAt", "genId", "chapterBreakId", "madeAt"] as const) {
    optionalString(node, field, "story path node");
  }
  optionalLiteral(node, "human", true, "story path node");
  optionalLiteral(node, "editedByUser", true, "story path node");
  optionalLiteral(node, "tokenProbabilities", true, "story path node");
  optionalLiteral(node, "role", "summary", "story path node");
  if (node.coveredExtent !== undefined) assertCoveredExtent(node.coveredExtent, "story path node.coveredExtent");
  if (node.attribution !== undefined && node.attribution !== null) {
    const attribution = requireRecord(node.attribution, "The server returned invalid human attribution.");
    if (attribution.source !== "human" || !Array.isArray(attribution.ranges)) {
      throw new Error("The server returned invalid human attribution.");
    }
    for (const value of attribution.ranges) {
      const range = requireRecord(value, "The server returned an invalid human attribution range.");
      requireNumbers(range, "human attribution range", "start", "end");
    }
    if (attribution.deletedCharacters !== undefined) {
      requireNumber(attribution.deletedCharacters, "human attribution", "deletedCharacters");
    }
  }
  if (node.rewrittenSpans !== undefined) {
    if (!Array.isArray(node.rewrittenSpans)) {
      throw new Error("The server returned an invalid rewritten span list.");
    }
    for (const value of node.rewrittenSpans) {
      const range = requireRecord(value, "The server returned an invalid rewritten span.");
      requireNumbers(range, "rewritten span", "start", "end");
    }
  }
}

function assertTag(value: unknown): void {
  const tag = requireRecord(value, "The server returned an invalid tag.");
  requireStrings(tag, "tag", "nodeId", "name", "status", "color", "createdAt");
  if (typeof tag.status !== "string" || !isTagStatus(tag.status)) invalidField("tag", "status");
}

function assertStoryFact(value: unknown): void {
  const fact = requireRecord(value, "The server returned an invalid fact.");
  requireStrings(fact, "fact", "id", "text", "activation", "createdAt", "updatedAt");
  if (fact.tag !== null && typeof fact.tag !== "string") invalidField("fact", "tag");
  if (fact.activation !== "always" && fact.activation !== "keyed") invalidField("fact", "activation");
  if (!Array.isArray(fact.keys)) invalidField("fact", "keys");
  try {
    parseFactMetadata(fact, "fact");
  } catch (error) {
    if (error instanceof FactActivationError) throw new Error(`The server returned an invalid fact: ${error.message}`);
    throw error;
  }
  if (fact.budgetTokens !== undefined) requirePositiveInteger(fact.budgetTokens, "fact", "budgetTokens");
  optionalString(fact, "sourcePartId", "fact");
}

function requirePositiveInteger(value: unknown, label: string, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalidField(label, field);
}

export function assertChapterBreak(value: unknown): asserts value is ChapterBreak {
  const chapterBreak = requireRecord(value, "The server returned an invalid chapter break.");
  requireStrings(chapterBreak, "chapter break", "id", "parentPartId", "title", "createdAt");
}

function assertStoryOrigin(value: unknown): void {
  const origin = requireRecord(value, "The server returned an invalid story origin.");
  requireStrings(origin, "story origin", "storyId", "storyTitle", "partId", "createdAt");
  if (origin.offset !== null) requireNumber(origin.offset, "story origin", "offset");
}

function assertCoveredExtent(value: unknown, label: string): void {
  const extent = requireRecord(value, `The server returned an invalid ${label}.`);
  requireStrings(extent, label, "fromPartId", "toPartId");
}

/** The one place every reader and validator checks "is this a JSON object,
 * not an array or null." */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function requireArray(value: Record<string, unknown>, field: string, label: string): unknown[] {
  if (!Array.isArray(value[field])) invalidField(label, field);
  return value[field] as unknown[];
}

function requireStrings(value: Record<string, unknown>, label: string, ...fields: string[]): void {
  for (const field of fields) if (typeof value[field] !== "string") invalidField(label, field);
}

function requireNumbers(value: Record<string, unknown>, label: string, ...fields: string[]): void {
  for (const field of fields) requireNumber(value[field], label, field);
}

function requireNumber(value: unknown, label: string, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidField(label, field);
}

function requireNullableString(value: Record<string, unknown>, field: string, label: string): void {
  if (value[field] !== null && typeof value[field] !== "string") invalidField(label, field);
}

function optionalString(value: Record<string, unknown>, field: string, label: string): void {
  if (value[field] !== undefined && typeof value[field] !== "string") invalidField(label, field);
}

function optionalLiteral(
  value: Record<string, unknown>, field: string, literal: string | true, label: string
): void {
  if (value[field] !== undefined && value[field] !== literal) invalidField(label, field);
}

function invalidField(label: string, field: string): never {
  throw new Error(`The server returned an invalid ${label}.${field}.`);
}

/** Where a branched story was forked from — enough to reconstruct a tree later. */
export interface StoryOrigin {
  storyId: string;
  storyTitle: string;
  partId: string;
  /** Character offset inside the origin part where the copy was cut; null = the full part was kept. */
  offset: number | null;
  createdAt: string;
}

export interface Story {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  origin?: StoryOrigin;
  authorsNote?: string;
  /** How many story parts from the end the note lands before. Absent means
   *  the default placement (immediately before the last part). See
   *  `resolveAuthorsNoteDepth`. */
  authorsNoteDepth?: number;
  /** Story-scoped override of `writing.defaultAuthorBrief`; absent falls back
   *  to the machine-wide value. See `resolveAuthorBrief`. */
  authorBrief?: string;
  /** See the field comment on the same name in `StoryPayload`. */
  phraseBias?: readonly SamplingPhraseBiasEntryV2[];
  /** See the field comment on the same name in `StoryPayload`. */
  bannedStrings?: readonly string[];
  /** Chapter one has no opening break to carry a name, so it carries one here.
   * Absent means unnamed, and an unnamed chapter one reads as the story. */
  firstChapterTitle?: string;
  nodes: StoryNode[];
  activeRootId: string | null;
  tags: Tag[];
  recentNodeIds: string[];
  facts: StoryFact[];
  /** Estimated-token cap across every emitted Fact; absent means uncapped. */
  factsBudgetTokens?: number;
  chapterBreaks: ChapterBreak[];
}

function assertAuthorsNote(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") invalidField("story payload", "authorsNote");
  if (hasUnpairedSurrogate(value)) {
    throw new Error("The server returned an invalid story payload.authorsNote: contains an unpaired Unicode surrogate.");
  }
  if (unicodeScalarLength(value, MAX_AUTHORS_NOTE_CHARS) > MAX_AUTHORS_NOTE_CHARS) {
    throw new Error(
      `The server returned an invalid story payload.authorsNote: must contain at most ${MAX_AUTHORS_NOTE_CHARS.toLocaleString()} Unicode scalar values.`
    );
  }
}

function assertAuthorsNoteDepth(value: unknown): void {
  if (value === undefined) return;
  if (!isValidAuthorsNoteDepth(value)) {
    throw new Error(
      `The server returned an invalid story payload.authorsNoteDepth: must be an integer from 1 to ${MAX_AUTHORS_NOTE_DEPTH}.`
    );
  }
}

function assertAuthorBrief(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") invalidField("story payload", "authorBrief");
  if (hasUnpairedSurrogate(value)) {
    throw new Error("The server returned an invalid story payload.authorBrief: contains an unpaired Unicode surrogate.");
  }
  if (unicodeScalarLength(value, MAX_AUTHOR_BRIEF_CHARS) > MAX_AUTHOR_BRIEF_CHARS) {
    throw new Error(
      `The server returned an invalid story payload.authorBrief: must contain at most ${MAX_AUTHOR_BRIEF_CHARS.toLocaleString()} Unicode scalar values.`
    );
  }
}

function assertStoryPhraseBias(value: unknown): void {
  if (value === undefined) return;
  try {
    validateSamplingPhraseBias(value, "story payload.phraseBias");
  } catch (error) {
    if (!(error instanceof SamplingValidationError)) throw error;
    throw new Error(`The server returned an invalid story payload.phraseBias: ${error.message}`);
  }
}

function assertStoryBannedStrings(value: unknown): void {
  if (value === undefined) return;
  try {
    validateSamplingBannedStrings(value, "story payload.bannedStrings");
  } catch (error) {
    if (!(error instanceof SamplingValidationError)) throw error;
    throw new Error(`The server returned an invalid story payload.bannedStrings: ${error.message}`);
  }
}

export interface StorySummary {
  id: string;
  title: string;
  updatedAt: string;
  partCount: number;
  words: number;
  forked: boolean;
  lineCount: number;
  /** Successor-Q optimistic-concurrency token. Predecessor responses omit it. */
  aggregateVersion?: import("./story-aggregate-version.js").StoryAggregateVersion;
}

export interface SwitchRequest {
  nodeId: string;
  expectedLineFingerprint?: string;
  stopAtNode?: boolean;
}

interface CreateNodeRequestBase {
  text: string;
  instruction?: string;
}

export interface CreateChildNodeRequest extends CreateNodeRequestBase {
  parentId: string | null;
  appendTo?: never;
  sourceNodeId?: never;
  genId?: string;
  expectedTextHash?: never;
}

export interface AppendNodeRequest extends CreateNodeRequestBase {
  parentId?: never;
  appendTo: string;
  sourceNodeId?: never;
  genId: string;
  expectedTextHash: string;
}

/** Copy an existing take into a new sibling, then apply a human edit. */
export interface CreateEditedTakeRequest extends CreateNodeRequestBase {
  parentId?: never;
  appendTo?: never;
  sourceNodeId: string;
  genId?: never;
  expectedTextHash: string;
}

export type CreateNodeRequest =
  | CreateChildNodeRequest
  | AppendNodeRequest
  | CreateEditedTakeRequest;

export interface EditNodeRequest {
  text?: string;
  instruction?: string;
  expectedTextHash: string;
}

export interface DeleteNodeRequest {
  expectedSubtreeCount: number;
}

export interface PruneUnusedTakesRequest {
  /** Opaque story revision captured with the preview; currently StoryPayload.updatedAt. */
  expectedStoryRevision: string;
  expectedTakeCount: number;
  expectedPartCount: number;
}

export interface TagRequest {
  name: string;
  status: TagStatus;
}

/** Wire body of POST /api/stories/:id/nodes/:nodeId/take-from-cut. */
export interface TakeFromCutRequest {
  offset: number;
  expected?: string;
}

/** Where a rewrite's result lands. "in-place" replaces the highlighted text in
 *  the current take; "take" forks a sibling instead, the way a manual edit's
 *  fork key does. One term, one meaning each — never call the fork "new" or
 *  the splice "default" elsewhere, so a reader only has one name to learn. */
export const REWRITE_DESTINATIONS = ["in-place", "take"] as const;
export type RewriteDestination = (typeof REWRITE_DESTINATIONS)[number];

/** An absent or unrecognized destination means "in-place": a client older
 *  than this field must keep replacing in place, never start forking takes
 *  it never asked for. */
export function resolveRewriteDestination(value: unknown): RewriteDestination {
  return value === "take" ? "take" : "in-place";
}

/** Wire body of POST /api/stories/:id/nodes/:nodeId/rewrite. */
export interface RewriteRequest {
  start: number;
  end: number;
  instruction: string;
  /** The exact text currently at [start, end) — the server rejects stale selections. */
  expected: string;
  /** Identifies the streamed attempt that a later partial settle can commit. */
  attemptId?: string;
  /** Absent means "in-place" — see `resolveRewriteDestination`. */
  destination?: RewriteDestination;
}

/** The largest imported file any entry point will read before format-specific validation. */
export const MAX_IMPORT_BYTES = 20_000_000;

/** Canonical stored story and chapter title character limit (matching manifest schema maxLength). */
export const MAX_STORED_TITLE_CHARS = 4096;

/** Shared ceiling for JSON API bodies, measured as received UTF-8 bytes. */
export const MAX_JSON_BODY_BYTES = 1_000_000;

const factRequestBytesEncoder = new TextEncoder();

/** Exact UTF-8 size of the body `api.createFact` sends for a batch of Facts.
 * Not card-specific: a lorebook import sizes its request the same way. */
export function factImportRequestBytes(facts: readonly FactInput[]): number {
  return factRequestBytesEncoder.encode(JSON.stringify({ facts })).byteLength;
}

/** Graceful drain window before a hung backend is force-terminated. */
export const BACKEND_SHUTDOWN_GRACE_MS = 30_000;

export const PROVIDER_VALUES = [
  "dry-run",
  "openai-compatible",
  "text-completion",
  "anthropic"
] as const;
export type Provider = (typeof PROVIDER_VALUES)[number];

export interface ModelServerCheckResult {
  /** ready = usable endpoint; warning = server answered but rejected the probe;
   *  error = the request could not be made or no response arrived. */
  state: "ready" | "warning" | "error";
  message: string;
}

export interface GenerationSettings {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKeyEnv: string | null;
  /** Absence means false. Persisted only by the format-2 basic editor. */
  allowInsecureHttp?: boolean;
  temperature: number | null;
  maxTokens: number;
  systemPrompt: string;
  /** The model's context window, for the usage meter. null = unknown, meter shows
   *  the estimate alone. Set by hand or by probing the backend. */
  contextWindow: number | null;
}

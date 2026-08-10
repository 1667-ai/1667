import type { PromptOperation, PromptRole, StablePromptBlockKind, VolatilePromptBlockKind } from "./prompt-plan.js";
import type { Provider } from "./types.js";

/**
 * Generation Records wire and storage types (Generation Records project).
 * See `shared/generation-record.ts` for the codec (create/serialize/parse)
 * that enforces every bound declared here; this module only declares the
 * shape and its size limits so both the codec and its callers can share one
 * source of truth without a circular import.
 */
export const GENERATION_RECORD_FORMAT = "1667-generation-record";
export const GENERATION_RECORD_SCHEMA_VERSION = 1;

export const MAX_GENERATION_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_GENERATION_RECORD_TEXT_CHARS = 65_536;
export const MAX_GENERATION_RECORD_ENTRIES = 32;
export const MAX_GENERATION_RECORD_SOURCE_PARTS = 8_192;
export const MAX_GENERATION_RECORD_ADJUSTMENTS = 16;
export const MAX_GENERATION_RECORD_FIELDS = 32;
export const MAX_GENERATION_RECORD_FIELD_NAME_CHARS = 128;
export const MAX_GENERATION_RECORD_FIELD_STRING_CHARS = 256;
export const MAX_GENERATION_RECORD_UNSUPPORTED_REASON_CHARS = 2_000;

export const GENERATION_RECORD_KINDS = [
  "continue",
  "append",
  "rewrite-take",
  "rewrite-in-place",
  "summary-take",
  "chapter-summary",
  "unsupported"
] as const;
export type GenerationRecordKind = (typeof GENERATION_RECORD_KINDS)[number];

export const GENERATION_RECORD_WIRE_PROTOCOLS = [
  "dry-run",
  "openai-chat-completions",
  "text-completions",
  "anthropic-messages"
] as const;
export type GenerationRecordWireProtocol = (typeof GENERATION_RECORD_WIRE_PROTOCOLS)[number];

export interface GenerationRecordRange {
  readonly start: number;
  readonly end: number;
}

export type GenerationRecordFieldValue = string | number | boolean;

/** One wire field this request actually sent, exactly as it was sent — a
 *  temperature the story's settings never asked for but a preset injected,
 *  a renamed `max_completion_tokens`, or a boolean like `stream`. Never the
 *  full wire body: this is the compact summary the architecture calls for. */
export interface GenerationRecordField {
  readonly field: string;
  readonly value: GenerationRecordFieldValue;
}

export const GENERATION_RECORD_ADJUSTMENT_STAGES = ["construction", "retry"] as const;
export type GenerationRecordAdjustmentStage = (typeof GENERATION_RECORD_ADJUSTMENT_STAGES)[number];

export const GENERATION_RECORD_ADJUSTMENT_ACTIONS = ["skipped-cached-refusal", "dropped", "added", "renamed"] as const;
export type GenerationRecordAdjustmentAction = (typeof GENERATION_RECORD_ADJUSTMENT_ACTIONS)[number];

/** One field this request's actual wire body diverges from a plain reading of
 *  settings for. `stage: "construction"` records a proactive strip made
 *  before the first attempt because an earlier request already learned this
 *  model refuses the field (`action: "skipped-cached-refusal"`) — nothing
 *  about *this* request triggered it. `stage: "retry"` records a field this
 *  request itself watched the provider reject and then dropped or renamed
 *  before a retry, with the 0-based `attempt` that made the change. Keeping
 *  the two stages apart is the point: one says "this request changed
 *  nothing, a prior request already knows better," the other says "this
 *  request adjusted itself mid-flight." */
export interface GenerationRecordAdjustment {
  readonly stage: GenerationRecordAdjustmentStage;
  readonly field: string;
  readonly action: GenerationRecordAdjustmentAction;
  readonly attempt?: number;
  readonly toField?: string;
}

export interface GenerationRecordEffectiveParameters {
  readonly wireProtocol: GenerationRecordWireProtocol;
  readonly fields: readonly GenerationRecordField[];
  readonly adjustments: readonly GenerationRecordAdjustment[];
}

export type GenerationRecordPromptBlockKind = StablePromptBlockKind | VolatilePromptBlockKind;
export const GENERATION_RECORD_PROMPT_BLOCK_KINDS = [
  "author-brief", "facts", "operation-contract", "source", "authors-note",
  "request", "selection", "boundary", "completion-marker"
] as const satisfies readonly GenerationRecordPromptBlockKind[];

/** A categorized prompt block whose text is not the story's own growing
 *  prose — the author brief, Facts, the operation contract, the Author's
 *  Note, a rewrite's own bounded passage, a summary's fixed excerpt, and
 *  every volatile block (the request, a rewrite selection, a boundary echo,
 *  a completion marker). Bounded and story-length-independent, so the exact
 *  text is kept inline. One entry per original prompt block — never merged
 *  with another block of the same kind — so entry order always matches the
 *  order the provider actually received. */
export interface GenerationRecordTextEntry {
  readonly role: PromptRole;
  readonly stability: "stable" | "volatile";
  readonly kind: GenerationRecordPromptBlockKind;
  readonly source: "text";
  readonly text: string;
}

/** One context part's contribution to a continuation or append prompt: the
 *  short, bounded direction that introduced it (kept inline — it is not
 *  content-addressed the way a node's prose is) paired with a reference to
 *  the exact text-revision identity its prose held at the moment the prompt
 *  was built. `server/story-objects.ts` reads the revision back on demand;
 *  the UTF-16 length is a cheap integrity witness. */
export interface GenerationRecordSourcePart {
  readonly nodeId: string;
  /** Mirrors `ContinuationPromptEntry`'s own category for a context part:
   *  ordinary story prose, or a chapter summary standing in for one. */
  readonly category: "recent" | "summary";
  readonly instruction: string;
  readonly revisionId: string;
  readonly textLength: number;
}

/** The "source" category: an ordered run of context parts from the story's
 *  own prior prose — the one potentially unbounded input a request can
 *  carry, since it grows with the story on every continuation. Storing it
 *  verbatim in every record would duplicate that growing text once per
 *  record, which is exactly the O(N^2) blowup the storage model must avoid,
 *  so each part carries a reference into the existing immutable revision
 *  store instead of a copy of its prose. A continuation's context is never
 *  more than one contiguous run split by the Author's Note (at most two
 *  `GenerationRecordSourceEntry` values total, one per side), so this stays
 *  a small, fixed number of top-level prompt entries no matter how deep the
 *  story grows — the depth lives in `parts`, not in the entry count. */
export interface GenerationRecordSourceEntry {
  readonly stability: "stable";
  readonly kind: "source";
  readonly source: "revisions";
  readonly parts: readonly GenerationRecordSourcePart[];
}

export type GenerationRecordPromptEntry = GenerationRecordTextEntry | GenerationRecordSourceEntry;

export interface GenerationRecordPrompt {
  readonly operation: PromptOperation;
  readonly entries: readonly GenerationRecordPromptEntry[];
}

export interface GenerationRecordProvider {
  readonly provider: Provider;
  readonly model: string;
}

export interface GenerationRecord {
  readonly format: typeof GENERATION_RECORD_FORMAT;
  readonly schemaVersion: typeof GENERATION_RECORD_SCHEMA_VERSION;
  readonly kind: GenerationRecordKind;
  readonly createdAt: string;
  /** The affected text segment in the take's stored text, when this event
   *  touched one: an append's new tail, a rewrite's replaced selection.
   *  Absent for a whole-node event (a new take, a summary, a chapter
   *  summary). */
  readonly range?: GenerationRecordRange;
  readonly provider: GenerationRecordProvider;
  readonly effective: GenerationRecordEffectiveParameters;
  readonly prompt: GenerationRecordPrompt;
  /** Present only when `kind === "unsupported"`: a production path that could
   *  not safely capture a full record explains itself here instead of
   *  silently omitting one. */
  readonly unsupportedReason?: string;
}

/** The lightweight projection `GET
 *  /api/stories/:id/nodes/:nodeId/generation-records` returns for every id
 *  in a node's history — enough to render a history list without loading
 *  each record's full prompt pipeline and effective parameters, which the
 *  detail route fetches per id on demand. */
export interface GenerationRecordSummary {
  readonly id: string;
  readonly kind: GenerationRecordKind;
  readonly createdAt: string;
  readonly range?: GenerationRecordRange;
}

/** What a capture site has in hand before `createGenerationRecord` enforces
 *  every bound and freezes it into a `GenerationRecord`. Kept as its own type
 *  so a capture site can never persist a record without going through the
 *  one function that validates it. */
export type GenerationRecordInput = Omit<GenerationRecord, "format" | "schemaVersion">;

export class GenerationRecordFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationRecordFormatError";
  }
}

/** One context part's prose, resolved back to its exact historical text — the
 *  read model `server/generation-record-resolve.ts` produces from a stored
 *  `GenerationRecordSourcePart` on demand. Never persisted: a node's later
 *  rewrite must not change what an older record shows, so resolution always
 *  reads the revision the record actually referenced, not the node's current
 *  text. */
export interface ResolvedGenerationRecordSourcePart {
  readonly nodeId: string;
  readonly category: "recent" | "summary";
  readonly instruction: string;
  readonly revisionId: string;
  readonly text: string;
}

export interface ResolvedGenerationRecordSourceEntry {
  readonly stability: "stable";
  readonly kind: "source";
  readonly source: "revisions";
  readonly parts: readonly ResolvedGenerationRecordSourcePart[];
}

export type ResolvedGenerationRecordPromptEntry = GenerationRecordTextEntry | ResolvedGenerationRecordSourceEntry;

export interface ResolvedGenerationRecordPrompt {
  readonly operation: PromptOperation;
  readonly entries: readonly ResolvedGenerationRecordPromptEntry[];
}

/** The wire and TUI-facing shape of one Generation Record: identical to the
 *  stored `GenerationRecord` except every source part's prose is resolved to
 *  its exact historical text instead of a bare revision reference, which the
 *  reader has no way to look up on its own. `server/stories.ts`'s
 *  `loadGenerationRecord` is the one place that produces this; the stored,
 *  reference-based shape never leaves the server. */
export interface ResolvedGenerationRecord extends Omit<GenerationRecord, "prompt"> {
  readonly prompt: ResolvedGenerationRecordPrompt;
}

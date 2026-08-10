import type { PromptOperation, PromptRole } from "./prompt-plan.js";
import {
  boundedEntryText,
  requireArray,
  requireKeys,
  requireRecord,
  requireString
} from "./generation-record-validation.js";
import {
  GENERATION_RECORD_FORMAT,
  GENERATION_RECORD_ID_PATTERN,
  GENERATION_RECORD_KINDS,
  GENERATION_RECORD_PROMPT_BLOCK_KINDS,
  GENERATION_RECORD_PROMPT_OPERATIONS,
  GENERATION_RECORD_PROMPT_ROLES,
  GENERATION_RECORD_SCHEMA_VERSION,
  GENERATION_RECORD_SOURCE_CATEGORIES,
  GenerationRecordFormatError,
  MAX_GENERATION_RECORD_ENTRIES,
  MAX_GENERATION_RECORD_FIELD_STRING_CHARS,
  MAX_GENERATION_RECORD_SOURCE_PARTS,
  MAX_GENERATION_RECORD_TEXT_CHARS,
  MAX_GENERATION_RECORD_UNSUPPORTED_REASON_CHARS,
  type GenerationRecordKind,
  type GenerationRecordPromptBlockKind,
  type GenerationRecordSummary,
  type GenerationRecordTextEntry,
  type ResolvedGenerationRecord,
  type ResolvedGenerationRecordPrompt,
  type ResolvedGenerationRecordPromptEntry,
  type ResolvedGenerationRecordSourceEntry,
  type ResolvedGenerationRecordSourcePart
} from "./generation-record-types.js";
import {
  parseGenerationRecordEffectiveParameters,
  parseGenerationRecordProvider,
  parseGenerationRecordRange,
  requireUnsupportedReasonPairing
} from "./generation-record.js";

/**
 * Parses the two read-model shapes `server/stories.ts` sends the TUI over
 * HTTP: `ResolvedGenerationRecord` (the single-record detail route) and
 * `GenerationRecordSummary` (the per-node history list). Both differ from
 * the stored `GenerationRecord` in exactly one place — a source part's prose
 * is resolved inline instead of left as a bare revision reference — so this
 * module reuses `shared/generation-record.ts`'s range, provider, and
 * effective-parameters parsers unchanged and adds only what that difference
 * requires. `label` threads a caller-chosen path prefix (e.g. "Generation
 * Record" or "Generation Record summary[3]") through every nested error, the
 * same convention the stored codec uses for its own field paths.
 */

export function parseGenerationRecordSummary(value: unknown, label: string): GenerationRecordSummary {
  const record = requireRecord(value, label);
  requireKeys(record, ["id", "kind", "createdAt"], ["range"], label);
  return {
    id: requireGenerationRecordId(record.id, `${label}.id`),
    kind: requireKind(record.kind, `${label}.kind`),
    createdAt: requireNonEmpty(record.createdAt, `${label}.createdAt`),
    ...(record.range === undefined ? {} : { range: parseGenerationRecordRange(record.range, `${label}.range`) })
  };
}

export function parseResolvedGenerationRecord(value: unknown, label: string): ResolvedGenerationRecord {
  const record = requireRecord(value, label);
  if (record.format !== GENERATION_RECORD_FORMAT) throw new GenerationRecordFormatError(`${label}.format is invalid`);
  if (record.schemaVersion !== GENERATION_RECORD_SCHEMA_VERSION) {
    throw new GenerationRecordFormatError(`${label}.schemaVersion is invalid`);
  }
  requireKeys(
    record,
    ["format", "schemaVersion", "kind", "createdAt", "provider", "effective", "prompt"],
    ["range", "unsupportedReason"],
    label
  );
  const kind = requireKind(record.kind, `${label}.kind`);
  const present = record.unsupportedReason !== undefined;
  requireUnsupportedReasonPairing(kind, present, `${label}.unsupportedReason`);
  return {
    format: GENERATION_RECORD_FORMAT,
    schemaVersion: GENERATION_RECORD_SCHEMA_VERSION,
    kind,
    createdAt: requireNonEmpty(record.createdAt, `${label}.createdAt`),
    ...(record.range === undefined ? {} : { range: parseGenerationRecordRange(record.range, `${label}.range`) }),
    provider: parseGenerationRecordProvider(record.provider, `${label}.provider`),
    effective: parseGenerationRecordEffectiveParameters(record.effective, `${label}.effective`),
    prompt: parseResolvedPrompt(record.prompt, `${label}.prompt`),
    ...(present ? { unsupportedReason: requireBoundedUnsupportedReason(record.unsupportedReason, `${label}.unsupportedReason`) } : {})
  };
}

function requireKind(value: unknown, label: string): GenerationRecordKind {
  if (typeof value !== "string" || !(GENERATION_RECORD_KINDS as readonly string[]).includes(value)) {
    throw new GenerationRecordFormatError(`${label} is invalid`);
  }
  return value as GenerationRecordKind;
}

function requireNonEmpty(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (text.length === 0) throw new GenerationRecordFormatError(`${label} must be a non-empty string`);
  return text;
}

function requireGenerationRecordId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!GENERATION_RECORD_ID_PATTERN.test(id)) throw new GenerationRecordFormatError(`${label} is invalid`);
  return id;
}

function requireBoundedUnsupportedReason(value: unknown, label: string): string {
  const reason = requireString(value, label);
  if (reason.length > MAX_GENERATION_RECORD_UNSUPPORTED_REASON_CHARS) {
    throw new GenerationRecordFormatError(`${label} exceeds the ${MAX_GENERATION_RECORD_UNSUPPORTED_REASON_CHARS}-character limit`);
  }
  return reason;
}

function parseResolvedPrompt(value: unknown, label: string): ResolvedGenerationRecordPrompt {
  const prompt = requireRecord(value, label);
  requireKeys(prompt, ["operation", "entries"], [], label);
  const operation = requireString(prompt.operation, `${label}.operation`);
  if (!(GENERATION_RECORD_PROMPT_OPERATIONS as readonly string[]).includes(operation)) {
    throw new GenerationRecordFormatError(`${label}.operation is invalid`);
  }
  const entries = requireArray(prompt.entries, `${label}.entries`);
  if (entries.length > MAX_GENERATION_RECORD_ENTRIES) {
    throw new GenerationRecordFormatError(`${label}.entries exceeds the ${MAX_GENERATION_RECORD_ENTRIES}-entry limit`);
  }
  return {
    operation: operation as PromptOperation,
    entries: entries.map((entry, index) => parseResolvedPromptEntry(entry, `${label}.entries[${index}]`))
  };
}

/** Discriminates on `entry.source`, matching the stored codec's own
 *  `clonePromptEntry`: kind "source" is legitimately either a resolved run
 *  of context parts (`source: "revisions"`) or a bounded excerpt kept
 *  inline like any other text entry (`source: "text"`). */
function parseResolvedPromptEntry(value: unknown, label: string): ResolvedGenerationRecordPromptEntry {
  const entry = requireRecord(value, label);
  if (entry.source === "revisions") return parseResolvedSourceEntry(entry, label);
  if (entry.source !== "text") throw new GenerationRecordFormatError(`${label}.source must be "text" or "revisions"`);
  return parseTextEntry(entry, label);
}

function parseTextEntry(entry: Record<string, unknown>, label: string): GenerationRecordTextEntry {
  requireKeys(entry, ["role", "stability", "kind", "source", "text"], [], label);
  if (!(GENERATION_RECORD_PROMPT_BLOCK_KINDS as readonly string[]).includes(entry.kind as string)) {
    throw new GenerationRecordFormatError(`${label}.kind is invalid`);
  }
  if (!(GENERATION_RECORD_PROMPT_ROLES as readonly string[]).includes(entry.role as string)) {
    throw new GenerationRecordFormatError(`${label}.role is invalid`);
  }
  if (entry.stability !== "stable" && entry.stability !== "volatile") {
    throw new GenerationRecordFormatError(`${label}.stability is invalid`);
  }
  const text = boundedEntryText(requireString(entry.text, `${label}.text`), `${label}.text`, MAX_GENERATION_RECORD_TEXT_CHARS);
  return {
    role: entry.role as PromptRole,
    stability: entry.stability,
    kind: entry.kind as GenerationRecordPromptBlockKind,
    source: "text",
    text
  };
}

function parseResolvedSourceEntry(entry: Record<string, unknown>, label: string): ResolvedGenerationRecordSourceEntry {
  requireKeys(entry, ["stability", "kind", "source", "parts"], [], label);
  if (entry.kind !== "source") throw new GenerationRecordFormatError(`${label}.kind must be "source" when source is "revisions"`);
  if (entry.stability !== "stable") throw new GenerationRecordFormatError(`${label}.stability must be "stable" for kind "source"`);
  const parts = requireArray(entry.parts, `${label}.parts`);
  if (parts.length > MAX_GENERATION_RECORD_SOURCE_PARTS) {
    throw new GenerationRecordFormatError(`${label}.parts exceeds the ${MAX_GENERATION_RECORD_SOURCE_PARTS}-part limit`);
  }
  return {
    stability: "stable",
    kind: "source",
    source: "revisions",
    parts: parts.map((part, index) => parseResolvedSourcePart(part, `${label}.parts[${index}]`))
  };
}

/** The one shape that actually differs from the stored codec's own
 *  `cloneSourcePart`: `text` replaces `textLength` — the resolved prose
 *  itself, read back from the exact historical revision
 *  (`server/generation-record-resolve.ts`). Left unbounded on purpose, same
 *  as the stored side leaves the underlying revision's length unbounded: a
 *  context part's prose is the story's own growing text, not a bounded
 *  prompt block. Every other field keeps the stored side's own bound. */
function parseResolvedSourcePart(value: unknown, label: string): ResolvedGenerationRecordSourcePart {
  const part = requireRecord(value, label);
  requireKeys(part, ["nodeId", "category", "instruction", "revisionId", "text"], [], label);
  const category = requireString(part.category, `${label}.category`);
  if (!(GENERATION_RECORD_SOURCE_CATEGORIES as readonly string[]).includes(category)) {
    throw new GenerationRecordFormatError(`${label}.category is invalid`);
  }
  const nodeId = requireString(part.nodeId, `${label}.nodeId`);
  if (nodeId.length === 0 || nodeId.length > MAX_GENERATION_RECORD_FIELD_STRING_CHARS) {
    throw new GenerationRecordFormatError(`${label}.nodeId is invalid`);
  }
  const revisionId = requireString(part.revisionId, `${label}.revisionId`);
  if (!GENERATION_RECORD_ID_PATTERN.test(revisionId)) throw new GenerationRecordFormatError(`${label}.revisionId is invalid`);
  const instruction = boundedEntryText(
    requireString(part.instruction, `${label}.instruction`),
    `${label}.instruction`,
    MAX_GENERATION_RECORD_TEXT_CHARS
  );
  return {
    nodeId,
    category: category as ResolvedGenerationRecordSourcePart["category"],
    instruction,
    revisionId,
    text: requireString(part.text, `${label}.text`)
  };
}

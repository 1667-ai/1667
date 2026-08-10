import type { PromptOperation, PromptRole } from "./prompt-plan.js";
import { PROVIDER_VALUES } from "./types.js";
import {
  boundedEntryText,
  parseJsonObject,
  requireArray,
  requireBoundedString,
  requireKeys,
  requireNonEmptyString,
  requireRecord,
  requireSafeInteger,
  requireString,
  sha256Hex
} from "./generation-record-validation.js";
import {
  GENERATION_RECORD_ADJUSTMENT_ACTIONS,
  GENERATION_RECORD_ADJUSTMENT_STAGES,
  GENERATION_RECORD_FORMAT,
  GENERATION_RECORD_KINDS,
  GENERATION_RECORD_PROMPT_BLOCK_KINDS,
  GENERATION_RECORD_SCHEMA_VERSION,
  GENERATION_RECORD_WIRE_PROTOCOLS,
  GenerationRecordFormatError,
  MAX_GENERATION_RECORD_ADJUSTMENTS,
  MAX_GENERATION_RECORD_BYTES,
  MAX_GENERATION_RECORD_ENTRIES,
  MAX_GENERATION_RECORD_FIELDS,
  MAX_GENERATION_RECORD_FIELD_NAME_CHARS,
  MAX_GENERATION_RECORD_FIELD_STRING_CHARS,
  MAX_GENERATION_RECORD_SOURCE_PARTS,
  MAX_GENERATION_RECORD_TEXT_CHARS,
  MAX_GENERATION_RECORD_UNSUPPORTED_REASON_CHARS,
  type GenerationRecord,
  type GenerationRecordAdjustment,
  type GenerationRecordAdjustmentAction,
  type GenerationRecordAdjustmentStage,
  type GenerationRecordEffectiveParameters,
  type GenerationRecordField,
  type GenerationRecordInput,
  type GenerationRecordKind,
  type GenerationRecordProvider,
  type GenerationRecordPrompt,
  type GenerationRecordPromptBlockKind,
  type GenerationRecordPromptEntry,
  type GenerationRecordRange,
  type GenerationRecordSourcePart,
  type GenerationRecordTextEntry,
  type GenerationRecordWireProtocol
} from "./generation-record-types.js";

export * from "./generation-record-types.js";

/**
 * The Generation Records codec (Generation Records project): validates every
 * bound declared in `shared/generation-record-types.ts` and freezes a record
 * into the exact canonical bytes its content address hashes. Mirrors
 * `shared/token-probabilities.ts`'s `parseTokenProbabilities` /
 * `serializeTokenProbabilities` pair.
 *
 * A record never carries a credential, a header value, a base URL, or
 * response text — `server/generation-record-capture.ts` builds one only from
 * values that are already provider-neutral and already safe to persist.
 *
 * This shape is frozen the same way `shared/token-probabilities.ts` is: the
 * serialized bytes are hashed for the object's content address, so a later
 * migration would have to reach every story that ever stored one.
 */

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const PROMPT_ROLES: readonly PromptRole[] = ["system", "user", "assistant"];
const PROMPT_OPERATIONS: readonly PromptOperation[] = ["continue", "rewrite", "title", "summary"];
const SOURCE_PART_CATEGORIES = ["recent", "summary"] as const;

export function createGenerationRecord(input: GenerationRecordInput): GenerationRecord {
  const record: GenerationRecord = {
    format: GENERATION_RECORD_FORMAT,
    schemaVersion: GENERATION_RECORD_SCHEMA_VERSION,
    kind: requireKind(input.kind),
    createdAt: requireNonEmptyString(input.createdAt, "createdAt"),
    ...(input.range === undefined ? {} : { range: cloneRange(input.range) }),
    provider: cloneProvider(input.provider),
    effective: cloneEffective(input.effective),
    prompt: clonePrompt(input.prompt),
    ...(input.unsupportedReason === undefined ? {} : {
      unsupportedReason: requireBoundedString(
        input.unsupportedReason,
        "unsupportedReason",
        MAX_GENERATION_RECORD_UNSUPPORTED_REASON_CHARS
      )
    })
  };
  if (record.kind === "unsupported" && record.unsupportedReason === undefined) {
    throw new GenerationRecordFormatError('unsupportedReason is required when kind is "unsupported"');
  }
  if (record.kind !== "unsupported" && record.unsupportedReason !== undefined) {
    throw new GenerationRecordFormatError('unsupportedReason is only allowed when kind is "unsupported"');
  }
  assertEncodedSize(record);
  return record;
}

/** Every text-revision id a record references, for `server/story-objects.ts`
 *  to root as live alongside the record's own object id — the mechanism that
 *  keeps a superseded revision's chunks from being swept while a generation
 *  record still points at them. */
export function generationRecordSourceRevisionIds(record: GenerationRecord): string[] {
  const ids: string[] = [];
  for (const entry of record.prompt.entries) {
    if (entry.source === "revisions") {
      for (const part of entry.parts) ids.push(part.revisionId);
    }
  }
  return ids;
}

/** Byte-stable: the same record always produces the same bytes, because the
 *  bytes are what phase 3 hashes for the object's content address. One
 *  literal with a fixed key order, at every level. */
export function serializeGenerationRecord(record: GenerationRecord): string {
  return JSON.stringify({
    format: record.format,
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    createdAt: record.createdAt,
    ...(record.range === undefined ? {} : { range: { start: record.range.start, end: record.range.end } }),
    provider: { provider: record.provider.provider, model: record.provider.model },
    effective: {
      wireProtocol: record.effective.wireProtocol,
      fields: record.effective.fields.map((field) => ({ field: field.field, value: field.value })),
      adjustments: record.effective.adjustments.map((adjustment) => ({
        stage: adjustment.stage,
        field: adjustment.field,
        action: adjustment.action,
        ...(adjustment.attempt === undefined ? {} : { attempt: adjustment.attempt }),
        ...(adjustment.toField === undefined ? {} : { toField: adjustment.toField })
      }))
    },
    prompt: {
      operation: record.prompt.operation,
      entries: record.prompt.entries.map(serializePromptEntry)
    },
    ...(record.unsupportedReason === undefined ? {} : { unsupportedReason: record.unsupportedReason })
  });
}

function serializePromptEntry(entry: GenerationRecordPromptEntry): unknown {
  if (entry.source === "text") {
    return {
      role: entry.role,
      stability: entry.stability,
      kind: entry.kind,
      source: entry.source,
      text: entry.text
    };
  }
  return {
    stability: entry.stability,
    kind: entry.kind,
    source: entry.source,
    parts: entry.parts.map((part) => ({
      nodeId: part.nodeId,
      category: part.category,
      instruction: part.instruction,
      revisionId: part.revisionId,
      textLength: part.textLength
    }))
  };
}

/** Mirrors `parseTokenProbabilities`: check the hash first when the caller
 *  has one, decode, re-validate every bound through `createGenerationRecord`,
 *  then confirm the input was already the exact canonical bytes a fresh
 *  serialize would produce. */
export function parseGenerationRecord(raw: string, expectedHash?: string): GenerationRecord {
  if (Buffer.byteLength(raw, "utf8") > MAX_GENERATION_RECORD_BYTES) {
    throw new GenerationRecordFormatError(
      `Generation record exceeds the ${MAX_GENERATION_RECORD_BYTES.toLocaleString()}-byte size limit`
    );
  }
  if (expectedHash !== undefined) {
    if (!HASH_PATTERN.test(expectedHash)) throw new GenerationRecordFormatError("Invalid generation record id");
    if (sha256Hex(raw) !== expectedHash) {
      throw new GenerationRecordFormatError(`Generation record hash mismatch: ${expectedHash}`);
    }
  }
  const value = parseJsonObject(raw, "generation record");
  if (value.format !== GENERATION_RECORD_FORMAT) {
    throw new GenerationRecordFormatError("Unsupported generation record format");
  }
  if (value.schemaVersion !== GENERATION_RECORD_SCHEMA_VERSION) {
    throw new GenerationRecordFormatError("Unsupported generation record schema version");
  }
  requireKeys(
    value,
    ["format", "schemaVersion", "kind", "createdAt", "provider", "effective", "prompt"],
    ["range", "unsupportedReason"],
    "generation record"
  );
  const input: GenerationRecordInput = {
    kind: requireKind(value.kind),
    createdAt: requireString(value.createdAt, "createdAt"),
    ...(value.range === undefined ? {} : { range: parseRange(value.range) }),
    provider: parseProvider(value.provider),
    effective: parseEffective(value.effective),
    prompt: parsePrompt(value.prompt),
    ...(value.unsupportedReason === undefined ? {} : { unsupportedReason: requireString(value.unsupportedReason, "unsupportedReason") })
  };
  const record = createGenerationRecord(input);
  if (serializeGenerationRecord(record) !== raw) {
    throw new GenerationRecordFormatError("Generation record is not canonically serialized");
  }
  return record;
}

function requireKind(value: unknown): GenerationRecordKind {
  if (typeof value !== "string" || !(GENERATION_RECORD_KINDS as readonly string[]).includes(value)) {
    throw new GenerationRecordFormatError("Invalid generation record kind");
  }
  return value as GenerationRecordKind;
}

function cloneRange(range: GenerationRecordRange): GenerationRecordRange {
  if (
    !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end < range.start
  ) {
    throw new GenerationRecordFormatError("range must be a non-negative, non-decreasing integer pair");
  }
  return { start: range.start, end: range.end };
}

function parseRange(value: unknown): GenerationRecordRange {
  const range = requireRecord(value, "range");
  requireKeys(range, ["start", "end"], [], "range");
  return cloneRange({ start: requireSafeInteger(range.start, "range.start"), end: requireSafeInteger(range.end, "range.end") });
}

function cloneProvider(provider: GenerationRecordProvider): GenerationRecordProvider {
  if (!(PROVIDER_VALUES as readonly string[]).includes(provider.provider)) {
    throw new GenerationRecordFormatError("Invalid provider");
  }
  return {
    provider: provider.provider,
    model: requireBoundedString(provider.model, "provider.model", MAX_GENERATION_RECORD_FIELD_STRING_CHARS)
  };
}

function parseProvider(value: unknown): GenerationRecordProvider {
  const provider = requireRecord(value, "provider");
  requireKeys(provider, ["provider", "model"], [], "provider");
  return cloneProvider({
    provider: requireString(provider.provider, "provider.provider") as GenerationRecordProvider["provider"],
    model: requireString(provider.model, "provider.model")
  });
}

function cloneEffective(effective: GenerationRecordEffectiveParameters): GenerationRecordEffectiveParameters {
  if (!(GENERATION_RECORD_WIRE_PROTOCOLS as readonly string[]).includes(effective.wireProtocol)) {
    throw new GenerationRecordFormatError("Invalid wireProtocol");
  }
  if (effective.fields.length > MAX_GENERATION_RECORD_FIELDS) {
    throw new GenerationRecordFormatError(`effective.fields exceeds the ${MAX_GENERATION_RECORD_FIELDS}-field limit`);
  }
  if (effective.adjustments.length > MAX_GENERATION_RECORD_ADJUSTMENTS) {
    throw new GenerationRecordFormatError(`effective.adjustments exceeds the ${MAX_GENERATION_RECORD_ADJUSTMENTS}-entry limit`);
  }
  return {
    wireProtocol: effective.wireProtocol,
    fields: effective.fields.map((field, index) => cloneField(field, index)),
    adjustments: effective.adjustments.map((adjustment, index) => cloneAdjustment(adjustment, index))
  };
}

function cloneField(field: GenerationRecordField, index: number): GenerationRecordField {
  const name = requireBoundedString(field.field, `effective.fields[${index}].field`, MAX_GENERATION_RECORD_FIELD_NAME_CHARS);
  const value = field.value;
  if (typeof value === "string") {
    return { field: name, value: requireBoundedString(value, `effective.fields[${index}].value`, MAX_GENERATION_RECORD_FIELD_STRING_CHARS) };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GenerationRecordFormatError(`effective.fields[${index}].value must be finite`);
    return { field: name, value };
  }
  if (typeof value === "boolean") return { field: name, value };
  throw new GenerationRecordFormatError(`effective.fields[${index}].value must be a string, number, or boolean`);
}

function cloneAdjustment(adjustment: GenerationRecordAdjustment, index: number): GenerationRecordAdjustment {
  const label = `effective.adjustments[${index}]`;
  if (!(GENERATION_RECORD_ADJUSTMENT_STAGES as readonly string[]).includes(adjustment.stage)) {
    throw new GenerationRecordFormatError(`${label}.stage is invalid`);
  }
  if (!(GENERATION_RECORD_ADJUSTMENT_ACTIONS as readonly string[]).includes(adjustment.action)) {
    throw new GenerationRecordFormatError(`${label}.action is invalid`);
  }
  if (adjustment.attempt !== undefined && (!Number.isSafeInteger(adjustment.attempt) || adjustment.attempt < 0)) {
    throw new GenerationRecordFormatError(`${label}.attempt must be a non-negative integer`);
  }
  if (adjustment.action === "renamed" && adjustment.toField === undefined) {
    throw new GenerationRecordFormatError(`${label}.toField is required when action is "renamed"`);
  }
  if (adjustment.action !== "renamed" && adjustment.toField !== undefined) {
    throw new GenerationRecordFormatError(`${label}.toField is only allowed when action is "renamed"`);
  }
  return {
    stage: adjustment.stage,
    field: requireBoundedString(adjustment.field, `${label}.field`, MAX_GENERATION_RECORD_FIELD_NAME_CHARS),
    action: adjustment.action,
    ...(adjustment.attempt === undefined ? {} : { attempt: adjustment.attempt }),
    ...(adjustment.toField === undefined
      ? {}
      : { toField: requireBoundedString(adjustment.toField, `${label}.toField`, MAX_GENERATION_RECORD_FIELD_NAME_CHARS) })
  };
}

function parseEffective(value: unknown): GenerationRecordEffectiveParameters {
  const effective = requireRecord(value, "effective");
  requireKeys(effective, ["wireProtocol", "fields", "adjustments"], [], "effective");
  const fields = requireArray(effective.fields, "effective.fields").map((field, index) => parseField(field, index));
  const adjustments = requireArray(effective.adjustments, "effective.adjustments")
    .map((adjustment, index) => parseAdjustment(adjustment, index));
  return cloneEffective({
    wireProtocol: requireString(effective.wireProtocol, "effective.wireProtocol") as GenerationRecordWireProtocol,
    fields,
    adjustments
  });
}

function parseField(value: unknown, index: number): GenerationRecordField {
  const label = `effective.fields[${index}]`;
  const field = requireRecord(value, label);
  requireKeys(field, ["field", "value"], [], label);
  const raw = field.value;
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    throw new GenerationRecordFormatError(`${label}.value must be a string, number, or boolean`);
  }
  return { field: requireString(field.field, `${label}.field`), value: raw };
}

function parseAdjustment(value: unknown, index: number): GenerationRecordAdjustment {
  const label = `effective.adjustments[${index}]`;
  const adjustment = requireRecord(value, label);
  requireKeys(adjustment, ["stage", "field", "action"], ["attempt", "toField"], label);
  return cloneAdjustment({
    stage: requireString(adjustment.stage, `${label}.stage`) as GenerationRecordAdjustmentStage,
    field: requireString(adjustment.field, `${label}.field`),
    action: requireString(adjustment.action, `${label}.action`) as GenerationRecordAdjustmentAction,
    ...(adjustment.attempt === undefined ? {} : { attempt: requireSafeInteger(adjustment.attempt, `${label}.attempt`) }),
    ...(adjustment.toField === undefined ? {} : { toField: requireString(adjustment.toField, `${label}.toField`) })
  }, index);
}

function clonePrompt(prompt: GenerationRecordPrompt): GenerationRecordPrompt {
  if (!(PROMPT_OPERATIONS as readonly string[]).includes(prompt.operation)) {
    throw new GenerationRecordFormatError("Invalid prompt.operation");
  }
  if (prompt.entries.length > MAX_GENERATION_RECORD_ENTRIES) {
    throw new GenerationRecordFormatError(`prompt.entries exceeds the ${MAX_GENERATION_RECORD_ENTRIES}-entry limit`);
  }
  return {
    operation: prompt.operation,
    entries: prompt.entries.map((entry, index) => clonePromptEntry(entry, index))
  };
}

/** Discriminates on `entry.source`, never on `entry.kind`: kind "source" is
 *  legitimately either shape — an unbounded run of story context parts
 *  (`source: "revisions"`), or a rewrite's/summary's own bounded excerpt kept
 *  inline like any other text entry (`source: "text"`). */
function clonePromptEntry(entry: GenerationRecordPromptEntry, index: number): GenerationRecordPromptEntry {
  const label = `prompt.entries[${index}]`;
  if (!(GENERATION_RECORD_PROMPT_BLOCK_KINDS as readonly string[]).includes(entry.kind)) {
    throw new GenerationRecordFormatError(`${label}.kind is invalid`);
  }
  if (entry.source === "revisions") {
    if (entry.kind !== "source") throw new GenerationRecordFormatError(`${label}.kind must be "source" when source is "revisions"`);
    if (entry.stability !== "stable") throw new GenerationRecordFormatError(`${label}.stability must be "stable" for kind "source"`);
    if (entry.parts.length > MAX_GENERATION_RECORD_SOURCE_PARTS) {
      throw new GenerationRecordFormatError(`${label}.parts exceeds the ${MAX_GENERATION_RECORD_SOURCE_PARTS}-part limit`);
    }
    return {
      stability: "stable",
      kind: "source",
      source: "revisions",
      parts: entry.parts.map((part, partIndex) => cloneSourcePart(part, `${label}.parts[${partIndex}]`))
    };
  }
  if (!(PROMPT_ROLES as readonly string[]).includes(entry.role)) throw new GenerationRecordFormatError(`${label}.role is invalid`);
  if (entry.source !== "text") throw new GenerationRecordFormatError(`${label}.source must be "text" or "revisions"`);
  if (entry.stability !== "stable" && entry.stability !== "volatile") {
    throw new GenerationRecordFormatError(`${label}.stability is invalid`);
  }
  const text = boundedEntryText(entry.text, `${label}.text`, MAX_GENERATION_RECORD_TEXT_CHARS);
  return {
    role: entry.role,
    stability: entry.stability,
    kind: entry.kind,
    source: "text",
    text
  };
}

function cloneSourcePart(part: GenerationRecordSourcePart, label: string): GenerationRecordSourcePart {
  if (!HASH_PATTERN.test(part.revisionId)) throw new GenerationRecordFormatError(`${label}.revisionId is invalid`);
  if (part.nodeId.length === 0 || part.nodeId.length > MAX_GENERATION_RECORD_FIELD_STRING_CHARS) {
    throw new GenerationRecordFormatError(`${label}.nodeId is invalid`);
  }
  if (!(SOURCE_PART_CATEGORIES as readonly string[]).includes(part.category)) {
    throw new GenerationRecordFormatError(`${label}.category is invalid`);
  }
  if (!Number.isSafeInteger(part.textLength) || part.textLength < 0) {
    throw new GenerationRecordFormatError(`${label}.textLength must be a non-negative integer`);
  }
  const instruction = boundedEntryText(part.instruction, `${label}.instruction`, MAX_GENERATION_RECORD_TEXT_CHARS);
  return {
    nodeId: part.nodeId,
    category: part.category,
    instruction,
    revisionId: part.revisionId,
    textLength: part.textLength
  };
}

function parsePrompt(value: unknown): GenerationRecordPrompt {
  const prompt = requireRecord(value, "prompt");
  requireKeys(prompt, ["operation", "entries"], [], "prompt");
  const entries = requireArray(prompt.entries, "prompt.entries").map((entry, index) => parsePromptEntry(entry, index));
  return clonePrompt({ operation: requireString(prompt.operation, "prompt.operation") as PromptOperation, entries });
}

function parsePromptEntry(value: unknown, index: number): GenerationRecordPromptEntry {
  const label = `prompt.entries[${index}]`;
  const entry = requireRecord(value, label);
  const source = entry.source;
  if (source === "revisions") {
    requireKeys(entry, ["stability", "kind", "source", "parts"], [], label);
    const parts = requireArray(entry.parts, `${label}.parts`)
      .map((part, partIndex) => parseSourcePart(part, `${label}.parts[${partIndex}]`));
    return {
      stability: "stable",
      kind: "source",
      source: "revisions",
      parts
    };
  }
  requireKeys(entry, ["role", "stability", "kind", "source", "text"], [], label);
  return {
    role: requireString(entry.role, `${label}.role`) as PromptRole,
    stability: requireString(entry.stability, `${label}.stability`) as "stable" | "volatile",
    kind: requireString(entry.kind, `${label}.kind`) as GenerationRecordPromptBlockKind,
    source: "text",
    text: requireString(entry.text, `${label}.text`)
  };
}

function parseSourcePart(value: unknown, label: string): GenerationRecordSourcePart {
  const part = requireRecord(value, label);
  requireKeys(part, ["nodeId", "category", "instruction", "revisionId", "textLength"], [], label);
  return cloneSourcePart({
    nodeId: requireString(part.nodeId, `${label}.nodeId`),
    category: requireString(part.category, `${label}.category`) as GenerationRecordSourcePart["category"],
    instruction: requireString(part.instruction, `${label}.instruction`),
    revisionId: requireString(part.revisionId, `${label}.revisionId`),
    textLength: requireSafeInteger(part.textLength, `${label}.textLength`)
  }, label);
}

function assertEncodedSize(record: GenerationRecord): void {
  const bytes = Buffer.byteLength(serializeGenerationRecord(record), "utf8");
  if (bytes > MAX_GENERATION_RECORD_BYTES) {
    throw new GenerationRecordFormatError(
      `Generation record exceeds the ${MAX_GENERATION_RECORD_BYTES.toLocaleString()}-byte size limit`
    );
  }
}

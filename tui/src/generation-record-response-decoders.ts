import { PROVIDER_VALUES } from "../../shared/types.js";
import {
  GENERATION_RECORD_ADJUSTMENT_ACTIONS,
  GENERATION_RECORD_ADJUSTMENT_STAGES,
  GENERATION_RECORD_FORMAT,
  GENERATION_RECORD_KINDS,
  GENERATION_RECORD_PROMPT_BLOCK_KINDS,
  GENERATION_RECORD_SCHEMA_VERSION,
  GENERATION_RECORD_WIRE_PROTOCOLS,
  MAX_GENERATION_RECORD_ADJUSTMENTS,
  MAX_GENERATION_RECORD_ENTRIES,
  MAX_GENERATION_RECORD_FIELDS,
  MAX_GENERATION_RECORD_SOURCE_PARTS,
  MAX_GENERATION_RECORD_TEXT_CHARS,
  MAX_GENERATION_RECORD_UNSUPPORTED_REASON_CHARS,
  type GenerationRecordAdjustment,
  type GenerationRecordEffectiveParameters,
  type GenerationRecordField,
  type GenerationRecordFieldValue,
  type GenerationRecordRange,
  type GenerationRecordSummary,
  type ResolvedGenerationRecord,
  type ResolvedGenerationRecordPrompt,
  type ResolvedGenerationRecordPromptEntry,
  type ResolvedGenerationRecordSourceEntry,
  type ResolvedGenerationRecordSourcePart
} from "../../shared/generation-record.js";
import { unicodeScalarLength } from "../../shared/unicode.js";
import { invalidField, isMember, nonNegativeIntegerField, responseRecord, stringField } from "./api-response-decoders.js";

const GENERATION_RECORD_SOURCE_CATEGORIES = ["recent", "summary"] as const;
const PROMPT_ROLES = ["system", "user", "assistant"] as const;
const PROMPT_OPERATIONS = ["continue", "rewrite", "title", "summary"] as const;

/** The `GenerationRecordSummary[]` list route, one item per event on a
 *  take's history. Lightweight by design (`server/stories.ts`'s own doc
 *  comment on `loadGenerationRecordSummaries`), so this checks shape without
 *  the full canonical codec `shared/generation-record.ts` runs for the
 *  stored record — that codec validates a *stored*, reference-based prompt,
 *  not this resolved, prose-inlined projection. */
export function decodeGenerationRecordSummariesResponse(value: unknown): GenerationRecordSummary[] {
  if (!Array.isArray(value)) throw new Error("The server returned an invalid Generation Record list.");
  return value.map((entry, index) => {
    const record = responseRecord(entry, `Generation Record summary[${index}]`);
    const label = `Generation Record summary[${index}]`;
    const kind = stringField(record, "kind", label);
    if (!isMember(GENERATION_RECORD_KINDS, kind)) invalidField(label, "kind");
    return {
      id: stringField(record, "id", label),
      kind,
      createdAt: stringField(record, "createdAt", label),
      ...(record.range === undefined ? {} : { range: decodeGenerationRecordRange(record.range, label) })
    };
  });
}

/** The single-record detail route: `ResolvedGenerationRecord`, whose source
 *  entries carry inlined historical prose instead of a bare revision
 *  reference (see the type's own doc comment). */
export function decodeGenerationRecordResponse(value: unknown): ResolvedGenerationRecord {
  const record = responseRecord(value, "Generation Record");
  const label = "Generation Record";
  if (record.format !== GENERATION_RECORD_FORMAT) invalidField(label, "format");
  if (record.schemaVersion !== GENERATION_RECORD_SCHEMA_VERSION) invalidField(label, "schemaVersion");
  const kind = stringField(record, "kind", label);
  if (!isMember(GENERATION_RECORD_KINDS, kind)) invalidField(label, "kind");
  const provider = decodeGenerationRecordProvider(record.provider, label);
  const unsupportedReason = decodeUnsupportedReason(record, kind, label);
  return {
    format: GENERATION_RECORD_FORMAT,
    schemaVersion: GENERATION_RECORD_SCHEMA_VERSION,
    kind,
    createdAt: stringField(record, "createdAt", label),
    ...(record.range === undefined ? {} : { range: decodeGenerationRecordRange(record.range, label) }),
    provider,
    effective: decodeGenerationRecordEffective(record.effective, label),
    prompt: decodeResolvedGenerationRecordPrompt(record.prompt, label),
    ...(unsupportedReason === undefined ? {} : { unsupportedReason })
  };
}

/** `unsupportedReason` is required exactly when `kind === "unsupported"` and
 *  forbidden otherwise (`shared/generation-record.ts`'s own
 *  `createGenerationRecord` enforces the same pairing on the stored side). */
function decodeUnsupportedReason(
  record: Record<string, unknown>,
  kind: ResolvedGenerationRecord["kind"],
  label: string
): string | undefined {
  const present = record.unsupportedReason !== undefined;
  if (kind === "unsupported" && !present) invalidField(label, "unsupportedReason");
  if (kind !== "unsupported" && present) invalidField(label, "unsupportedReason");
  if (!present) return undefined;
  const reason = stringField(record, "unsupportedReason", label);
  if (reason.length > MAX_GENERATION_RECORD_UNSUPPORTED_REASON_CHARS) invalidField(label, "unsupportedReason");
  return reason;
}

function decodeGenerationRecordRange(value: unknown, label: string): GenerationRecordRange {
  const range = responseRecord(value, `${label}.range`);
  const start = nonNegativeIntegerField(range, "start", `${label}.range`);
  const end = nonNegativeIntegerField(range, "end", `${label}.range`);
  if (end < start) invalidField(`${label}.range`, "end");
  return { start, end };
}

function decodeGenerationRecordProvider(
  value: unknown,
  label: string
): ResolvedGenerationRecord["provider"] {
  const provider = responseRecord(value, `${label}.provider`);
  const kind = stringField(provider, "provider", `${label}.provider`);
  if (!isMember(PROVIDER_VALUES, kind)) invalidField(`${label}.provider`, "provider");
  return { provider: kind, model: stringField(provider, "model", `${label}.provider`) };
}

function decodeGenerationRecordEffective(
  value: unknown,
  label: string
): GenerationRecordEffectiveParameters {
  const effective = responseRecord(value, `${label}.effective`);
  const wireProtocol = stringField(effective, "wireProtocol", `${label}.effective`);
  if (!isMember(GENERATION_RECORD_WIRE_PROTOCOLS, wireProtocol)) {
    invalidField(`${label}.effective`, "wireProtocol");
  }
  const fields = Array.isArray(effective.fields) ? effective.fields : invalidField(`${label}.effective`, "fields");
  if (fields.length > MAX_GENERATION_RECORD_FIELDS) invalidField(`${label}.effective`, "fields");
  const adjustments = Array.isArray(effective.adjustments)
    ? effective.adjustments
    : invalidField(`${label}.effective`, "adjustments");
  if (adjustments.length > MAX_GENERATION_RECORD_ADJUSTMENTS) invalidField(`${label}.effective`, "adjustments");
  return {
    wireProtocol,
    fields: fields.map((field, index) => decodeGenerationRecordField(field, `${label}.effective.fields[${index}]`)),
    adjustments: adjustments.map((adjustment, index) =>
      decodeGenerationRecordAdjustment(adjustment, `${label}.effective.adjustments[${index}]`))
  };
}

function decodeGenerationRecordField(value: unknown, label: string): GenerationRecordField {
  const field = responseRecord(value, label);
  const raw = field.value;
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    invalidField(label, "value");
  }
  if (typeof raw === "number" && !Number.isFinite(raw)) invalidField(label, "value");
  return { field: stringField(field, "field", label), value: raw as GenerationRecordFieldValue };
}

function decodeGenerationRecordAdjustment(value: unknown, label: string): GenerationRecordAdjustment {
  const adjustment = responseRecord(value, label);
  const stage = stringField(adjustment, "stage", label);
  if (!isMember(GENERATION_RECORD_ADJUSTMENT_STAGES, stage)) invalidField(label, "stage");
  const action = stringField(adjustment, "action", label);
  if (!isMember(GENERATION_RECORD_ADJUSTMENT_ACTIONS, action)) invalidField(label, "action");
  return {
    stage,
    field: stringField(adjustment, "field", label),
    action,
    ...(adjustment.attempt === undefined ? {} : { attempt: nonNegativeIntegerField(adjustment, "attempt", label) }),
    ...(adjustment.toField === undefined ? {} : { toField: stringField(adjustment, "toField", label) })
  };
}

function decodeResolvedGenerationRecordPrompt(value: unknown, label: string): ResolvedGenerationRecordPrompt {
  const prompt = responseRecord(value, `${label}.prompt`);
  const operation = stringField(prompt, "operation", `${label}.prompt`);
  if (!isMember(PROMPT_OPERATIONS, operation)) invalidField(`${label}.prompt`, "operation");
  const entries = Array.isArray(prompt.entries) ? prompt.entries : invalidField(`${label}.prompt`, "entries");
  if (entries.length > MAX_GENERATION_RECORD_ENTRIES) invalidField(`${label}.prompt`, "entries");
  return {
    operation,
    entries: entries.map((entry, index) =>
      decodeResolvedGenerationRecordPromptEntry(entry, `${label}.prompt.entries[${index}]`))
  };
}

function decodeResolvedGenerationRecordPromptEntry(
  value: unknown,
  label: string
): ResolvedGenerationRecordPromptEntry {
  const entry = responseRecord(value, label);
  if (entry.source === "revisions") return decodeResolvedGenerationRecordSourceEntry(entry, label);
  if (entry.source !== "text") invalidField(label, "source");
  const role = stringField(entry, "role", label);
  if (!isMember(PROMPT_ROLES, role)) invalidField(label, "role");
  const stability = stringField(entry, "stability", label);
  if (stability !== "stable" && stability !== "volatile") invalidField(label, "stability");
  const kind = stringField(entry, "kind", label);
  if (!isMember(GENERATION_RECORD_PROMPT_BLOCK_KINDS, kind)) invalidField(label, "kind");
  const text = stringField(entry, "text", label);
  if (unicodeScalarLength(text, MAX_GENERATION_RECORD_TEXT_CHARS) > MAX_GENERATION_RECORD_TEXT_CHARS) {
    invalidField(label, "text");
  }
  return { role, stability, kind, source: "text", text };
}

function decodeResolvedGenerationRecordSourceEntry(
  entry: Record<string, unknown>,
  label: string
): ResolvedGenerationRecordSourceEntry {
  if (entry.kind !== "source") invalidField(label, "kind");
  if (entry.stability !== "stable") invalidField(label, "stability");
  const parts = Array.isArray(entry.parts) ? entry.parts : invalidField(label, "parts");
  if (parts.length > MAX_GENERATION_RECORD_SOURCE_PARTS) invalidField(label, "parts");
  return {
    stability: "stable",
    kind: "source",
    source: "revisions",
    parts: parts.map((part, index) => decodeResolvedGenerationRecordSourcePart(part, `${label}.parts[${index}]`))
  };
}

function decodeResolvedGenerationRecordSourcePart(
  value: unknown,
  label: string
): ResolvedGenerationRecordSourcePart {
  const part = responseRecord(value, label);
  const category = stringField(part, "category", label);
  if (!isMember(GENERATION_RECORD_SOURCE_CATEGORIES, category)) invalidField(label, "category");
  const instruction = stringField(part, "instruction", label);
  if (unicodeScalarLength(instruction, MAX_GENERATION_RECORD_TEXT_CHARS) > MAX_GENERATION_RECORD_TEXT_CHARS) {
    invalidField(label, "instruction");
  }
  return {
    nodeId: stringField(part, "nodeId", label),
    category,
    instruction,
    revisionId: stringField(part, "revisionId", label),
    text: stringField(part, "text", label)
  };
}

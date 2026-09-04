import { createHash } from "node:crypto";
import type { SettingsPresetV2 } from "./settings-v2-types.js";
import { MAX_STORY_LINE_COPY_PARTS } from "./types.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";

export const FACT_CONSISTENCY_RUN_FORMAT = "1667-fact-consistency-run" as const;
export const FACT_CONSISTENCY_RUN_SCHEMA_VERSION = 1 as const;
export const FACT_CONSISTENCY_HASH_PATTERN = /^[a-f0-9]{64}$/u;
/** The outer provider deadline for one complete Fact consistency run. The
 * settings schema permits one provider request for up to one day; a run can
 * contain many requests and must not inherit the ordinary 30-minute prose
 * deadline. */
export const FACT_CONSISTENCY_OPERATION_DEADLINE_MS = 24 * 60 * 60_000;
/** Two MiB leaves room for bounded unchecked reasons on a 5,000-part line
 * while keeping each content-addressed run finite. */
export const MAX_FACT_CONSISTENCY_RUN_BYTES = 2 * 1024 * 1024;
/** Fact checks support every part in the largest line accepted by story-line
 * operations. The run byte limit remains the effective bound for long IDs or
 * finding-heavy results. */
export const MAX_FACT_CONSISTENCY_PARTS = MAX_STORY_LINE_COPY_PARTS;
export const MAX_FACT_CONSISTENCY_FINDINGS_PER_PART = 128;
export const MAX_FACT_CONSISTENCY_LINE_TAKES = MAX_STORY_LINE_COPY_PARTS;
/** Parts larger than this are recorded as unchecked without provider work. */
export const MAX_FACT_CONSISTENCY_PART_CHARS = 100_000;
/** Compatibility name for the finding quote limit. */
export const MAX_FACT_CONSISTENCY_TEXT_CHARS = MAX_FACT_CONSISTENCY_PART_CHARS;
/** Stored run identifiers use the same 1,024-character ceiling as canonical
 * story identifiers. */
export const MAX_FACT_CONSISTENCY_ID_CHARS = 1_024;
export const MAX_FACT_CONSISTENCY_STATEMENT_CHARS = 4_096;

export type FactConsistencyScope = "chapter" | "story-line";

/** The exact structured finding accepted from a provider and persisted. */
export interface FactConsistencyFinding {
  readonly fact_id: string;
  readonly quote: string;
  readonly statement: string;
}

/** A selected take and the Fact State text sent to its one provider request. */
export interface FactConsistencyApplicableFact {
  readonly factId: string;
  readonly name: string | null;
  readonly tag: string | null;
  readonly stateId: string;
  readonly text: string;
}

export interface FactConsistencyPartSelection {
  readonly partId: string;
  readonly takeId: string;
  readonly text: string;
  readonly facts: readonly FactConsistencyApplicableFact[];
}

export interface FactConsistencyRunPart {
  readonly partId: string;
  readonly takeId: string;
  readonly findings: readonly FactConsistencyFinding[];
  readonly droppedFindings: number;
  readonly uncheckedReason?: string;
  /** Whether this take was selected on the active story line when the run
   * started. Optional for compatibility with pre-release schema-1 runs. */
  readonly selectedAtRun?: boolean;
}

export interface FactConsistencyRunProvider {
  readonly profile: "utility";
  readonly preset: SettingsPresetV2 | string;
  readonly model: string;
}

export interface FactConsistencyRun {
  readonly format: typeof FACT_CONSISTENCY_RUN_FORMAT;
  readonly schemaVersion: typeof FACT_CONSISTENCY_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly scope: FactConsistencyScope;
  readonly anchor: { readonly partId: string; readonly takeId: string };
  readonly checkedAt: string;
  readonly provider: FactConsistencyRunProvider;
  /** The selected take at every position in the line used by the run. */
  readonly storyLineTakeIds: readonly string[];
  readonly parts: readonly FactConsistencyRunPart[];
  readonly droppedFindings: number;
}

export interface FactConsistencyFindingView extends FactConsistencyFinding {
  readonly stale: boolean;
}

export interface FactConsistencyRunPartView extends Omit<FactConsistencyRunPart, "findings"> {
  readonly stale: boolean;
  readonly findings: readonly FactConsistencyFindingView[];
}

export interface FactConsistencyRunView extends Omit<FactConsistencyRun, "parts"> {
  readonly stale: boolean;
  readonly parts: readonly FactConsistencyRunPartView[];
}

/** Exact JSON serialization used for content addressing and persistence. */
export function serializeFactConsistencyRun(run: FactConsistencyRun): string {
  assertFactConsistencyRun(run);
  const value = {
    format: FACT_CONSISTENCY_RUN_FORMAT,
    schemaVersion: FACT_CONSISTENCY_RUN_SCHEMA_VERSION,
    runId: run.runId,
    scope: run.scope,
    anchor: {
      partId: run.anchor.partId,
      takeId: run.anchor.takeId
    },
    checkedAt: run.checkedAt,
    provider: {
      profile: "utility" as const,
      preset: run.provider.preset,
      model: run.provider.model
    },
    storyLineTakeIds: [...run.storyLineTakeIds],
    parts: run.parts.map((part) => ({
      partId: part.partId,
      takeId: part.takeId,
      findings: part.findings.map((finding) => ({
        fact_id: finding.fact_id,
        quote: finding.quote,
        statement: finding.statement
      })),
      droppedFindings: part.droppedFindings,
      ...(part.uncheckedReason === undefined ? {} : { uncheckedReason: part.uncheckedReason }),
      ...(part.selectedAtRun === undefined ? {} : { selectedAtRun: part.selectedAtRun })
    })),
    droppedFindings: run.droppedFindings
  };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_FACT_CONSISTENCY_RUN_BYTES) {
    throw new Error(`Fact consistency run exceeds ${MAX_FACT_CONSISTENCY_RUN_BYTES}-byte limit`);
  }
  return serialized;
}

export function hashFactConsistencyRun(run: FactConsistencyRun): string {
  return createHash("sha256")
    .update(Buffer.from(serializeFactConsistencyRun(run), "utf8"))
    .digest("hex");
}

export function parseFactConsistencyRun(
  raw: string,
  expectedHash?: string
): FactConsistencyRun {
  if (Buffer.byteLength(raw, "utf8") > MAX_FACT_CONSISTENCY_RUN_BYTES) {
    throw new Error(`Fact consistency run exceeds ${MAX_FACT_CONSISTENCY_RUN_BYTES}-byte limit`);
  }
  if (expectedHash !== undefined) {
    if (!FACT_CONSISTENCY_HASH_PATTERN.test(expectedHash)) {
      throw new Error("Fact consistency run hash is invalid");
    }
    const actual = createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
    if (actual !== expectedHash) throw new Error("Fact consistency run hash mismatch");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("Fact consistency run is not valid JSON", { cause: error });
  }
  assertFactConsistencyRun(value);
  return value;
}

export function assertFactConsistencyRun(value: unknown): asserts value is FactConsistencyRun {
  const record = requireRecord(value, "Fact consistency run must be an object");
  requireExactKeys(record, [
    "format", "schemaVersion", "runId", "scope", "anchor", "checkedAt",
    "provider", "storyLineTakeIds", "parts", "droppedFindings"
  ], "Fact consistency run");
  if (record.format !== FACT_CONSISTENCY_RUN_FORMAT) throw new Error("Fact consistency run format is unsupported");
  if (record.schemaVersion !== FACT_CONSISTENCY_RUN_SCHEMA_VERSION) throw new Error("Fact consistency run schema is unsupported");
  requireId(record.runId, "Fact consistency run.runId");
  if (record.scope !== "chapter" && record.scope !== "story-line") throw new Error("Fact consistency run scope is invalid");
  const anchor = requireRecord(record.anchor, "Fact consistency run.anchor must be an object");
  requireExactKeys(anchor, ["partId", "takeId"], "Fact consistency run.anchor");
  requireId(anchor.partId, "Fact consistency run.anchor.partId");
  requireId(anchor.takeId, "Fact consistency run.anchor.takeId");
  requireString(record.checkedAt, "Fact consistency run.checkedAt", MAX_FACT_CONSISTENCY_ID_CHARS);
  const provider = requireRecord(record.provider, "Fact consistency run.provider must be an object");
  requireExactKeys(provider, ["profile", "preset", "model"], "Fact consistency run.provider");
  if (provider.profile !== "utility") throw new Error("Fact consistency run provider profile is invalid");
  requireString(provider.preset, "Fact consistency run.provider.preset", MAX_FACT_CONSISTENCY_ID_CHARS);
  requireString(provider.model, "Fact consistency run.provider.model", MAX_FACT_CONSISTENCY_ID_CHARS);
  const line = requireStringArray(record.storyLineTakeIds, "Fact consistency run.storyLineTakeIds", MAX_FACT_CONSISTENCY_LINE_TAKES);
  line.forEach((id, index) => requireId(id, `Fact consistency run.storyLineTakeIds[${index}]`));
  const parts = requireArray(record.parts, "Fact consistency run.parts", MAX_FACT_CONSISTENCY_PARTS);
  parts.forEach((part, index) => assertFactConsistencyRunPart(part, index));
  requireCount(record.droppedFindings, "Fact consistency run.droppedFindings");
}

function assertFactConsistencyRunPart(value: unknown, index: number): asserts value is FactConsistencyRunPart {
  const record = requireRecord(value, `Fact consistency run.parts[${index}] must be an object`);
  const keys = ["partId", "takeId", "findings", "droppedFindings"];
  if (record.uncheckedReason !== undefined) keys.push("uncheckedReason");
  if (record.selectedAtRun !== undefined) keys.push("selectedAtRun");
  requireExactKeys(record, keys, `Fact consistency run.parts[${index}]`);
  requireId(record.partId, `Fact consistency run.parts[${index}].partId`);
  requireId(record.takeId, `Fact consistency run.parts[${index}].takeId`);
  const findings = requireArray(record.findings, `Fact consistency run.parts[${index}].findings`, MAX_FACT_CONSISTENCY_FINDINGS_PER_PART);
  findings.forEach((finding, findingIndex) => assertFactConsistencyFinding(finding, index, findingIndex));
  requireCount(record.droppedFindings, `Fact consistency run.parts[${index}].droppedFindings`);
  if (record.uncheckedReason !== undefined) requireString(record.uncheckedReason, `Fact consistency run.parts[${index}].uncheckedReason`, MAX_FACT_CONSISTENCY_STATEMENT_CHARS);
  if (record.selectedAtRun !== undefined && typeof record.selectedAtRun !== "boolean") {
    throw new Error(`Fact consistency run.parts[${index}].selectedAtRun is invalid`);
  }
}

function assertFactConsistencyFinding(value: unknown, partIndex: number, findingIndex: number): asserts value is FactConsistencyFinding {
  const record = requireRecord(value, `Fact consistency run.parts[${partIndex}].findings[${findingIndex}] must be an object`);
  requireExactKeys(record, ["fact_id", "quote", "statement"], `Fact consistency run.parts[${partIndex}].findings[${findingIndex}]`);
  requireId(record.fact_id, `Fact consistency finding fact_id`);
  requireString(record.quote, `Fact consistency finding quote`, MAX_FACT_CONSISTENCY_TEXT_CHARS);
  requireString(record.statement, `Fact consistency finding statement`, MAX_FACT_CONSISTENCY_STATEMENT_CHARS);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(label);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing keys`);
  }
}

function requireString(value: unknown, label: string, maxChars: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) throw new Error(`${label} is invalid`);
}

function requireId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || hasUnpairedSurrogate(value)
    || unicodeScalarLength(value, MAX_FACT_CONSISTENCY_ID_CHARS + 1) > MAX_FACT_CONSISTENCY_ID_CHARS
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function requireStringArray(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} is invalid`);
  }
  return value as string[];
}

function requireArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} is invalid`);
  return value;
}

function requireCount(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

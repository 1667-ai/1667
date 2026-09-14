import { createHash } from "node:crypto";
import {
  FACT_CONSISTENCY_HASH_PATTERN,
  FACT_CONSISTENCY_RUN_FORMAT,
  FACT_CONSISTENCY_RUN_SCHEMA_VERSION,
  MAX_FACT_CONSISTENCY_FINDINGS_PER_PART,
  MAX_FACT_CONSISTENCY_ID_CHARS,
  MAX_FACT_CONSISTENCY_LINE_TAKES,
  MAX_FACT_CONSISTENCY_PARTS,
  MAX_FACT_CONSISTENCY_RUN_BYTES,
  MAX_FACT_CONSISTENCY_STATEMENT_CHARS,
  MAX_FACT_CONSISTENCY_TEXT_CHARS,
  assertFactConsistencyRun,
  type FactConsistencyFinding,
  type FactConsistencyRun,
} from "./fact-consistency-contract.js";
export * from "./fact-consistency-contract.js";

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

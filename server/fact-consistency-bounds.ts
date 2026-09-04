import type { GenerationSettings } from "../shared/types.js";
import {
  factConsistencyLine,
  type FactConsistencySelectionInput
} from "../shared/fact-consistency.js";
import { factConsistencyPrompt } from "../shared/fact-consistency-prompt.js";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import { activePath } from "../shared/story-tree.js";
import {
  MAX_FACT_CONSISTENCY_FINDINGS_PER_PART,
  MAX_FACT_CONSISTENCY_RUN_BYTES,
  serializeFactConsistencyRun,
  type FactConsistencyPartSelection,
  type FactConsistencyRun,
  type FactConsistencyRunPart,
  type FactConsistencyScope
} from "../shared/fact-consistency-types.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import { ServiceError } from "./errors.js";

const FACT_CONSISTENCY_MIN_RESPONSE_BYTES = 16 * 1024;
const RUN_COUNT_DIGIT_RESERVE = 16;
const RUN_UNCHECKED_REASON_RESERVE = "x".repeat(160);
const PLAN_CHECKED_AT = "9999-12-31T23:59:59.999Z";

/** Keep a large story-line check from creating an unbounded paid request
 * batch. A chapter remains the normal path; this cap is a final safety net. */
export const MAX_FACT_CONSISTENCY_PROVIDER_REQUESTS = 1_024;
/** Match the existing prompt-size ceilings while allowing one full Fact
 * consistency part and its applicable Fact States. */
export const MAX_FACT_CONSISTENCY_RENDERED_PROMPT_BYTES = 512 * 1024;
/** Bound total rendered prompt material for one check before provider work. */
export const MAX_FACT_CONSISTENCY_TOTAL_PROMPT_BYTES = 64 * 1024 * 1024;

export interface FactConsistencyBudgetRequest {
  readonly focusedPartId: string;
  readonly scope: FactConsistencyScope;
}

export interface FactConsistencyPartBudget {
  readonly maxBytes: number;
  readonly maxResponseBytes: number;
  usedBytes: number;
}

export type FactConsistencyBatch = readonly FactConsistencyPartSelection["facts"][number][];

export interface FactConsistencyWorkload {
  readonly requestCount: number;
  readonly promptBytes: number;
}

export function assertFactConsistencyWorkload(
  parts: readonly FactConsistencyPartSelection[],
  batches: readonly (readonly FactConsistencyBatch[] | null)[],
  runId: string,
  marker: (runId: string, partId: string, index: number) => string
): FactConsistencyWorkload {
  let requestCount = 0;
  let promptBytes = 0;
  for (const [partIndex, part] of parts.entries()) {
    const partBatches = batches[partIndex];
    if (partBatches === null || partBatches === undefined) continue;
    for (const [batchIndex, facts] of partBatches.entries()) {
      requestCount += 1;
      if (requestCount > MAX_FACT_CONSISTENCY_PROVIDER_REQUESTS) {
        throw new ServiceError(
          400,
          `Fact consistency checks support at most ${MAX_FACT_CONSISTENCY_PROVIDER_REQUESTS.toLocaleString()} provider requests. Narrow the selected chapter or line.`,
          "invalid_request"
        );
      }
      const rendered = renderPromptPlan(
        factConsistencyPrompt(part, facts, marker(runId, part.partId, batchIndex))
      );
      const bytes = Buffer.byteLength(JSON.stringify(rendered), "utf8");
      if (bytes > MAX_FACT_CONSISTENCY_RENDERED_PROMPT_BYTES) {
        throw new ServiceError(
          400,
          `A Fact consistency provider prompt exceeds ${MAX_FACT_CONSISTENCY_RENDERED_PROMPT_BYTES.toLocaleString()} bytes. Narrow the selected part or Fact States.`,
          "invalid_request"
        );
      }
      promptBytes += bytes;
      if (promptBytes > MAX_FACT_CONSISTENCY_TOTAL_PROMPT_BYTES) {
        throw new ServiceError(
          400,
          `Fact consistency prompts exceed the ${MAX_FACT_CONSISTENCY_TOTAL_PROMPT_BYTES.toLocaleString()}-byte run limit. Narrow the selected chapter or line.`,
          "invalid_request"
        );
      }
    }
  }
  return { requestCount, promptBytes };
}

export function assertFactConsistencyRunCapacity(
  story: FactConsistencySelectionInput["story"],
  request: FactConsistencyBudgetRequest,
  parts: readonly FactConsistencyPartSelection[],
  settings: GenerationSettings,
  runId: string
): void {
  const selectedTakeIds = new Set(activePath(story).map(({ id }) => id));
  const reserved: FactConsistencyRun = {
    format: "1667-fact-consistency-run",
    schemaVersion: 1,
    runId,
    scope: request.scope,
    anchor: { partId: request.focusedPartId, takeId: request.focusedPartId },
    checkedAt: PLAN_CHECKED_AT,
    provider: {
      profile: "utility",
      preset: providerRuntimeFor(settings).preset,
      model: settings.model
    },
    storyLineTakeIds: factConsistencyLine(story, request.focusedPartId).map((part) => part.id),
    parts: parts.map((part) => ({
      partId: part.partId,
      takeId: part.takeId,
      findings: [],
      droppedFindings: Number.MAX_SAFE_INTEGER,
      uncheckedReason: RUN_UNCHECKED_REASON_RESERVE,
      selectedAtRun: selectedTakeIds.has(part.takeId)
    })),
    droppedFindings: Number.MAX_SAFE_INTEGER
  };
  try {
    serializeFactConsistencyRun(reserved);
  } catch (error) {
    if (error instanceof Error && /exceeds .*byte limit/u.test(error.message)) {
      throw new ServiceError(
        400,
        "The selected Fact consistency run is too large to store safely",
        "invalid_request"
      );
    }
    throw error;
  }
}

/** Keep verified findings in provider order until the bounded run is full.
 * Findings that do not fit become dropped findings; part coverage remains. */
export function boundFactConsistencyRun(run: FactConsistencyRun): FactConsistencyRun {
  const emptyParts = run.parts.map((part) => ({ ...part, findings: [] }));
  const emptyRun = { ...run, parts: emptyParts };
  const baseBytes = Buffer.byteLength(serializeFactConsistencyRun(emptyRun), "utf8");
  let remaining = MAX_FACT_CONSISTENCY_RUN_BYTES - baseBytes
    - (run.parts.length + 1) * RUN_COUNT_DIGIT_RESERVE;
  let totalStorageDrops = 0;
  const parts = run.parts.map((part) => {
    const findings: FactConsistencyRunPart["findings"][number][] = [];
    let storageDrops = 0;
    for (const finding of part.findings) {
      if (findings.length >= MAX_FACT_CONSISTENCY_FINDINGS_PER_PART) {
        storageDrops += 1;
        continue;
      }
      const bytes = Buffer.byteLength(JSON.stringify(finding), "utf8")
        + (findings.length === 0 ? 0 : 1);
      if (bytes <= remaining) {
        findings.push(finding);
        remaining -= bytes;
      } else {
        storageDrops += 1;
      }
    }
    totalStorageDrops += storageDrops;
    return {
      ...part,
      findings,
      droppedFindings: part.droppedFindings + storageDrops
    };
  });
  const bounded = {
    ...run,
    parts,
    droppedFindings: run.droppedFindings + totalStorageDrops
  };
  serializeFactConsistencyRun(bounded);
  return bounded;
}

/** Reserve the serialised run envelope before requests start. Quotas are
 * assigned in selected-part order, so concurrent provider completion cannot
 * change which findings survive the run-wide byte bound. */
export function factConsistencyFindingBudgets(
  story: FactConsistencySelectionInput["story"],
  request: FactConsistencyBudgetRequest,
  parts: readonly FactConsistencyPartSelection[],
  settings: GenerationSettings,
  runId: string
): readonly FactConsistencyPartBudget[] {
  const selectedTakeIds = new Set(activePath(story).map(({ id }) => id));
  const reserved: FactConsistencyRun = {
    format: "1667-fact-consistency-run",
    schemaVersion: 1,
    runId,
    scope: request.scope,
    anchor: { partId: request.focusedPartId, takeId: request.focusedPartId },
    checkedAt: PLAN_CHECKED_AT,
    provider: {
      profile: "utility",
      preset: providerRuntimeFor(settings).preset,
      model: settings.model
    },
    storyLineTakeIds: factConsistencyLine(story, request.focusedPartId).map((part) => part.id),
    parts: parts.map((part) => ({
      partId: part.partId,
      takeId: part.takeId,
      findings: [],
      droppedFindings: 0,
      uncheckedReason: RUN_UNCHECKED_REASON_RESERVE,
      selectedAtRun: selectedTakeIds.has(part.takeId)
    })),
    droppedFindings: 0
  };
  const available = Math.max(
    0,
    MAX_FACT_CONSISTENCY_RUN_BYTES
      - Buffer.byteLength(serializeFactConsistencyRun(reserved), "utf8")
      - (parts.length + 1) * RUN_COUNT_DIGIT_RESERVE
  );
  const count = Math.max(parts.length, 1);
  const quotient = Math.floor(available / count);
  const remainder = available % count;
  return parts.map((_part, index) => {
    const maxBytes = quotient + (index < remainder ? 1 : 0);
    return {
      maxBytes,
      maxResponseBytes: Math.min(
        MAX_FACT_CONSISTENCY_RUN_BYTES,
        Math.max(FACT_CONSISTENCY_MIN_RESPONSE_BYTES, maxBytes + FACT_CONSISTENCY_MIN_RESPONSE_BYTES)
      ),
      usedBytes: 0
    };
  });
}

export function factFindingBytes(
  finding: FactConsistencyRunPart["findings"][number]
): number {
  return Buffer.byteLength(JSON.stringify(finding), "utf8");
}

export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

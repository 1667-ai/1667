import { writeFile } from "node:fs/promises";
import type { ReplayResult, ReplaySample } from "./runner.js";
import {
  GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
  GEMMA_EXPECTED_CASE_COUNT,
  GEMMA_REPLAY_FIXTURE,
  GEMMA_REPLAY_HARNESS,
  GEMMA_REPLAY_OPERATIONS,
  GEMMA_REPLAY_SEEDS,
  GEMMA_RUBRIC_KEYS,
  GEMMA_V08_REQUEST_SHAPE,
  evaluationFingerprint,
  regressionsFor,
  scoreDelta,
  type GemmaCompatibilityEvidence,
  type GemmaEvidenceCase,
  type GemmaRubricKey,
  type GemmaScoreVector,
  validateEvidenceNote,
  validateScoreVector
} from "./contract.js";
import {
  createBlindPackArtifacts,
  createBlindPack,
  parseBlindMapping,
  parseBlindPack,
  readBlindMapping,
  readBlindPack,
  resolveScoreInputs,
  writeBlindMapping,
  writeBlindPack,
  type BlindScoreInputs,
  type BlindSample
} from "./blind-mapping.js";

export {
  createBlindPack,
  createBlindPackArtifacts,
  parseBlindMapping,
  parseBlindPack,
  readBlindMapping,
  readBlindPack,
  writeBlindMapping,
  writeBlindPack
};
export type {
  BlindEntropy,
  BlindMapping,
  BlindMappingEntry,
  BlindPack,
  BlindPackArtifacts,
  BlindPackOptions,
  BlindReference,
  BlindSample,
  BlindScoreInputs
} from "./blind-mapping.js";

export const RUBRIC_KEYS = GEMMA_RUBRIC_KEYS;
export type RubricKey = GemmaRubricKey;
export type ScoreVector = GemmaScoreVector;

export interface BlindScoreRow {
  readonly blindId: string;
  readonly scores: ScoreVector;
  readonly notes: string;
}

export type EvaluationCase = GemmaEvidenceCase;
export type CompatibilityEvidence = GemmaCompatibilityEvidence;

/** Restore the baseline/candidate pairing only after the blind scorer submits
 * one complete, non-empty-noted score vector for every output. */
export function scoreReplay(
  result: ReplayResult,
  scores: readonly BlindScoreRow[],
  inputs: BlindScoreInputs
): CompatibilityEvidence {
  const { pack, mapping } = resolveScoreInputs(result, inputs);
  if (scores.length !== GEMMA_EXPECTED_BLIND_SAMPLE_COUNT) {
    throw new Error(`Expected ${GEMMA_EXPECTED_BLIND_SAMPLE_COUNT} blind score rows, got ${scores.length}`);
  }
  const rows = new Map<string, BlindScoreRow>();
  for (const row of scores) {
    if (rows.has(row.blindId)) throw new Error(`Duplicate blind score row: ${row.blindId}`);
    validateScoreRow(row, pack.samples);
    rows.set(row.blindId, row);
  }
  for (const sample of pack.samples) {
    if (!rows.has(sample.blindId)) throw new Error(`Missing blind score row: ${sample.blindId}`);
  }
  const assignments = new Map(mapping.assignments.map((assignment) => [
    `${assignment.pairId}:${assignment.arm}`,
    assignment.blindId
  ]));
  const cases = result.samples.map((sample) => {
    const baselineBlindId = assignments.get(`${sample.pairId}:baseline`)!;
    const candidateBlindId = assignments.get(`${sample.pairId}:candidate`)!;
    const baselineScores = rows.get(baselineBlindId)!.scores;
    const candidateScores = rows.get(candidateBlindId)!.scores;
    const delta = scoreDelta(candidateScores, baselineScores);
    const regressions = regressionsFor(candidateScores, baselineScores);
    return {
      id: sample.pairId as GemmaEvidenceCase["id"],
      operation: sample.operation,
      seed: sample.seed as (typeof GEMMA_REPLAY_SEEDS)[number],
      dispatchOrder: sample.dispatchOrder,
      baseline: scoredOutput(
        sample,
        "baseline",
        baselineBlindId,
        baselineScores,
        rows.get(baselineBlindId)!.notes
      ),
      candidate: scoredOutput(
        sample,
        "candidate",
        candidateBlindId,
        candidateScores,
        rows.get(candidateBlindId)!.notes
      ),
      delta,
      regressions
    } satisfies EvaluationCase;
  });
  const evaluationCore: import("./contract.js").GemmaEvaluationCore = {
    cases,
    caseCount: GEMMA_EXPECTED_CASE_COUNT,
    sampleCount: GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
    seeds: [...GEMMA_REPLAY_SEEDS],
    operations: [...GEMMA_REPLAY_OPERATIONS],
    rubric: GEMMA_RUBRIC_KEYS,
    regressions: cases.flatMap((entry) => entry.regressions.map((rubric) => `${entry.id}:${rubric}`)),
    passed: cases.every((entry) => entry.regressions.length === 0)
  };
  return {
    schemaVersion: 1,
    runtime: result.runtime,
    profile: {
      ...result.profile,
      cachePolicy: "off"
    },
    baseline: {
      version: "v0.8.0",
      sourceFingerprint: result.baselineSourceFingerprint,
      requestFingerprint: result.baselineRequestFingerprint,
      expectedRequestShape: GEMMA_V08_REQUEST_SHAPE
    },
    candidate: {
      sourceFingerprint: result.candidateSourceFingerprint,
      evaluationInputFingerprint: result.evaluationInputFingerprint,
      requestFingerprint: result.candidateRequestFingerprint
    },
    evaluation: {
      harness: GEMMA_REPLAY_HARNESS,
      fixture: GEMMA_REPLAY_FIXTURE,
      ...evaluationCore,
      blindScoring: {
        complete: true,
        shuffleSeed: mapping.shuffleSeed,
        scoredSamples: GEMMA_EXPECTED_BLIND_SAMPLE_COUNT
      },
      resultFingerprint: evaluationFingerprint(evaluationCore)
    }
  };
}

export async function writeEvidence(pathname: string, evidence: CompatibilityEvidence): Promise<void> {
  await writeFile(pathname, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

export function parseBlindScores(value: unknown): BlindScoreRow[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.scores)
      ? value.scores
      : null;
  if (rows === null) throw new Error("Scores JSON must contain a scores array");
  return rows.map((row, index) => {
    if (!isRecord(row) || typeof row.blindId !== "string" || !isRecord(row.scores)) {
      throw new Error(`Invalid blind score row at index ${index}`);
    }
    validateEvidenceNote(row.notes, `scores[${index}].notes`);
    return {
      blindId: row.blindId,
      scores: validateScoreVector(row.scores, `scores[${index}].scores`),
      notes: row.notes
    };
  });
}

function validateScoreRow(row: BlindScoreRow, samples: readonly BlindSample[]): void {
  if (!samples.some((sample) => sample.blindId === row.blindId)) {
    throw new Error(`Unknown blind score id: ${row.blindId}`);
  }
  validateEvidenceNote(row.notes, `scores.${row.blindId}.notes`);
  validateScoreVector(row.scores, `scores.${row.blindId}`);
}

function scoredOutput(
  sample: ReplaySample,
  side: "baseline" | "candidate",
  blindId: string,
  scores: ScoreVector,
  notes: string
): GemmaEvidenceCase["baseline"] {
  return {
    blindId,
    outputFingerprint: sample[side].outputFingerprint,
    requestFingerprint: sample[side].request.bodyFingerprint,
    scores,
    notes
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

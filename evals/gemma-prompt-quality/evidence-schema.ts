import { canonicalJson } from "../../server/canonical-json.js";
import {
  aggregateRequestFingerprint,
  GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
  GEMMA_EXPECTED_CASE_COUNT,
  GEMMA_REPLAY_FIXTURE,
  GEMMA_REPLAY_HARNESS,
  GEMMA_REPLAY_OPERATIONS,
  GEMMA_REPLAY_SEEDS,
  GEMMA_V08_BASELINE_REQUEST_FINGERPRINT,
  GEMMA_RUBRIC_KEYS,
  evaluationFingerprint,
  type GemmaCompatibilityEvidence,
  type GemmaEvaluationCore,
  type GemmaEvidenceCase,
  type GemmaReplayOperation
} from "./contract.js";
import { parseEvidenceOptimization, requireMatchingOptimization } from "./optimization.js";
import {
  parseBlindScoring,
  parseCases,
  parseProfile,
  parseRegressionList,
  parseRequestShape,
  parseRuntime,
  requireExact,
  requireExactArray,
  requireFingerprint,
  requireKeys,
  requireRecord
} from "./evidence-schema-validation.js";

/** Parse and verify the committed, prose-free evidence artifact. */
export function parseGemmaCompatibilityEvidence(
  value: unknown
): GemmaCompatibilityEvidence {
  const evidence = requireRecord(value, "Gemma compatibility evidence");
  requireKeys(evidence, ["schemaVersion", "runtime", "profile", "baseline", "candidate", "evaluation"], "evidence");
  requireExact(evidence.schemaVersion, 1, "evidence.schemaVersion");
  const runtime = parseRuntime(evidence.runtime);
  const profile = parseProfile(evidence.profile, runtime);
  const baseline = requireRecord(evidence.baseline, "evidence.baseline");
  requireKeys(baseline, ["version", "requestFingerprint", "expectedRequestShape"], "evidence.baseline");
  requireExact(baseline.version, "v0.8.0", "evidence.baseline.version");
  const baselineRequestFingerprint = requireFingerprint(baseline.requestFingerprint, "evidence.baseline.requestFingerprint");
  requireExact(baselineRequestFingerprint, GEMMA_V08_BASELINE_REQUEST_FINGERPRINT, "evidence.baseline.requestFingerprint");
  const expectedRequestShape = parseRequestShape(baseline.expectedRequestShape);
  const candidate = requireRecord(evidence.candidate, "evidence.candidate");
  requireKeys(candidate, ["optimization", "operatorAcknowledgedExclusiveServer", "requestFingerprint"], "evidence.candidate");
  const optimization = parseEvidenceOptimization(candidate.optimization, "evidence.candidate.optimization");
  requireExact(candidate.operatorAcknowledgedExclusiveServer, true, "evidence.candidate.operatorAcknowledgedExclusiveServer");
  const candidateRequestFingerprint = requireFingerprint(candidate.requestFingerprint, "evidence.candidate.requestFingerprint");
  const rawEvaluation = requireRecord(evidence.evaluation, "evidence.evaluation");
  requireKeys(rawEvaluation, [
    "harness", "fixture", "optimization", "cases", "caseCount", "sampleCount", "seeds", "operations",
    "rubric", "blindScoring", "regressions", "passed", "resultFingerprint"
  ], "evidence.evaluation");
  requireExact(rawEvaluation.harness, GEMMA_REPLAY_HARNESS, "evidence.evaluation.harness");
  requireExact(rawEvaluation.fixture, GEMMA_REPLAY_FIXTURE, "evidence.evaluation.fixture");
  requireMatchingOptimization(rawEvaluation.optimization, optimization, "evidence.evaluation.optimization");
  requireExact(rawEvaluation.caseCount, GEMMA_EXPECTED_CASE_COUNT, "evidence.evaluation.caseCount");
  requireExact(rawEvaluation.sampleCount, GEMMA_EXPECTED_BLIND_SAMPLE_COUNT, "evidence.evaluation.sampleCount");
  requireExactArray(rawEvaluation.seeds, GEMMA_REPLAY_SEEDS, "evidence.evaluation.seeds");
  requireExactArray(rawEvaluation.operations, GEMMA_REPLAY_OPERATIONS, "evidence.evaluation.operations");
  requireExactArray(rawEvaluation.rubric, GEMMA_RUBRIC_KEYS, "evidence.evaluation.rubric");
  const blindScoring = parseBlindScoring(rawEvaluation.blindScoring);
  const cases = parseCases(rawEvaluation.cases);
  const regressions = parseRegressionList(rawEvaluation.regressions);
  if (rawEvaluation.passed !== (regressions.length === 0)) throw new Error("evidence.evaluation.passed does not match regressions");
  const core: GemmaEvaluationCore = {
    cases,
    optimization,
    caseCount: GEMMA_EXPECTED_CASE_COUNT,
    sampleCount: GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
    seeds: [...GEMMA_REPLAY_SEEDS],
    operations: [...GEMMA_REPLAY_OPERATIONS],
    rubric: [...GEMMA_RUBRIC_KEYS],
    regressions,
    passed: regressions.length === 0
  };
  if (requestFingerprintFor(cases, "baseline") !== baselineRequestFingerprint) throw new Error("evidence.baseline.requestFingerprint does not match case requests");
  if (requestFingerprintFor(cases, "candidate") !== candidateRequestFingerprint) throw new Error("evidence.candidate.requestFingerprint does not match case requests");
  const expectedFingerprint = evaluationFingerprint(core);
  requireExact(rawEvaluation.resultFingerprint, expectedFingerprint, "evidence.evaluation.resultFingerprint");
  const expectedRegressions = cases.flatMap((entry) => entry.regressions.map((rubric) => `${entry.id}:${rubric}`));
  if (canonicalJson(expectedRegressions) !== canonicalJson(regressions)) throw new Error("evidence.evaluation.regressions does not match case scores");
  return {
    schemaVersion: 1,
    runtime,
    profile,
    baseline: { version: "v0.8.0", requestFingerprint: baselineRequestFingerprint, expectedRequestShape },
    candidate: {
      optimization,
      operatorAcknowledgedExclusiveServer: true,
      requestFingerprint: candidateRequestFingerprint
    },
    evaluation: { harness: GEMMA_REPLAY_HARNESS, fixture: GEMMA_REPLAY_FIXTURE, ...core, blindScoring, resultFingerprint: expectedFingerprint }
  };
}

function requestFingerprintFor(cases: readonly GemmaEvidenceCase[], side: "baseline" | "candidate"): string {
  return aggregateRequestFingerprint(cases.map((entry) => ({
    operation: entry.operation as GemmaReplayOperation,
    seed: entry.seed,
    requestFingerprint: entry[side].requestFingerprint
  })));
}

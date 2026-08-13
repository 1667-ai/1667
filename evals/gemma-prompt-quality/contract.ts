import { createHash } from "node:crypto";
import { canonicalJson } from "../../server/canonical-json.js";
import type { GenerationEffortV2 } from "../../shared/settings-v2-types.js";
import type { GemmaRuntimeConfiguration } from "./runtime.js";

/** Operation names are owned by the replay contract, not by a fixture. */
export type GemmaReplayOperation = "retake" | "continue";

export const GEMMA_REPLAY_HARNESS = "gemma-prompt-quality-v1" as const;
export const GEMMA_REPLAY_FIXTURE = "gemma-long-story-v1" as const;
export const GEMMA_REPLAY_SCHEMA_VERSION = 1 as const;

export const GEMMA_REPLAY_SEEDS = [101, 202, 303, 404, 505] as const;
export const GEMMA_REPLAY_OPERATIONS = ["retake", "continue"] as const;
export const GEMMA_REPLAY_ARMS = ["baseline", "candidate"] as const;
export const GEMMA_BLIND_SHUFFLE_SEED = 1667;
export const GEMMA_SCORE_MIN = 0;
export const GEMMA_SCORE_MAX = 3;

export const GEMMA_RUBRIC_KEYS = [
  "boundaryContinuity",
  "styleVoiceCadenceContinuity",
  "povTenseConsistency",
  "factContextRetention",
  "genericSceneResetAvoidance"
] as const;

/** Request shape frozen from the v0.8.0 continuation prompt. */
export const GEMMA_V08_REQUEST_SHAPE = Object.freeze({
  promptLayout: "author-brief, facts, mode-contract, user-assistant-story-pairs, final-operation-turn",
  requestProtocol: "openai-chat-completions",
  requestPath: "/v1/chat/completions",
  operations: Object.freeze({
    retake: Object.freeze({ finalRole: "user", appendAssistantPrefill: false }),
    continue: Object.freeze({ finalRole: "assistant", appendAssistantPrefill: true })
  }),
  requestFields: Object.freeze([
    "model",
    "messages",
    "max_tokens",
    "stream",
    "temperature",
    "sampling"
  ])
} as const);

export type GemmaReplayArm = (typeof GEMMA_REPLAY_ARMS)[number];
export type GemmaReplayCaseId = `${GemmaReplayOperation}-${(typeof GEMMA_REPLAY_SEEDS)[number]}`;
export type GemmaRubricKey = (typeof GEMMA_RUBRIC_KEYS)[number];
export type GemmaScoreVector = Readonly<Record<GemmaRubricKey, number>>;

export const GEMMA_EXPECTED_CASE_COUNT = GEMMA_REPLAY_OPERATIONS.length * GEMMA_REPLAY_SEEDS.length;
export const GEMMA_EXPECTED_BLIND_SAMPLE_COUNT = GEMMA_EXPECTED_CASE_COUNT * GEMMA_REPLAY_ARMS.length;

export interface GemmaEvidenceScore {
  readonly blindId: string;
  readonly outputFingerprint: string;
  readonly requestFingerprint: string;
  readonly scores: GemmaScoreVector;
  readonly notes: string;
}

export interface GemmaEvidenceCase {
  readonly id: GemmaReplayCaseId;
  readonly operation: GemmaReplayOperation;
  readonly seed: (typeof GEMMA_REPLAY_SEEDS)[number];
  readonly dispatchOrder: readonly GemmaReplayArm[];
  readonly baseline: GemmaEvidenceScore;
  readonly candidate: GemmaEvidenceScore;
  readonly delta: GemmaScoreVector;
  readonly regressions: readonly GemmaRubricKey[];
}

export interface GemmaEvaluationCore {
  readonly cases: readonly GemmaEvidenceCase[];
  readonly caseCount: typeof GEMMA_EXPECTED_CASE_COUNT;
  readonly sampleCount: typeof GEMMA_EXPECTED_BLIND_SAMPLE_COUNT;
  readonly seeds: readonly (typeof GEMMA_REPLAY_SEEDS[number])[];
  readonly operations: readonly GemmaReplayOperation[];
  readonly rubric: readonly GemmaRubricKey[];
  readonly regressions: readonly string[];
  readonly passed: boolean;
}

export interface GemmaCompatibilityEvidence {
  readonly schemaVersion: 1;
  /** Checked local runtime identity. This contains no endpoint or credentials. */
  readonly runtime: {
    readonly fingerprint: string;
    readonly configuration: GemmaRuntimeConfiguration;
  };
  /** Normalized replay profile used to rebuild all deterministic requests. */
  readonly profile: GemmaEvidenceProfile;
  readonly baseline: {
    readonly version: "v0.8.0";
    readonly sourceFingerprint: string;
    readonly requestFingerprint: string;
    readonly expectedRequestShape: typeof GEMMA_V08_REQUEST_SHAPE;
  };
  readonly candidate: {
    readonly sourceFingerprint: string;
    /** Fixture and approved replay protocol from the evaluated checkout. */
    readonly evaluationInputFingerprint: string;
    readonly requestFingerprint: string;
  };
  readonly evaluation: GemmaEvaluationCore & {
    readonly harness: typeof GEMMA_REPLAY_HARNESS;
    readonly fixture: typeof GEMMA_REPLAY_FIXTURE;
    readonly blindScoring: {
      readonly complete: true;
      readonly shuffleSeed: number;
      readonly scoredSamples: typeof GEMMA_EXPECTED_BLIND_SAMPLE_COUNT;
    };
    readonly resultFingerprint: string;
  };
}

export interface GemmaEvidenceProfile {
  readonly name: string;
  readonly sourceFingerprint: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly effort: GenerationEffortV2;
  readonly cachePolicy: "off";
  readonly tokenProbabilities: number | null;
  readonly sampling: Readonly<Record<string, unknown>>;
  readonly logitBiasState: "empty" | "present";
}

/**
 * Return the canonical paired-run order. Five pairs start from each arm, so
 * the fixed seed set cannot make the first request an uncontrolled variable.
 */
export function armOrder(
  operation: GemmaReplayOperation,
  seed: (typeof GEMMA_REPLAY_SEEDS)[number]
): readonly GemmaReplayArm[] {
  const operationOffset = operation === "retake" ? 0 : 1;
  return (seed + operationOffset) % 2 === 0
    ? GEMMA_REPLAY_ARMS
    : ["candidate", "baseline"];
}

export interface GemmaRequestFingerprintRecord {
  readonly operation: GemmaReplayOperation;
  readonly seed: number;
  readonly requestFingerprint: string;
}

/** Hash request identities in a canonical operation-and-seed order. */
export function aggregateRequestFingerprint(
  requests: readonly GemmaRequestFingerprintRecord[]
): string {
  const operationOrder = new Map(GEMMA_REPLAY_OPERATIONS.map((operation, index) => [operation, index]));
  const ordered = [...requests].sort((left, right) => {
    const operations = operationOrder.get(left.operation)! - operationOrder.get(right.operation)!;
    return operations === 0 ? left.seed - right.seed : operations;
  });
  return `sha256:${sha256(canonicalJson(ordered.map((request) => ({
    operation: request.operation,
    seed: request.seed,
    requestFingerprint: request.requestFingerprint
  }))))}`;
}

export function scoreDelta(candidate: GemmaScoreVector, baseline: GemmaScoreVector): GemmaScoreVector {
  return Object.fromEntries(
    GEMMA_RUBRIC_KEYS.map((key) => [key, candidate[key] - baseline[key]])
  ) as GemmaScoreVector;
}

export function regressionsFor(
  candidate: GemmaScoreVector,
  baseline: GemmaScoreVector
): GemmaRubricKey[] {
  return GEMMA_RUBRIC_KEYS.filter((key) => candidate[key] < baseline[key]);
}

export function validateScoreVector(value: unknown, label: string): GemmaScoreVector {
  const record = requireRecord(value, label);
  const keys = Object.keys(record).sort();
  if (keys.length !== GEMMA_RUBRIC_KEYS.length
    || keys.some((key, index) => key !== [...GEMMA_RUBRIC_KEYS].sort()[index])) {
    throw new Error(`${label} has unsupported or missing rubric fields`);
  }
  const result = {} as Record<GemmaRubricKey, number>;
  for (const key of GEMMA_RUBRIC_KEYS) {
    const score = record[key];
    if (
      typeof score !== "number"
      || !Number.isInteger(score)
      || score < GEMMA_SCORE_MIN
      || score > GEMMA_SCORE_MAX
    ) {
      throw new Error(`${label}.${key} must be an integer from ${GEMMA_SCORE_MIN} through ${GEMMA_SCORE_MAX}`);
    }
    result[key] = score;
  }
  return result;
}

/** Reject unsafe text before it enters committed evidence. */
export function validateCommittedSafeText(value: unknown, label: string): asserts value is string {
  const unsafe = /(?:https?:\/\/|www\.|\bbearer\s+\S+|(?:api[-_ ]?key|authorization|password|secret|access[-_ ]?token|token)\s*[:=]\s*\S+|\b(?:sk-(?:proj-)?|rk_|gh[pousr]_|xox[baprs]-|glpat-|hf_|npm_|AIza|AKIA)[a-z0-9_-]{8,}|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}])/iu;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || Array.from(value).length > 240
    || /[\u0000-\u001F\u007F]/u.test(value)
    || unsafe.test(value)
  ) {
    throw new Error(
      `${label} must be a trimmed, single-line summary of at most 240 characters without a URL or credential-like value`
    );
  }
}

/** Keep committed scoring notes short and free of common secret forms. */
export function validateEvidenceNote(value: unknown, label: string): asserts value is string {
  validateCommittedSafeText(value, label);
}

export function expectedCaseIds(): readonly GemmaReplayCaseId[] {
  return GEMMA_REPLAY_OPERATIONS.flatMap((operation) =>
    GEMMA_REPLAY_SEEDS.map((seed) => `${operation}-${seed}` as GemmaReplayCaseId)
  );
}

/** Hash the evaluation fields without the self-referential result fingerprint. */
export function evaluationFingerprint(core: GemmaEvaluationCore): string {
  return `sha256:${sha256(canonicalJson(core))}`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

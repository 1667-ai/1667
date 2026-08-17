import { canonicalJson } from "../../server/canonical-json.js";
import {
  aggregateRequestFingerprint,
  armOrder,
  GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
  GEMMA_EXPECTED_CASE_COUNT,
  GEMMA_REPLAY_ARMS,
  GEMMA_REPLAY_OPERATIONS,
  GEMMA_REPLAY_SEEDS,
  GEMMA_V08_REQUEST_SHAPE,
  type GemmaReplayArm,
  type GemmaReplayCaseId,
  type GemmaReplayOperation,
  GEMMA_BASELINE_SCORE_FLOOR,
  GEMMA_RUBRIC_KEYS,
  GEMMA_SCORING_PROTOCOL_FINGERPRINT,
  GEMMA_SCORE_MAX,
  regressionsFor,
  scoreDelta,
  validateCommittedSafeText,
  validateEvidenceNote,
  validateScoreVector,
  type GemmaCompatibilityEvidence,
  type GemmaEvidenceCase,
  type GemmaEvidenceProfile,
  type GemmaEvidenceScore,
  type GemmaRubricKey,
  type GemmaScoreVector
} from "./contract.js";
import { validateReplayProfileBoundary, type ReplayProfileBoundary } from "./profile.js";
import { parseGemmaRuntimeConfiguration, type GemmaRuntimeRecord } from "./runtime.js";

export function parseRuntime(value: unknown): GemmaRuntimeRecord {
  const runtime = requireRecord(value, "evidence.runtime");
  requireKeys(runtime, ["fingerprint", "configuration"], "evidence.runtime");
  const parsed = parseGemmaRuntimeConfiguration(runtime.configuration);
  const fingerprint = requireFingerprint(runtime.fingerprint, "evidence.runtime.fingerprint");
  if (fingerprint !== parsed.fingerprint) {
    throw new Error("evidence.runtime.fingerprint does not match configuration");
  }
  return parsed;
}

export function parseProfile(value: unknown, runtime: GemmaRuntimeRecord): GemmaEvidenceProfile {
  const profile = requireRecord(value, "evidence.profile");
  requireKeys(
    profile,
    ["name", "sourceFingerprint", "temperature", "maxOutputTokens", "effort", "cachePolicy", "tokenProbabilities", "sampling", "timeouts", "logitBiasState"],
    "evidence.profile"
  );
  validateCommittedSafeText(profile.name, "evidence.profile.name");
  const sourceFingerprint = requireFingerprint(profile.sourceFingerprint, "evidence.profile.sourceFingerprint");
  if (typeof profile.temperature !== "number" || !Number.isFinite(profile.temperature)) {
    throw new Error("evidence.profile.temperature is invalid");
  }
  const maxOutputTokens = profile.maxOutputTokens;
  if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error("evidence.profile.maxOutputTokens is invalid");
  }
  if (profile.effort !== "default") {
    throw new Error("Gemma replay requires generation.effort to be default because the checked runtime does not declare reasoning-effort support");
  }
  if (profile.cachePolicy !== "off") throw new Error("evidence.profile.cachePolicy must be off");
  const tokenProbabilities = profile.tokenProbabilities;
  if (tokenProbabilities !== null && (typeof tokenProbabilities !== "number" || !Number.isSafeInteger(tokenProbabilities) || tokenProbabilities < 1)) {
    throw new Error("evidence.profile.tokenProbabilities is invalid");
  }
  const sampling = requireRecord(profile.sampling, "evidence.profile.sampling");
  safeJson(sampling, "evidence.profile.sampling");
  const logitBias = requireRecord(sampling.logitBias, "evidence.profile.sampling.logitBias");
  if (profile.logitBiasState !== "empty" && profile.logitBiasState !== "present") {
    throw new Error("evidence.profile.logitBiasState is invalid");
  }
  if ((Object.keys(logitBias).length === 0) !== (profile.logitBiasState === "empty")) {
    throw new Error("evidence.profile.logitBiasState does not match sampling.logitBias");
  }
  const parsed: ReplayProfileBoundary = {
    name: profile.name,
    sourceFingerprint,
    temperature: profile.temperature,
    maxOutputTokens,
    effort: "default",
    cachePolicy: "off",
    tokenProbabilities,
    sampling,
    timeouts: profile.timeouts as import("../../shared/settings-v2-types.js").ConnectionTimeoutsV2,
    logitBiasState: profile.logitBiasState
  };
  const canonical = validateReplayProfileBoundary(parsed, runtime);
  return {
    name: canonical.name,
    sourceFingerprint: canonical.sourceFingerprint,
    temperature: canonical.temperature,
    maxOutputTokens: canonical.maxOutputTokens,
    effort: canonical.effort,
    cachePolicy: "off",
    tokenProbabilities: canonical.tokenProbabilities,
    sampling: canonical.sampling,
    timeouts: canonical.timeouts,
    logitBiasState: canonical.logitBiasState
  };
}

export function parseRequestShape(value: unknown): typeof GEMMA_V08_REQUEST_SHAPE {
  const shape = requireRecord(value, "evidence.baseline.expectedRequestShape");
  requireKeys(
    shape,
    ["promptLayout", "requestProtocol", "requestPath", "operations", "requestFields"],
    "request shape"
  );
  requireExact(shape.promptLayout, GEMMA_V08_REQUEST_SHAPE.promptLayout, "request shape.promptLayout");
  requireExact(shape.requestProtocol, GEMMA_V08_REQUEST_SHAPE.requestProtocol, "request shape.requestProtocol");
  requireExact(shape.requestPath, GEMMA_V08_REQUEST_SHAPE.requestPath, "request shape.requestPath");
  requireExactArray(shape.requestFields, GEMMA_V08_REQUEST_SHAPE.requestFields, "request shape.requestFields");
  const operations = requireRecord(shape.operations, "request shape.operations");
  requireKeys(operations, ["retake", "continue"], "request shape.operations");
  for (const operation of GEMMA_REPLAY_OPERATIONS) {
    const item = requireRecord(operations[operation], `request shape.operations.${operation}`);
    requireKeys(item, ["finalRole", "appendAssistantPrefill"], `request shape.operations.${operation}`);
    const expected = GEMMA_V08_REQUEST_SHAPE.operations[operation];
    requireExact(item.finalRole, expected.finalRole, `request shape.operations.${operation}.finalRole`);
    requireExact(item.appendAssistantPrefill, expected.appendAssistantPrefill, `request shape.operations.${operation}.appendAssistantPrefill`);
  }
  return GEMMA_V08_REQUEST_SHAPE;
}

export function parseBlindScoring(value: unknown): GemmaCompatibilityEvidence["evaluation"]["blindScoring"] {
  const blindScoring = requireRecord(value, "evidence.evaluation.blindScoring");
  requireKeys(blindScoring, ["complete", "shuffleSeed", "scoredSamples", "protocolFingerprint"], "blind scoring");
  requireExact(blindScoring.complete, true, "blind scoring.complete");
  if (typeof blindScoring.shuffleSeed !== "number" || !Number.isSafeInteger(blindScoring.shuffleSeed)) {
    throw new Error("blind scoring.shuffleSeed must be an integer");
  }
  requireExact(blindScoring.scoredSamples, GEMMA_EXPECTED_BLIND_SAMPLE_COUNT, "blind scoring.scoredSamples");
  requireExact(
    blindScoring.protocolFingerprint,
    GEMMA_SCORING_PROTOCOL_FINGERPRINT,
    "blind scoring.protocolFingerprint"
  );
  return {
    complete: true,
    shuffleSeed: blindScoring.shuffleSeed,
    scoredSamples: GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
    protocolFingerprint: GEMMA_SCORING_PROTOCOL_FINGERPRINT
  };
}

export function parseCases(value: unknown): GemmaEvidenceCase[] {
  if (!Array.isArray(value) || value.length !== GEMMA_EXPECTED_CASE_COUNT) {
    throw new Error(`evidence.evaluation.cases must contain ${GEMMA_EXPECTED_CASE_COUNT} cases`);
  }
  const expected = new Set(expectedCaseIds());
  const seen = new Set<string>();
  const blindIds = new Set<string>();
  const parsed = value.map((rawCase, index) => {
    const entry = requireRecord(rawCase, `evidence.evaluation.cases[${index}]`);
    requireKeys(
      entry,
      ["id", "operation", "seed", "dispatchOrder", "baseline", "candidate", "delta", "regressions"],
      `case ${index}`
    );
    const operation = requireOneOf(entry.operation, GEMMA_REPLAY_OPERATIONS, `case ${index}.operation`);
    const seed = requireSeed(entry.seed, `case ${index}.seed`);
    const id = `${operation}-${seed}` as GemmaReplayCaseId;
    requireExact(entry.id, id, `case ${index}.id`);
    if (!expected.has(id) || seen.has(id)) throw new Error(`case ${index} is duplicate or unexpected`);
    seen.add(id);
    const dispatchOrder = parseDispatchOrder(entry.dispatchOrder, operation, seed, `case ${index}.dispatchOrder`);
    const baseline = parseEvidenceScore(entry.baseline, `case ${index}.baseline`);
    const candidate = parseEvidenceScore(entry.candidate, `case ${index}.candidate`);
    if (Object.values(baseline.scores).some((score) => score < GEMMA_BASELINE_SCORE_FLOOR)) {
      throw new Error(`case ${index}.baseline scores must be at least ${GEMMA_BASELINE_SCORE_FLOOR} for every rubric`);
    }
    for (const score of [baseline, candidate]) {
      if (blindIds.has(score.blindId)) throw new Error(`case ${index} reuses blind id ${score.blindId}`);
      blindIds.add(score.blindId);
    }
    const delta = validateScoreDelta(entry.delta, baseline.scores, candidate.scores, `case ${index}.delta`);
    const regressions = parseRubricList(entry.regressions, `case ${index}.regressions`);
    const expectedRegressions = regressionsFor(candidate.scores, baseline.scores);
    if (canonicalJson(regressions) !== canonicalJson(expectedRegressions)) {
      throw new Error(`case ${index}.regressions does not match scores`);
    }
    return { id, operation, seed, dispatchOrder, baseline, candidate, delta, regressions };
  });
  if (seen.size !== expected.size || [...expected].some((id) => !seen.has(id))) {
    throw new Error("evidence cases must contain every operation and seed exactly once");
  }
  const expectedBlindIds = new Set(
    Array.from({ length: GEMMA_EXPECTED_BLIND_SAMPLE_COUNT }, (_, index) => `blind-${String(index + 1).padStart(2, "0")}`)
  );
  if (blindIds.size !== expectedBlindIds.size || [...blindIds].some((id) => !expectedBlindIds.has(id))) {
    throw new Error("evidence cases must contain every blind id exactly once");
  }
  return parsed;
}

function parseEvidenceScore(value: unknown, label: string): GemmaEvidenceScore {
  const score = requireRecord(value, label);
  requireKeys(score, ["blindId", "outputFingerprint", "requestFingerprint", "scores", "notes"], label);
  if (typeof score.blindId !== "string" || !/^blind-\d{2}$/.test(score.blindId)) {
    throw new Error(`${label}.blindId is invalid`);
  }
  const outputFingerprint = requireFingerprint(score.outputFingerprint, `${label}.outputFingerprint`);
  const requestFingerprint = requireFingerprint(score.requestFingerprint, `${label}.requestFingerprint`);
  validateEvidenceNote(score.notes, `${label}.notes`);
  return {
    blindId: score.blindId,
    outputFingerprint,
    requestFingerprint,
    scores: validateScoreVector(score.scores, `${label}.scores`),
    notes: score.notes
  };
}

function validateScoreDelta(
  value: unknown,
  baseline: GemmaScoreVector,
  candidate: GemmaScoreVector,
  label: string
): GemmaScoreVector {
  const delta = validateScoreVectorAllowNegative(value, label);
  const expected = scoreDelta(candidate, baseline);
  if (canonicalJson(delta) !== canonicalJson(expected)) throw new Error(`${label} does not match scores`);
  return delta;
}

function validateScoreVectorAllowNegative(value: unknown, label: string): GemmaScoreVector {
  const record = requireRecord(value, label);
  const keys = Object.keys(record).sort();
  const expectedKeys = [...GEMMA_RUBRIC_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} has unsupported or missing rubric fields`);
  }
  const result = {} as Record<GemmaRubricKey, number>;
  for (const key of GEMMA_RUBRIC_KEYS) {
    const score = record[key];
    if (typeof score !== "number" || !Number.isInteger(score) || score < -GEMMA_SCORE_MAX || score > GEMMA_SCORE_MAX) {
      throw new Error(`${label}.${key} must be an integer from ${-GEMMA_SCORE_MAX} through ${GEMMA_SCORE_MAX}`);
    }
    result[key] = score;
  }
  return result;
}

function parseDispatchOrder(
  value: unknown,
  operation: GemmaReplayOperation,
  seed: (typeof GEMMA_REPLAY_SEEDS)[number],
  label: string
): readonly GemmaReplayArm[] {
  if (!Array.isArray(value) || value.length !== GEMMA_REPLAY_ARMS.length || value.some((arm) => !GEMMA_REPLAY_ARMS.includes(arm as GemmaReplayArm))) {
    throw new Error(`${label} must contain baseline and candidate exactly once`);
  }
  const order = value as GemmaReplayArm[];
  if (new Set(order).size !== GEMMA_REPLAY_ARMS.length) throw new Error(`${label} must contain baseline and candidate exactly once`);
  if (canonicalJson(order) !== canonicalJson(armOrder(operation, seed))) {
    throw new Error(`${label} does not match the fixed balanced dispatch schedule`);
  }
  return order;
}

export function parseRegressionList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("evidence.evaluation.regressions must be a string array");
  }
  return [...value];
}

function parseRubricList(value: unknown, label: string): GemmaRubricKey[] {
  if (!Array.isArray(value) || value.some((item) => !GEMMA_RUBRIC_KEYS.includes(item as GemmaRubricKey))) {
    throw new Error(`${label} contains an invalid rubric key`);
  }
  const result = value as GemmaRubricKey[];
  if (new Set(result).size !== result.length) throw new Error(`${label} contains a duplicate rubric key`);
  return result;
}

function requireSeed(value: unknown, label: string): (typeof GEMMA_REPLAY_SEEDS)[number] {
  if (typeof value !== "number" || !GEMMA_REPLAY_SEEDS.includes(value as (typeof GEMMA_REPLAY_SEEDS)[number])) {
    throw new Error(`${label} is invalid`);
  }
  return value as (typeof GEMMA_REPLAY_SEEDS)[number];
}

function requireOneOf<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is invalid`);
  return value as T[number];
}

export function requireFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint`);
  }
  return value;
}

export function requireExact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`${label} must be ${JSON.stringify(expected)}`);
}

export function requireExactArray(value: unknown, expected: readonly unknown[], label: string): void {
  if (!Array.isArray(value) || canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error(`${label} does not match the replay contract`);
  }
}

export function requireKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const received = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (received.length !== expected.length || received.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectedCaseIds(): readonly GemmaReplayCaseId[] {
  return GEMMA_REPLAY_OPERATIONS.flatMap((operation) => GEMMA_REPLAY_SEEDS.map((seed) => `${operation}-${seed}` as GemmaReplayCaseId));
}

function safeJson(value: unknown, label: string): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    safeText(value, label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => safeJson(item, `${label}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      safeText(key, `${label} key`);
      safeJson(item, `${label}.${key}`);
    }
    return;
  }
  throw new Error(`${label} is invalid`);
}

function safeText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || /(?:https?:\/\/|www\.|\bbearer\s+\S+|(?:api[-_ ]?key|authorization|password|secret|access[-_ ]?token|token)\s*[:=]\s*\S+)/iu.test(value)) {
    throw new Error(`${label} must not contain a URL or credential-like value`);
  }
}

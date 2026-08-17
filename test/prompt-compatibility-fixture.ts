import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import {
  PROMPT_COMPATIBILITY_MANIFEST
} from "../scripts/check-prompt-compatibility.js";
import {
  aggregateRequestFingerprint,
  armOrder,
  evaluationFingerprint,
  GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
  GEMMA_EXPECTED_CASE_COUNT,
  GEMMA_CANDIDATE_OPTIMIZATION,
  GEMMA_REPLAY_FIXTURE,
  GEMMA_REPLAY_HARNESS,
  GEMMA_REPLAY_OPERATIONS,
  GEMMA_REPLAY_SEEDS,
  GEMMA_RUBRIC_KEYS,
  GEMMA_SCORING_PROTOCOL_FINGERPRINT,
  GEMMA_V08_BASELINE_REQUEST_FINGERPRINT,
  GEMMA_V08_REQUEST_SHAPE,
  regressionsFor,
  scoreDelta,
  type GemmaEvaluationCore,
  type GemmaEvidenceCase,
  type GemmaEvidenceScore,
  type GemmaReplayCaseId,
  type GemmaScoreVector
} from "../evals/gemma-prompt-quality/contract.js";
import { parseReplayProfileManifest } from "../evals/gemma-prompt-quality/profile.js";
import { buildReplayRequestPairs, replayRequestBodyFingerprint } from "../evals/gemma-prompt-quality/runner.js";
import { parseGemmaRuntimeConfiguration } from "../evals/gemma-prompt-quality/runtime.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = path.join(ROOT, "scripts", "check-prompt-compatibility.ts");
const RUNTIME = parseGemmaRuntimeConfiguration({
  schemaVersion: 1,
  runtime: "koboldcpp",
  model: {
    id: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
    identity: "Gemma 4 31B test runtime",
    artifact: {
      fileName: "gemma-4-31B-it-uncensored-heretic-Q8_0.gguf",
      sha256: `sha256:${"a".repeat(64)}`,
      quantization: "Q8_0"
    }
  },
  koboldCpp: {
    version: "1.117.1",
    chatTemplateSha256: "sha256:0a52be69cda5ab8aeb627d6ff51a7b34c7d06afabb6b0f00cf8ee63df16a6315",
    contextWindow: 32768
  }
});
const PROFILE = parseReplayProfileManifest({
  schemaVersion: 1,
  runtimeArtifactSha256: RUNTIME.configuration.model.artifact.sha256,
  profile: {
    name: "Gemma compatibility test",
    generation: { temperature: 0.7, maxOutputTokens: 400, effort: "default", cachePolicy: "off", tokenProbabilities: null },
    timeouts: { responseHeaderMs: 600_000, firstTokenMs: 120_000, idleMs: 120_000, totalMs: 1_800_000 },
    sampling: { ...EMPTY_SAMPLING_V2, topP: 0.92, topK: 40, minP: 0.05, repeatPenalty: 1.08 }
  }
}, RUNTIME);

export type RecordedEvidence = {
  baseline: Record<string, unknown> & { requestFingerprint: string };
  candidate: Record<string, unknown> & { requestFingerprint: string };
  evaluation: Record<string, unknown> & {
    cases: GemmaEvidenceCase[];
    regressions: string[];
    passed: boolean;
    resultFingerprint: string;
  } & Omit<GemmaEvaluationCore, "cases" | "regressions" | "passed">;
} & Record<string, unknown>;

export function runChecker(repository: string): { readonly code: number; readonly output: string } {
  try {
    return {
      code: 0,
      output: execFileSync(process.execPath, ["--import", "tsx", CHECKER, "--repo", repository], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
      })
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

export function createRepository(): string {
  const repository = mkdtempSync(path.join(tmpdir(), "1667-prompt-compatibility-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "A Writer");
  git("config", "user.email", "writer@example.com");
  writeFileSync(path.join(repository, "other.ts"), "export const unchanged = true;\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "chore: seed prompt gate repository");
  return repository;
}

export function commit(repository: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repository });
  execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: repository });
}

export async function evidence(_repository?: string): Promise<RecordedEvidence> {
  const scores: GemmaScoreVector = {
    boundaryContinuity: 3, styleVoiceCadenceContinuity: 3, povTenseConsistency: 3,
    factContextRetention: 3, genericSceneResetAvoidance: 3
  };
  const requests = await buildReplayRequestPairs(
    "http://127.0.0.1:8080/v1",
    RUNTIME,
    PROFILE,
    GEMMA_CANDIDATE_OPTIMIZATION
  );
  const cases: GemmaEvidenceCase[] = requests.map((request, index) => ({
    id: `${request.operation.operation}-${request.seed}` as GemmaReplayCaseId,
    operation: request.operation.operation,
    seed: request.seed,
    dispatchOrder: armOrder(request.operation.operation, request.seed),
    baseline: score(index * 2 + 1, replayRequestBodyFingerprint(request.baseline.body), scores),
    candidate: score(index * 2 + 2, replayRequestBodyFingerprint(request.candidate.body), scores),
    delta: zeroScores(), regressions: []
  }));
  const core = {
    optimization: GEMMA_CANDIDATE_OPTIMIZATION,
    cases, caseCount: GEMMA_EXPECTED_CASE_COUNT, sampleCount: GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
    seeds: [...GEMMA_REPLAY_SEEDS], operations: [...GEMMA_REPLAY_OPERATIONS], rubric: [...GEMMA_RUBRIC_KEYS],
    regressions: [], passed: true
  } satisfies GemmaEvaluationCore;
  const requestFingerprint = (arm: "baseline" | "candidate") => aggregateRequestFingerprint(cases.map((entry) => ({
    operation: entry.operation, seed: entry.seed, requestFingerprint: entry[arm].requestFingerprint
  })));
  return {
    schemaVersion: 1, runtime: RUNTIME,
    profile: {
      name: PROFILE.name, sourceFingerprint: PROFILE.sourceFingerprint, temperature: PROFILE.temperature,
      maxOutputTokens: PROFILE.maxOutputTokens, effort: PROFILE.effort, cachePolicy: "off",
      tokenProbabilities: PROFILE.tokenProbabilities, sampling: PROFILE.sampling, timeouts: PROFILE.timeouts,
      logitBiasState: PROFILE.logitBiasState
    },
    baseline: {
      version: "v0.8.0", requestFingerprint: requestFingerprint("baseline"), expectedRequestShape: GEMMA_V08_REQUEST_SHAPE
    },
    candidate: {
      optimization: GEMMA_CANDIDATE_OPTIMIZATION,
      operatorAcknowledgedExclusiveServer: true,
      requestFingerprint: requestFingerprint("candidate")
    },
    evaluation: {
      harness: GEMMA_REPLAY_HARNESS, fixture: GEMMA_REPLAY_FIXTURE, ...core,
      blindScoring: {
        complete: true,
        shuffleSeed: 1667,
        scoredSamples: GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
        protocolFingerprint: GEMMA_SCORING_PROTOCOL_FINGERPRINT
      },
      resultFingerprint: evaluationFingerprint(core)
    }
  };
}

export function recomputeEvaluation(recorded: RecordedEvidence): void {
  const cases = recorded.evaluation.cases.map((entry) => ({
    ...entry,
    delta: scoreDelta(entry.candidate.scores, entry.baseline.scores),
    regressions: regressionsFor(entry.candidate.scores, entry.baseline.scores)
  }));
  const regressions = cases.flatMap((entry) => entry.regressions.map((rubric) => `${entry.id}:${rubric}`));
  const core: GemmaEvaluationCore = {
    optimization: recorded.evaluation.optimization,
    cases, caseCount: GEMMA_EXPECTED_CASE_COUNT, sampleCount: GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
    seeds: [...GEMMA_REPLAY_SEEDS], operations: [...GEMMA_REPLAY_OPERATIONS], rubric: [...GEMMA_RUBRIC_KEYS],
    regressions, passed: regressions.length === 0
  };
  recorded.evaluation.cases = cases;
  recorded.evaluation.regressions = regressions;
  recorded.evaluation.passed = core.passed;
  recorded.evaluation.resultFingerprint = evaluationFingerprint(core);
}

export function writeEvidence(repository: string, value: Record<string, unknown>): void {
  const target = path.join(repository, PROMPT_COMPATIBILITY_MANIFEST.evidencePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function score(index: number, requestFingerprint: string, scores: GemmaScoreVector): GemmaEvidenceScore {
  return {
    blindId: `blind-${String(index).padStart(2, "0")}`,
    outputFingerprint: `sha256:${createHash("sha256").update(String(index)).digest("hex")}`,
    requestFingerprint, scores: { ...scores }, notes: "The output preserves the tested story property."
  };
}

function zeroScores(): GemmaScoreVector {
  return {
    boundaryContinuity: 0, styleVoiceCadenceContinuity: 0, povTenseConsistency: 0,
    factContextRetention: 0, genericSceneResetAvoidance: 0
  };
}

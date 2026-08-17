/** Validate the committed Gemma evidence against rebuilt requests. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseJsonRejectingDuplicateKeys } from "../server/strict-json.js";
import {
  aggregateRequestFingerprint,
  GEMMA_CANDIDATE_OPTIMIZATION,
  GEMMA_REPLAY_OPERATIONS,
  GEMMA_V08_BASELINE_REQUEST_FINGERPRINT
} from "../evals/gemma-prompt-quality/contract.js";
import { parseGemmaCompatibilityEvidence } from "../evals/gemma-prompt-quality/evidence-schema.js";
import { replayProfileFromEvidence } from "../evals/gemma-prompt-quality/profile.js";
import { assertApprovedReplay } from "../evals/gemma-prompt-quality/approved-replay.js";
import {
  buildReplayRequestPairs,
  replayRequestBodyFingerprint
} from "../evals/gemma-prompt-quality/runner.js";

const EVIDENCE_PATH = "evals/gemma-prompt-quality/evidence.json";

/** Stable names used by release checks and documentation. */
export const PROMPT_COMPATIBILITY_MANIFEST = Object.freeze({
  baseline: "v0.8.0",
  candidateOptimization: GEMMA_CANDIDATE_OPTIMIZATION,
  evidencePath: EVIDENCE_PATH,
  baselineRequestFingerprint: GEMMA_V08_BASELINE_REQUEST_FINGERPRINT
});

type Operation = typeof GEMMA_REPLAY_OPERATIONS[number];

async function verifyEvidenceRequests(
  evidence: ReturnType<typeof parseGemmaCompatibilityEvidence>
): Promise<void> {
  const profile = replayProfileFromEvidence(evidence.profile, evidence.runtime);
  assertApprovedReplay(evidence.runtime, profile);
  const pairs = await buildReplayRequestPairs(
    "http://127.0.0.1:8080/v1",
    evidence.runtime,
    profile,
    evidence.candidate.optimization
  );
  const fingerprintFor = (side: "baseline" | "candidate") => aggregateRequestFingerprint(pairs.map((pair) => ({
    operation: pair.operation.operation as Operation,
    seed: pair.seed,
    requestFingerprint: replayRequestBodyFingerprint(pair[side].body)
  })));
  if (fingerprintFor("baseline") !== GEMMA_V08_BASELINE_REQUEST_FINGERPRINT
    || fingerprintFor("baseline") !== evidence.baseline.requestFingerprint) {
    throw new Error("evaluation baseline requests do not match the frozen v0.8.0 request contract");
  }
  if (fingerprintFor("candidate") !== evidence.candidate.requestFingerprint) {
    throw new Error("evaluation candidate requests do not match the current prompt, runtime, and profile");
  }
}

/** Run the complete gate. The base and head arguments remain accepted for old callers. */
export async function checkPromptCompatibility(
  repository: string,
  _base?: string,
  _head?: string
): Promise<void> {
  let evidenceText: string;
  try {
    evidenceText = readFileSync(path.join(repository, EVIDENCE_PATH), "utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(`${EVIDENCE_PATH} is missing`);
    }
    throw error;
  }
  const evidence = parseGemmaCompatibilityEvidence(parseJsonRejectingDuplicateKeys(
    evidenceText,
    "Gemma prompt compatibility evidence"
  ));
  if (evidence.baseline.requestFingerprint !== GEMMA_V08_BASELINE_REQUEST_FINGERPRINT) {
    throw new Error("evaluation baseline does not match the frozen v0.8.0 request contract");
  }
  if (evidence.candidate.optimization !== GEMMA_CANDIDATE_OPTIMIZATION
    || evidence.evaluation.optimization !== GEMMA_CANDIDATE_OPTIMIZATION) {
    throw new Error(`evaluation must identify exactly ${GEMMA_CANDIDATE_OPTIMIZATION}`);
  }
  await verifyEvidenceRequests(evidence);
  if (!evidence.evaluation.passed) {
    throw new Error("paired evaluation contains candidate rubric regressions");
  }
  process.stdout.write("prompt compatibility: paired evaluation evidence accepted\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const take = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const repository = path.resolve(take("--repo") ?? process.cwd());
  await checkPromptCompatibility(repository, take("--base"), take("--head"));
}

if (process.argv[1]?.endsWith("check-prompt-compatibility.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`prompt compatibility: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

/** Check that model-facing prompt changes include paired evaluation evidence. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseJsonRejectingDuplicateKeys } from "../server/strict-json.js";
import { buildOpenAiChatRequestBody } from "../server/provider-request-body.js";
import { PROMPT_CACHE_POLICY_OFF } from "../server/provider-cache-policy.js";
import {
  GEMMA_AUTHOR_BRIEF,
  GEMMA_FACTS_BLOCK,
  GEMMA_OPERATION_FIXTURES
} from "../evals/gemma-prompt-quality/fixture.js";
import { baselineContinuationPlan } from "../evals/gemma-prompt-quality/baseline.js";
import {
  aggregateRequestFingerprint,
  GEMMA_REPLAY_OPERATIONS
} from "../evals/gemma-prompt-quality/contract.js";
import { parseGemmaCompatibilityEvidence } from "../evals/gemma-prompt-quality/evidence-schema.js";
import { replayProfileFromEvidence } from "../evals/gemma-prompt-quality/profile.js";
import { assertApprovedReplay } from "../evals/gemma-prompt-quality/approved-replay.js";
import {
  buildReplayRequestPairs,
  replayRequestBodyFingerprint
} from "../evals/gemma-prompt-quality/runner.js";
import {
  GEMMA_PROTECTED_PROMPT_SOURCES,
  GEMMA_CURRENT_PRODUCTION_SOURCES,
  GEMMA_PROTECTED_EVALUATION_SOURCES,
  frozenV08SourceFingerprint,
  protectedEvaluationInputFingerprint,
  protectedPromptSourceFingerprint
} from "../evals/gemma-prompt-quality/source-fingerprint.js";

const EVIDENCE_PATH = "evals/gemma-prompt-quality/evidence.json";

/** This list is the canonical ownership boundary for model-facing prompts. */
export const PROMPT_COMPATIBILITY_MANIFEST = Object.freeze({
  baseline: "v0.8.0",
  protectedSources: GEMMA_PROTECTED_PROMPT_SOURCES,
  currentProductionSources: GEMMA_CURRENT_PRODUCTION_SOURCES,
  protectedEvaluationSources: GEMMA_PROTECTED_EVALUATION_SOURCES,
  evidencePath: EVIDENCE_PATH,
  baselineSourceFingerprint: "sha256:05684a1b8fda30f73fbfc3dbdc4fec46cbd72cda0a3c4594b49de2a3b23e7a7b",
  baselineFixtureRequestFingerprint: "sha256:462f11c69bc60ded5d73a945b8a6cddcb30f84290d7a286f7ea5961fe8dc165e"
});

type Operation = typeof GEMMA_REPLAY_OPERATIONS[number];

export function protectedSourceFingerprint(repository: string): string {
  return protectedPromptSourceFingerprint(repository);
}

function baselineSourceFingerprint(repository: string): string {
  return frozenV08SourceFingerprint(repository);
}

function gemmaSettings() {
  return {
    provider: "openai-compatible" as const,
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "gemma-4-31b",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 400,
    systemPrompt: "",
    contextWindow: null
  };
}

async function requestFingerprint(
  plan: (operation: Operation) => Promise<Record<string, unknown>>
): Promise<string> {
  const requests = await Promise.all(GEMMA_REPLAY_OPERATIONS.map(async (operation, index) => ({
    operation,
    seed: index,
    requestFingerprint: `sha256:${createHash("sha256").update(JSON.stringify(await plan(operation))).digest("hex")}`
  })));
  return aggregateRequestFingerprint(requests);
}

/** Hash the frozen v0.8.0 fixture requests through the live Chat transport. */
async function baselineFixtureRequestFingerprint(): Promise<string> {
  const settings = gemmaSettings();
  return requestFingerprint(async (operation) => {
    const fixture = GEMMA_OPERATION_FIXTURES.find((item) => item.operation === operation);
    if (fixture === undefined) throw new Error(`Gemma fixture is missing ${operation}`);
    return buildOpenAiChatRequestBody(
      settings,
      baselineContinuationPlan(fixture, GEMMA_AUTHOR_BRIEF, GEMMA_FACTS_BLOCK),
      PROMPT_CACHE_POLICY_OFF
    );
  });
}

function changedPaths(repository: string, base: string, head: string): readonly string[] {
  return execFileSync("git", ["-C", repository, "diff", "--no-renames", "--name-only", `${base}..${head}`], {
    encoding: "utf8"
  }).split("\n").filter((value) => value.length > 0);
}

function sourceChanged(repository: string, base: string, paths: readonly string[]): boolean {
  const productionSources: readonly string[] = PROMPT_COMPATIBILITY_MANIFEST.protectedSources;
  if (paths.some((file) => productionSources.includes(file))) return true;
  const currentSources: readonly string[] = PROMPT_COMPATIBILITY_MANIFEST.currentProductionSources;
  return paths.some((file) => ([...currentSources, ...PROMPT_COMPATIBILITY_MANIFEST.protectedEvaluationSources] as readonly string[]).includes(file)
    && sourceExistsAt(repository, base, file));
}

function sourceExistsAt(repository: string, base: string, source: string): boolean {
  try {
    execFileSync("git", ["-C", repository, "cat-file", "-e", `${base}:${source}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function evidenceChanged(paths: readonly string[]): boolean {
  return paths.includes(PROMPT_COMPATIBILITY_MANIFEST.evidencePath);
}

async function verifyEvidenceRequests(
  evidence: ReturnType<typeof parseGemmaCompatibilityEvidence>
): Promise<void> {
  const profile = replayProfileFromEvidence(evidence.profile, evidence.runtime);
  assertApprovedReplay(evidence.runtime, profile);
  const pairs = await buildReplayRequestPairs(
    "http://127.0.0.1:8080/v1",
    evidence.runtime,
    profile
  );
  const fingerprintFor = (side: "baseline" | "candidate") => aggregateRequestFingerprint(
    pairs.map((pair) => ({
      operation: pair.operation.operation,
      seed: pair.seed,
      requestFingerprint: replayRequestBodyFingerprint(pair[side].body)
    }))
  );
  if (fingerprintFor("baseline") !== evidence.baseline.requestFingerprint) {
    throw new Error("evaluation baseline requests do not match the checked runtime and profile");
  }
  if (fingerprintFor("candidate") !== evidence.candidate.requestFingerprint) {
    throw new Error("evaluation candidate requests do not match the current prompt, runtime, and profile");
  }
}

export async function checkPromptCompatibility(repository: string, base: string, head: string): Promise<void> {
  if (baselineSourceFingerprint(repository) !== PROMPT_COMPATIBILITY_MANIFEST.baselineSourceFingerprint) {
    throw new Error("the v0.8.0 source tag does not match the frozen prompt baseline");
  }
  const frozenRequestFingerprint = await baselineFixtureRequestFingerprint();
  if (frozenRequestFingerprint !== PROMPT_COMPATIBILITY_MANIFEST.baselineFixtureRequestFingerprint) {
    throw new Error(
      `the frozen v0.8.0 fixture requests do not match the prompt baseline: ${frozenRequestFingerprint}`
    );
  }
  const paths = changedPaths(repository, base, head);
  const changedSource = sourceChanged(repository, base, paths);
  const changedEvidence = evidenceChanged(paths);
  if (!changedSource && !changedEvidence) {
    process.stdout.write("prompt compatibility: protected prompt sources unchanged\n");
    return;
  }
  if (!changedEvidence) {
    throw new Error(`protected prompt sources changed; update ${PROMPT_COMPATIBILITY_MANIFEST.evidencePath} with paired evaluation evidence`);
  }
  let evidenceText: string;
  try {
    evidenceText = readFileSync(path.join(repository, PROMPT_COMPATIBILITY_MANIFEST.evidencePath), "utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(`changed ${PROMPT_COMPATIBILITY_MANIFEST.evidencePath} is missing`);
    }
    throw error;
  }
  const evidence = parseGemmaCompatibilityEvidence(parseJsonRejectingDuplicateKeys(
    evidenceText,
    "Gemma prompt compatibility evidence"
  ));
  if (evidence.baseline.sourceFingerprint !== PROMPT_COMPATIBILITY_MANIFEST.baselineSourceFingerprint) {
    throw new Error("evaluation baseline does not match the protected v0.8.0 prompt sources");
  }
  if (evidence.candidate.sourceFingerprint !== protectedSourceFingerprint(repository)) {
    throw new Error("evaluation candidate does not match the protected prompt sources");
  }
  if (evidence.candidate.evaluationInputFingerprint !== protectedEvaluationInputFingerprint(repository)) {
    throw new Error("evaluation inputs do not match the current checkout");
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
  const head = take("--head") ?? "HEAD";
  const base = take("--base") ?? "HEAD^";
  await checkPromptCompatibility(repository, base, head);
}

if (process.argv[1]?.endsWith("check-prompt-compatibility.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`prompt compatibility: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

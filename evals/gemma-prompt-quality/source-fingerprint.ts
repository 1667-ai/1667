import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prompt sources and runtime dependencies protected by the Gemma replay gate.
 * Provider-default branches are outside the fixed llama.cpp route.
 */
export const GEMMA_PROTECTED_PROMPT_SOURCES = [
  "server/generation-prompts.ts",
  "shared/continuation-plan.ts",
  "shared/prompt-plan.ts",
  "shared/chapters.ts",
  "shared/authors-note.ts",
  "shared/story-tree.ts",
  "shared/types.ts"
] as const;

/** Current production assembly code. It is absent from the v0.8.0 tag. */
export const GEMMA_CURRENT_PRODUCTION_SOURCES = [
  "server/continuation-assembly.ts"
] as const;

/** Evaluation inputs changed after v0.8.0. They require new evidence but do
 * not contribute to the frozen v0.8.0 source identity. */
export const GEMMA_PROTECTED_EVALUATION_SOURCES = [
  "evals/gemma-prompt-quality/fixture.ts",
  "evals/gemma-prompt-quality/gemma-long-story.txt",
  "evals/gemma-prompt-quality/approved-replay.json",
  "evals/gemma-prompt-quality/approved-replay.ts"
] as const;

export function protectedPromptSourceFingerprint(repositoryRoot = process.cwd()): string {
  return sourceFingerprint(repositoryRoot, [
    ...GEMMA_PROTECTED_PROMPT_SOURCES,
    ...GEMMA_CURRENT_PRODUCTION_SOURCES
  ]);
}

/** Fingerprint the fixture and replay protocol used to produce evidence. */
export function protectedEvaluationInputFingerprint(repositoryRoot = process.cwd()): string {
  return sourceFingerprint(repositoryRoot, GEMMA_PROTECTED_EVALUATION_SOURCES);
}

function sourceFingerprint(repositoryRoot: string, sources: readonly string[]): string {
  const digest = createHash("sha256");
  for (const source of sources) {
    digest.update(source);
    digest.update("\0");
    digest.update(readFileSync(path.join(repositoryRoot, source)));
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

/** Fingerprint the same protected files from the frozen v0.8.0 git tag. */
export function frozenV08SourceFingerprint(repositoryRoot = process.cwd()): string {
  const digest = createHash("sha256");
  for (const source of GEMMA_PROTECTED_PROMPT_SOURCES) {
    digest.update(source);
    digest.update("\0");
    digest.update(execFileSync("git", ["-C", repositoryRoot, "show", `v0.8.0:${source}`]));
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

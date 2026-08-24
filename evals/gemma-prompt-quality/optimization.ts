import { parseCandidateOptimization, type GemmaCandidateOptimization } from "./contract.js";

/** Parse and bind the closed candidate identity used by replay evidence. */
export function parseEvidenceOptimization(value: unknown, label: string): GemmaCandidateOptimization {
  return parseCandidateOptimization(value, label);
}

export function requireMatchingOptimization(
  value: unknown,
  expected: GemmaCandidateOptimization,
  label: string
): void {
  const actual = parseCandidateOptimization(value, label);
  if (actual !== expected) throw new Error(`${label} does not match ${expected}`);
}

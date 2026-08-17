import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  aggregateRequestFingerprint,
  type GemmaEvidenceCase
} from "../evals/gemma-prompt-quality/contract.js";
import {
  commit,
  createRepository,
  evidence,
  recomputeEvaluation,
  runChecker,
  writeEvidence
} from "./prompt-compatibility-fixture.js";

test("prompt gate accepts current paired evidence", async () => {
  const repository = createRepository();
  try {
    writeEvidence(repository, await evidence(repository));
    commit(repository, "test: record prompt evaluation");
    const result = runChecker(repository);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /paired evaluation evidence accepted/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("prompt gate rejects evidence for a different candidate request", async () => {
  const repository = createRepository();
  try {
    const recorded = await evidence(repository);
    const cases = [{
      ...recorded.evaluation.cases[0]!,
      candidate: {
        ...recorded.evaluation.cases[0]!.candidate,
        requestFingerprint: `sha256:${createHash("sha256").update("fabricated request").digest("hex")}`
      }
    }, ...recorded.evaluation.cases.slice(1)] as GemmaEvidenceCase[];
    recorded.evaluation.cases = cases;
    recorded.candidate.requestFingerprint = aggregateRequestFingerprint(cases.map((entry) => ({
      operation: entry.operation,
      seed: entry.seed,
      requestFingerprint: entry.candidate.requestFingerprint
    })));
    recomputeEvaluation(recorded);
    writeEvidence(repository, recorded);
    commit(repository, "test: record mismatched prompt evidence");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /evaluation candidate requests do not match the current prompt, runtime, and profile/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("prompt gate rejects a candidate regression", async () => {
  const repository = createRepository();
  try {
    const recorded = await evidence(repository);
    const firstCase = recorded.evaluation.cases[0]!;
    recorded.evaluation.cases = [{
      ...firstCase,
      candidate: {
        ...firstCase.candidate,
        scores: { ...firstCase.candidate.scores, boundaryContinuity: 2 }
      }
    }, ...recorded.evaluation.cases.slice(1)] as GemmaEvidenceCase[];
    recomputeEvaluation(recorded);
    writeEvidence(repository, recorded);
    commit(repository, "test: record a prompt regression");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /paired evaluation contains candidate rubric regressions/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("prompt gate rejects missing or malformed evidence", () => {
  const missing = createRepository();
  try {
    const result = runChecker(missing);
    assert.equal(result.code, 1);
    assert.match(result.output, /evidence\.json is missing/);
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }

  const malformed = createRepository();
  try {
    const evidencePath = path.join(malformed, "evals/gemma-prompt-quality/evidence.json");
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, "{\n");
    commit(malformed, "test: write malformed evidence");
    const result = runChecker(malformed);
    assert.equal(result.code, 1);
    assert.match(result.output, /is not valid strict JSON/);
  } finally {
    rmSync(malformed, { recursive: true, force: true });
  }
});

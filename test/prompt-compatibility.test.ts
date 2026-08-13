import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PROMPT_COMPATIBILITY_MANIFEST } from "../scripts/check-prompt-compatibility.js";
import {
  aggregateRequestFingerprint,
  type GemmaEvidenceCase
} from "../evals/gemma-prompt-quality/contract.js";
import { commit, createRepository, evidence, recomputeEvaluation, runChecker, writeEvidence } from "./prompt-compatibility-fixture.js";

test("unrelated changes do not require prompt evaluation evidence", () => {
  const repository = createRepository();
  try {
    writeFileSync(path.join(repository, "other.ts"), "export const unchanged = false;\n");
    commit(repository, "test: change an unrelated source");
    const result = runChecker(repository);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /protected prompt sources unchanged/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const protectedSource of PROMPT_COMPATIBILITY_MANIFEST.protectedSources) {
  test(`${protectedSource} requires changed paired evaluation evidence`, () => {
    const repository = createRepository();
    try {
      const source = path.join(repository, protectedSource);
      writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
      commit(repository, "test: change a prompt source");
      const result = runChecker(repository);
      assert.equal(result.code, 1);
      assert.match(result.output, /update evals\/gemma-prompt-quality\/evidence\.json/);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("renaming a protected prompt source requires changed paired evaluation evidence", () => {
  const repository = createRepository();
  try {
    renameSync(
      path.join(repository, "shared", "continuation-plan.ts"),
      path.join(repository, "shared", "relocated-continuation-plan.ts")
    );
    commit(repository, "test: rename a prompt source");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /update evals\/gemma-prompt-quality\/evidence\.json/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("paired Retake and Continue evidence accepts a reviewed prompt source", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    writeEvidence(repository, await evidence(repository));
    commit(repository, "test: record prompt evaluation");
    const result = runChecker(repository);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /paired evaluation evidence accepted/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("evidence rejects request fingerprints that no checked request can produce", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    const recorded = await evidence(repository);
    (recorded.evaluation.cases[0]!.candidate as { requestFingerprint: string }).requestFingerprint =
      `sha256:${createHash("sha256").update("fabricated request").digest("hex")}`;
    recorded.candidate.requestFingerprint = aggregateRequestFingerprint(
      recorded.evaluation.cases.map((entry) => ({
        operation: entry.operation,
        seed: entry.seed,
        requestFingerprint: entry.candidate.requestFingerprint
      }))
    );
    recomputeEvaluation(recorded);
    writeEvidence(repository, recorded);
    commit(repository, "test: record fabricated request evidence");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(
      result.output,
      /evaluation candidate requests do not match the current prompt, runtime, and profile/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("evidence rejects duplicate JSON keys", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    const recorded = JSON.stringify(await evidence(repository), null, 2);
    const evidencePath = path.join(repository, PROMPT_COMPATIBILITY_MANIFEST.evidencePath);
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    writeFileSync(
      evidencePath,
      `{"schemaVersion":1,${recorded.slice(1)}`
    );
    commit(repository, "test: record duplicate prompt evaluation evidence");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /duplicate object key/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("evidence rejects a missing paired rubric score", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    const recorded = await evidence(repository) as {
      evaluation: { cases: Array<{ baseline: { scores: Record<string, number> } }> };
    };
    delete recorded.evaluation.cases[0]!.baseline.scores.povTenseConsistency;
    writeEvidence(repository, recorded);
    commit(repository, "test: record incomplete prompt evaluation");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /scores has unsupported or missing rubric fields/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("evidence rejects a baseline rubric score below the adequacy floor", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    const recorded = await evidence(repository);
    const firstCase = recorded.evaluation.cases[0]!;
    recorded.evaluation.cases = [{
      ...firstCase,
      baseline: {
        ...firstCase.baseline,
        scores: { ...firstCase.baseline.scores, boundaryContinuity: 1 }
      }
    }, ...recorded.evaluation.cases.slice(1)];
    writeEvidence(repository, recorded);
    commit(repository, "test: record an inadequate prompt baseline");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /baseline scores must be at least 2 for every rubric/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("evidence rejects self-consistent candidate score regression", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    const recorded = await evidence(repository);
    const evaluation = recorded.evaluation as unknown as {
      cases: Array<{
        operation: string;
        seed: number;
        candidate: { scores: Record<string, number> };
      }>;
    };
    const candidate = evaluation.cases.find((sample) =>
      sample.operation === "continue" && sample.seed === 303
    );
    candidate!.candidate.scores.styleVoiceCadenceContinuity = 2;
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

test("evidence rejects a note with a URL", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    const recorded = await evidence(repository);
    const firstCase = recorded.evaluation.cases[0]!;
    recorded.evaluation.cases = [{
      ...firstCase,
      baseline: { ...firstCase.baseline, notes: "See https://example.com/raw-output" }
    }, ...recorded.evaluation.cases.slice(1)];
    writeEvidence(repository, recorded);
    commit(repository, "test: record unsafe evaluation note");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /notes must be a trimmed, single-line summary/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("evidence rejects a credential-like note", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    const recorded = await evidence(repository);
    const firstCase = recorded.evaluation.cases[0]!;
    recorded.evaluation.cases = [{
      ...firstCase,
      baseline: { ...firstCase.baseline, notes: "Bearer very-secret-evaluation-key" }
    }, ...recorded.evaluation.cases.slice(1)];
    writeEvidence(repository, recorded);
    commit(repository, "test: record unsafe evaluation credential");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /without a URL or credential-like value/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("evidence rejects a provider token in a note", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    const recorded = await evidence(repository);
    const firstCase = recorded.evaluation.cases[0]!;
    recorded.evaluation.cases = [{
      ...firstCase,
      baseline: {
        ...firstCase.baseline,
        notes: ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuv"].join("-")
      }
    }, ...recorded.evaluation.cases.slice(1)];
    writeEvidence(repository, recorded);
    commit(repository, "test: record a provider token");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /without a URL or credential-like value/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("evidence rejects a dispatch order outside the fixed schedule", async () => {
  const repository = createRepository();
  try {
    const source = path.join(repository, "shared", "continuation-plan.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
    const recorded = await evidence(repository);
    const firstCase = recorded.evaluation.cases[0]!;
    recorded.evaluation.cases = [{
      ...firstCase,
      dispatchOrder: [...firstCase.dispatchOrder].reverse() as GemmaEvidenceCase["dispatchOrder"]
    }, ...recorded.evaluation.cases.slice(1)];
    writeEvidence(repository, recorded);
    commit(repository, "test: record unbalanced dispatch order");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /does not match the fixed balanced dispatch schedule/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

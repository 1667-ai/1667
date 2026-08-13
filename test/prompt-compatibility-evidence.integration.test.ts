import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PROMPT_COMPATIBILITY_MANIFEST } from "../scripts/check-prompt-compatibility.js";
import {
  commit,
  createRepository,
  evidence,
  recomputeEvaluation,
  runChecker,
  type RecordedEvidence,
  writeEvidence
} from "./prompt-compatibility-fixture.js";

test("evaluation protocol bootstrap and later changes", () => {
  for (const source of PROMPT_COMPATIBILITY_MANIFEST.protectedEvaluationSources) {
    const bootstrap = createRepository(false);
    try {
      const target = path.join(bootstrap, source);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "new evaluation input\n");
      commit(bootstrap, "test: add evaluation input");
      assert.equal(runChecker(bootstrap).code, 0);
    } finally { rmSync(bootstrap, { recursive: true, force: true }); }
  }
  for (const source of ["evals/gemma-prompt-quality/fixture.ts", "evals/gemma-prompt-quality/approved-replay.json"]) {
    const repository = createRepository(true);
    try {
      appendFileSync(path.join(repository, source), "\n");
      commit(repository, "test: change evaluation input");
      const result = runChecker(repository);
      assert.equal(result.code, 1);
      assert.match(result.output, /update evals\/gemma-prompt-quality\/evidence\.json/);
    } finally { rmSync(repository, { recursive: true, force: true }); }
  }
});

test("a later continuation assembly change requires evidence", () => {
  const repository = createRepository();
  try {
    appendFileSync(path.join(repository, "server/continuation-assembly.ts"), "\n");
    commit(repository, "test: change continuation assembly");
    const result = runChecker(repository);
    assert.equal(result.code, 1);
    assert.match(result.output, /update evals\/gemma-prompt-quality\/evidence\.json/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("evidence binds the fixture and replay protocol checkout", async () => {
  const staleRepository = createRepository(true);
  try {
    const recorded = await evidence(staleRepository);
    writeEvidence(staleRepository, recorded);
    commit(staleRepository, "test: record fixture evaluation evidence");
    const fixture = path.join(staleRepository, "evals/gemma-prompt-quality/fixture.ts");
    writeFileSync(fixture, readFileSync(fixture, "utf8").replace(
      "stock weather, or a fresh character introduction",
      "stock weather, an empty corridor, or a fresh character introduction"
    ));
    writeFileSync(
      path.join(staleRepository, PROMPT_COMPATIBILITY_MANIFEST.evidencePath),
      `${JSON.stringify(recorded)}\n`
    );
    commit(staleRepository, "test: change scoring fixture with stale evidence");
    const result = runChecker(staleRepository);
    assert.equal(result.code, 1);
    assert.match(result.output, /evaluation inputs do not match the current checkout/);
  } finally {
    rmSync(staleRepository, { recursive: true, force: true });
  }

  const reviewedRepository = createRepository(true);
  try {
    const fixture = path.join(reviewedRepository, "evals/gemma-prompt-quality/fixture.ts");
    writeFileSync(fixture, readFileSync(fixture, "utf8").replace(
      "stock weather, or a fresh character introduction",
      "stock weather, an empty corridor, or a fresh character introduction"
    ));
    writeEvidence(reviewedRepository, await evidence(reviewedRepository));
    commit(reviewedRepository, "test: record changed fixture evaluation evidence");
    const result = runChecker(reviewedRepository);
    assert.equal(result.code, 0, result.output);
  } finally {
    rmSync(reviewedRepository, { recursive: true, force: true });
  }
});

test("evidence-only changes are validated", async (t) => {
  const checkedRepository = async (
    name: string,
    change: (repository: string, recorded: RecordedEvidence) => void,
    expected: RegExp
  ): Promise<void> => {
    const repository = createRepository();
    try {
      writeEvidence(repository, await evidence(repository));
      commit(repository, "test: record base prompt evaluation evidence");
      change(repository, await evidence(repository));
      commit(repository, `test: ${name}`);
      const result = runChecker(repository);
      assert.equal(result.code, 1);
      assert.match(result.output, expected);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  };
  await t.test("rejects malformed evidence", () => checkedRepository(
    "write malformed prompt evaluation evidence",
    (repository) => writeFileSync(path.join(repository, PROMPT_COMPATIBILITY_MANIFEST.evidencePath), "{\n"),
    /is not valid strict JSON/
  ));
  await t.test("rejects regressing evidence", () => checkedRepository(
    "write regressing prompt evaluation evidence",
    (repository, recorded) => {
      const firstCase = recorded.evaluation.cases[0]!;
      recorded.evaluation.cases = [{
        ...firstCase,
        candidate: { ...firstCase.candidate, scores: { ...firstCase.candidate.scores, boundaryContinuity: 2 } }
      }, ...recorded.evaluation.cases.slice(1)];
      recomputeEvaluation(recorded);
      writeEvidence(repository, recorded);
    },
    /paired evaluation contains candidate rubric regressions/
  ));
  await t.test("rejects deleted evidence", () => checkedRepository(
    "delete prompt evaluation evidence",
    (repository) => unlinkSync(path.join(repository, PROMPT_COMPATIBILITY_MANIFEST.evidencePath)),
    /changed evals\/gemma-prompt-quality\/evidence\.json is missing/
  ));
});

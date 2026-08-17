import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import {
  createBlindPackArtifacts,
  parseBlindMapping,
  writeBlindMapping,
  writeBlindPack,
  type BlindMapping,
  type BlindPack
} from "../evals/gemma-prompt-quality/scoring.js";
import { parseGemmaCompatibilityEvidence } from "../evals/gemma-prompt-quality/evidence-schema.js";
import { parseReplayProfileManifest } from "../evals/gemma-prompt-quality/profile.js";
import { parseGemmaRuntimeConfiguration } from "../evals/gemma-prompt-quality/runtime.js";
import { runReplay, writeReplay } from "../evals/gemma-prompt-quality/runner.js";
import { GEMMA_CANDIDATE_OPTIMIZATION } from "../evals/gemma-prompt-quality/contract.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(process.cwd());
const CLI = resolve(REPO_ROOT, "evals/gemma-prompt-quality/cli.ts");
const TEST_RUNTIME = parseGemmaRuntimeConfiguration({
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

test("Gemma replay CLI requires the operator server attestation", async () => {
  await assert.rejects(
    runCli(
      "replay",
      "--endpoint", "http://127.0.0.1:5001/v1",
      "--runtime-config", "/missing/runtime.json",
      "--profile", "/missing/profile.json",
      "--optimization", GEMMA_CANDIDATE_OPTIMIZATION,
      "--output", "/tmp/missing-replay.json"
    ),
    (error: unknown) => error instanceof Error
      && "stderr" in error
      && typeof error.stderr === "string"
      && error.stderr.includes("--exclusive-server is required")
  );
});

test("Gemma blind CLI keeps the mapping private and binds it before scoring", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "1667-gemma-blind-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    const body = JSON.parse(await requestText(request)) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: `"seed-${String(body.seed)}"` }, finish_reason: null }] })}`,
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"));
  });
  const origin = await listen(server);
  t.after(() => close(server));

  const replay = await runReplay({
    endpointBaseUrl: `${origin}/v1`,
    model: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
    runtime: TEST_RUNTIME,
    profile: testProfile(),
    optimization: GEMMA_CANDIDATE_OPTIMIZATION,
    operatorAcknowledgedExclusiveServer: true
  });
  const replayPath = resolve(directory, "replay.json");
  const blindPath = resolve(directory, "blind.json");
  const otherBlindPath = resolve(directory, "other-blind.json");
  const mappingPath = resolve(directory, "mapping.json");
  const scoresPath = resolve(directory, "scores.json");
  const evidencePath = resolve(directory, "evidence.json");
  const otherEvidencePath = resolve(directory, "other-evidence.json");
  await writeReplay(replayPath, replay);
  assert.equal((await stat(replayPath)).mode & 0o777, 0o600);
  await chmod(replayPath, 0o644);
  await writeReplay(replayPath, replay);
  assert.equal((await stat(replayPath)).mode & 0o777, 0o600);
  await assertPrivateReplacement(
    replayPath,
    resolve(directory, "replay-victim.txt"),
    () => writeReplay(replayPath, replay)
  );

  await runCli("blind", "--replay", replayPath, "--output", blindPath, "--mapping", mappingPath);
  const blindText = await readFile(blindPath, "utf8");
  const blind = JSON.parse(blindText) as BlindPack;
  for (const sample of blind.samples) {
    assert.deepEqual(Object.keys(sample).sort(), ["blindId", "output", "referenceId"]);
  }
  const referenceIds = Object.keys(blind.references).sort();
  assert.deepEqual(referenceIds, ["ref-01", "ref-02"]);
  assert.equal(Object.hasOwn(blind.references, "retake"), false);
  assert.equal(Object.hasOwn(blind.references, "continue"), false);
  const blindJson = JSON.stringify(blind);
  assert.doesNotMatch(blindJson, /"(?:shuffleSeed|operation|seed|outputFingerprint|pairId|arm|baseline|candidate)"\s*:/u);
  const mappingText = await readFile(mappingPath, "utf8");
  const mapping = JSON.parse(mappingText) as BlindMapping;
  assert.equal(Number.isSafeInteger(mapping.shuffleSeed), true);
  assert.equal(typeof mapping.packFingerprint, "string");
  assert.equal(typeof mapping.replayFingerprint, "string");
  assert.equal(mapping.optimization, GEMMA_CANDIDATE_OPTIMIZATION);
  assert.throws(
    () => parseBlindMapping({ ...mapping, optimization: "off" }),
    /blind mapping optimization must be exactly late-cache-stable/
  );
  const referenceBindings = mapping.referenceBindings;
  assert.equal(referenceBindings.length, 2);
  assert.deepEqual(new Set(referenceBindings.map((binding) => binding.referenceId)), new Set(referenceIds));
  const assignments = mapping.assignments;
  for (const operation of ["retake", "continue"]) {
    assert.equal(new Set(assignments.filter((entry) => entry.operation === operation).map((entry) => entry.referenceId)).size, 1);
  }
  assert.equal(new Set(assignments.map((entry) => entry.referenceId)).size, 2);

  const deterministicA = createBlindPackArtifacts(replay, { entropy: () => Uint8Array.from({ length: 32 }, () => 7) });
  const deterministicB = createBlindPackArtifacts(replay, { entropy: () => Uint8Array.from({ length: 32 }, () => 7) });
  assert.deepEqual(deterministicA, deterministicB);

  await chmod(blindPath, 0o644);
  await writeBlindPack(blindPath, blind);
  assert.equal((await stat(blindPath)).mode & 0o777, 0o600);
  await chmod(mappingPath, 0o644);
  await writeBlindMapping(mappingPath, mapping);
  assert.equal((await stat(mappingPath)).mode & 0o777, 0o600);
  await assertPrivateReplacement(
    blindPath,
    resolve(directory, "blind-victim.txt"),
    () => writeBlindPack(blindPath, blind)
  );
  await assertPrivateReplacement(
    mappingPath,
    resolve(directory, "mapping-victim.txt"),
    () => writeBlindMapping(mappingPath, mapping)
  );

  const scoresText = JSON.stringify({
    scores: blind.samples.map((sample) => ({
      blindId: sample.blindId,
      scores: {
        boundaryContinuity: 2,
        styleVoiceCadenceContinuity: 2,
        povTenseConsistency: 2,
        factContextRetention: 2,
        genericSceneResetAvoidance: 2
      },
      notes: "The output keeps the established story context."
    }))
  });
  await writeFile(scoresPath, scoresText);
  await runCli(
    "score",
    "--replay", replayPath,
    "--blind", blindPath,
    "--mapping", mappingPath,
    "--scores", scoresPath,
    "--output", evidencePath
  );
  const evidence = parseGemmaCompatibilityEvidence(JSON.parse(await readFile(evidencePath, "utf8")));
  assert.equal(evidence.evaluation.sampleCount, 20);

  await runCli("blind", "--replay", replayPath, "--output", otherBlindPath, "--mapping", resolve(directory, "other-mapping.json"));
  await assert.rejects(
    runCli(
      "score",
      "--replay", replayPath,
      "--blind", otherBlindPath,
      "--mapping", mappingPath,
      "--scores", scoresPath,
      "--output", otherEvidencePath
    ),
    (error: unknown) => error instanceof Error
      && "stderr" in error
      && typeof error.stderr === "string"
      && error.stderr.includes("blind mapping does not belong to the blind pack")
  );

  await writeFile(scoresPath, '{"scores":[],"scores":[]}');
  await assertDuplicateJsonRejected(runCli(
    "score",
    "--replay", replayPath,
    "--blind", blindPath,
    "--mapping", mappingPath,
    "--scores", scoresPath,
    "--output", evidencePath
  ));
  await writeFile(scoresPath, scoresText);

  await writeFile(blindPath, '{"schemaVersion":1,"schemaVersion":1}');
  await assertDuplicateJsonRejected(runCli(
    "score",
    "--replay", replayPath,
    "--blind", blindPath,
    "--mapping", mappingPath,
    "--scores", scoresPath,
    "--output", evidencePath
  ));
  await writeFile(blindPath, blindText);

  await writeFile(mappingPath, '{"schemaVersion":1,"schemaVersion":1}');
  await assertDuplicateJsonRejected(runCli(
    "score",
    "--replay", replayPath,
    "--blind", blindPath,
    "--mapping", mappingPath,
    "--scores", scoresPath,
    "--output", evidencePath
  ));
  await writeFile(mappingPath, mappingText);

  await writeFile(replayPath, '{"schemaVersion":1,"schemaVersion":1}');
  await assertDuplicateJsonRejected(runCli(
    "blind",
    "--replay", replayPath,
    "--output", blindPath,
    "--mapping", mappingPath
  ));
});

function testProfile() {
  return parseReplayProfileManifest({
    schemaVersion: 1,
    runtimeArtifactSha256: TEST_RUNTIME.configuration.model.artifact.sha256,
    profile: {
      name: "Gemma blind test profile",
      generation: {
        temperature: 0.7,
        maxOutputTokens: 400,
        effort: "default",
        cachePolicy: "off",
        tokenProbabilities: null
      },
      sampling: {
        ...EMPTY_SAMPLING_V2,
        topP: 0.92,
        topK: 40,
        minP: 0.05,
        repeatPenalty: 1.08
      },
      timeouts: { responseHeaderMs: 600_000, firstTokenMs: 120_000, idleMs: 120_000, totalMs: 1_800_000 }
    }
  }, TEST_RUNTIME);
}

function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: REPO_ROOT });
}

async function assertDuplicateJsonRejected(command: Promise<unknown>): Promise<void> {
  await assert.rejects(command, (error: unknown) => error instanceof Error
    && "stderr" in error
    && typeof error.stderr === "string"
    && error.stderr.includes("duplicate object key"));
}

async function assertPrivateReplacement(
  pathname: string,
  victimPath: string,
  write: () => Promise<void>
): Promise<void> {
  const victim = "The private JSON writer must not change this file.\n";
  await writeFile(victimPath, victim);
  await rm(pathname);
  await symlink(victimPath, pathname);
  await write();
  assert.equal(await readFile(victimPath, "utf8"), victim);
  assert.equal((await lstat(pathname)).isSymbolicLink(), false);
  assert.equal((await stat(pathname)).mode & 0o777, 0o600);
  assert.match(await readFile(pathname, "utf8"), /"schemaVersion": 1/u);
}

function requestText(request: IncomingMessage): Promise<string> {
  return new Promise((resolveText, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolveText(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolveOrigin, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveOrigin(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));
}

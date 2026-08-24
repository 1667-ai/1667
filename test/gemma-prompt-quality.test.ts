import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalJson } from "../server/canonical-json.js";
import { createBlindPackArtifacts, scoreReplay } from "../evals/gemma-prompt-quality/scoring.js";
import {
  aggregateRequestFingerprint,
  GEMMA_CANDIDATE_OPTIMIZATION,
  GEMMA_EXPECTED_BLIND_SAMPLE_COUNT,
  GEMMA_REPLAY_OPERATIONS,
  GEMMA_REPLAY_SEEDS,
  GEMMA_SCORING_PROTOCOL,
  GEMMA_SCORING_PROTOCOL_FINGERPRINT,
  gemmaScoringProtocolMarkdown
} from "../evals/gemma-prompt-quality/contract.js";
import { parseGemmaCompatibilityEvidence } from "../evals/gemma-prompt-quality/evidence-schema.js";
import { parseReplayResult } from "../evals/gemma-prompt-quality/replay-schema.js";
import { runReplay } from "../evals/gemma-prompt-quality/runner.js";
import {
  close,
  closeSecure,
  listen,
  listenSecure,
  requestText,
  TEST_RUNTIME,
  testProfile
} from "./gemma-prompt-quality-test-support.js";
const runFile = promisify(execFile);

test("Gemma scoring anchors bind the scorer instructions to the gate floor", () => {
  const readme = readFileSync(path.join(process.cwd(), "evals/gemma-prompt-quality/README.md"), "utf8");
  assert.equal(readme.includes(gemmaScoringProtocolMarkdown()), true);
  assert.equal(GEMMA_SCORING_PROTOCOL.baselineScoreFloor, 2);
  assert.equal(GEMMA_SCORING_PROTOCOL.anchors[1].includes("major defect or break"), true);
  assert.equal(GEMMA_SCORING_PROTOCOL.anchors[2].includes("noticeable but non-major"), true);
  assert.match(GEMMA_SCORING_PROTOCOL.dimensionGuidance.styleVoiceCadenceContinuity, /Use 1 only for a major voice or cadence break/);
  assert.match(GEMMA_SCORING_PROTOCOL_FINGERPRINT, /^sha256:[a-f0-9]{64}$/u);
});

test("Gemma replay pairs both prompt versions and preserves profile sampling", async (t) => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    const body = JSON.parse(await requestText(request)) as Record<string, unknown>;
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: `" seed-${String(body.seed)}` }, finish_reason: null }] })}`,
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"));
  });
  const origin = await listen(server);
  t.after(() => close(server));

  const profile = testProfile();
  const result = await runReplay({
    endpointBaseUrl: `${origin}/v1`,
    model: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
    runtime: TEST_RUNTIME,
    profile,
    optimization: GEMMA_CANDIDATE_OPTIMIZATION,
    operatorAcknowledgedExclusiveServer: true
  });

  for (const changedProfile of [
    { ...profile, maxOutputTokens: 401 },
    { ...profile, temperature: 0.6 },
    { ...profile, sampling: { ...profile.sampling, topK: 41 } }
  ]) {
    await assert.rejects(
      runReplay({
        endpointBaseUrl: `${origin}/v1`,
        model: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
        runtime: TEST_RUNTIME,
        profile: changedProfile,
        optimization: GEMMA_CANDIDATE_OPTIMIZATION,
        operatorAcknowledgedExclusiveServer: true
      }),
      /profile does not match approved replay protocol/
    );
  }

  assert.equal(requests.length, GEMMA_EXPECTED_BLIND_SAMPLE_COUNT);
  assert.equal(result.optimization, GEMMA_CANDIDATE_OPTIMIZATION);
  assert.equal(result.operatorAcknowledgedExclusiveServer, true);
  assert.equal(result.runtime.configuration.koboldCpp.version, "1.117.1");
  assert.equal(result.runtime.configuration.model.artifact.sha256, `sha256:${"a".repeat(64)}`);
  assert.deepEqual(result.seeds, GEMMA_REPLAY_SEEDS);
  assert.deepEqual(result.operations, GEMMA_REPLAY_OPERATIONS);
  assert.equal(new Set(result.samples.map((sample) => sample.pairId)).size, 10);
  const dispatchCounts = new Map<string, number>();
  for (const sample of result.samples) {
    const order = sample.dispatchOrder.join("/");
    dispatchCounts.set(order, (dispatchCounts.get(order) ?? 0) + 1);
    const expectedFinalRole = sample.operation === "retake" ? "user" : "assistant";
    assert.equal(sample.baseline.request.promptShape.finalRole, expectedFinalRole);
    assert.equal(sample.candidate.request.promptShape.finalRole, expectedFinalRole);
    assert.equal(sample.baseline.request.preset, "koboldcpp");
    assert.equal(sample.candidate.request.preset, "koboldcpp");
  }
  assert.deepEqual([...dispatchCounts.entries()].sort(), [
    ["baseline/candidate", 5],
    ["candidate/baseline", 5]
  ]);
  for (const body of requests) {
    assert.equal(body.model, "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0");
    assert.equal(body.temperature, 0.7);
    assert.equal(body.max_tokens, 400);
    assert.equal(body.top_p, 0.92);
    assert.equal(body.top_k, 40);
    assert.equal(body.min_p, 0.05);
    assert.equal(body.repeat_penalty, 1.08);
    assert.equal(typeof body.seed, "number");
    assert.equal(body.stream, true);
    assert.equal(body.cache_prompt, false);
    assert.ok(Array.isArray(body.messages));
  }
  const seedCounts = new Map<number, number>();
  for (const body of requests) seedCounts.set(body.seed as number, (seedCounts.get(body.seed as number) ?? 0) + 1);
  assert.deepEqual([...seedCounts.entries()].sort((a, b) => a[0] - b[0]), [[101, 4], [202, 4], [303, 4], [404, 4], [505, 4]]);

  const reparsed = parseReplayResult(JSON.parse(JSON.stringify(result)));
  for (const value of [undefined, "off", "late-cache-stable+other"]) {
    const invalidOptimization = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    if (value === undefined) delete invalidOptimization.optimization;
    else invalidOptimization.optimization = value;
    assert.throws(
      () => parseReplayResult(invalidOptimization),
      /replay(?:\.optimization)?(?: must be exactly late-cache-stable| has unsupported or missing fields)/
    );
  }
  for (const value of [undefined, false]) {
    const invalidAttestation = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    if (value === undefined) delete invalidAttestation.operatorAcknowledgedExclusiveServer;
    else invalidAttestation.operatorAcknowledgedExclusiveServer = value;
    assert.throws(
      () => parseReplayResult(invalidAttestation),
      /replay(?:\.operatorAcknowledgedExclusiveServer)?(?: must be true| is invalid| has unsupported or missing fields)/
    );
  }
  for (const [label, change] of invalidProfileChanges()) {
    const invalidReplay = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    change(invalidReplay.profile as Record<string, unknown>);
    assert.throws(() => parseReplayResult(invalidReplay), label);
  }
  const mismatchedEndpoint = JSON.parse(JSON.stringify(result)) as typeof result;
  (mismatchedEndpoint.samples[0]!.candidate.request as { url: string }).url =
    "http://other.invalid/v1/chat/completions";
  assert.throws(
    () => parseReplayResult(mismatchedEndpoint),
    /url does not match replay\.endpoint\.requestUrl/
  );
  const tampered = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  const tamperedSamples = tampered.samples as Array<Record<string, unknown>>;
  const tamperedCandidate = (tamperedSamples[0]!.candidate) as Record<string, unknown>;
  const tamperedRequest = tamperedCandidate.request as Record<string, unknown>;
  const tamperedBody = tamperedRequest.body as Record<string, unknown>;
  const tamperedSampling = tamperedRequest.sampling as Record<string, unknown>;
  tamperedBody.top_p = 0.91;
  tamperedSampling.top_p = 0.91;
  tamperedRequest.bodyFingerprint = fingerprint(tamperedBody);
  tampered.candidateRequestFingerprint = aggregateRequestFingerprint(tamperedSamples.map((sample) => ({
    operation: sample.operation as typeof result.samples[number]["operation"],
    seed: sample.seed as typeof result.samples[number]["seed"],
    requestFingerprint: ((sample.candidate as Record<string, unknown>).request as Record<string, unknown>).bodyFingerprint as string
  })));
  assert.throws(
    () => parseReplayResult(tampered),
    /baseline and candidate generation settings differ|generation settings do not match/
  );
  const artifacts = createBlindPackArtifacts(reparsed, {
    entropy: () => Uint8Array.from({ length: 32 }, () => 7)
  });
  const blind = artifacts.pack;
  assert.equal(blind.samples.length, GEMMA_EXPECTED_BLIND_SAMPLE_COUNT);
  assert.deepEqual(
    Object.values(blind.references).map((reference) => reference.context.length).sort((a, b) => a - b),
    [6, 8]
  );
  const scores = blind.samples.map((sample) => ({
    blindId: sample.blindId,
    scores: {
      boundaryContinuity: 2,
      styleVoiceCadenceContinuity: 2,
      povTenseConsistency: 2,
      factContextRetention: 2,
      genericSceneResetAvoidance: 2
    },
    notes: "The fake output keeps the paired test context."
  }));
  const evidence = scoreReplay(reparsed, scores, artifacts);
  assert.equal(evidence.evaluation.passed, true);
  assert.equal(parseGemmaCompatibilityEvidence(evidence).evaluation.sampleCount, 20);
  const wrongScoringProtocol = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
  ((wrongScoringProtocol.evaluation as Record<string, unknown>).blindScoring as Record<string, unknown>).protocolFingerprint =
    `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => parseGemmaCompatibilityEvidence(wrongScoringProtocol),
    /blind scoring\.protocolFingerprint must be/
  );
  const wrongOptimization = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
  (wrongOptimization.candidate as Record<string, unknown>).optimization = "off";
  assert.throws(
    () => parseGemmaCompatibilityEvidence(wrongOptimization),
    /evidence\.candidate\.optimization must be exactly late-cache-stable/
  );
  const missingAttestation = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
  delete (missingAttestation.candidate as Record<string, unknown>).operatorAcknowledgedExclusiveServer;
  assert.throws(
    () => parseGemmaCompatibilityEvidence(missingAttestation),
    /evidence\.candidate has unsupported or missing fields/
  );
  for (const value of [
    ["sk", "proj", "verysecrettoken"].join("-"),
    ["ghp", "verysecrettoken"].join("_"),
    ["xoxb", "verysecrettoken"].join("-")
  ]) {
    const unsafeEvidence = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
    (unsafeEvidence.profile as Record<string, unknown>).name = value;
    assert.throws(
      () => parseGemmaCompatibilityEvidence(unsafeEvidence),
      /trimmed, single-line summary of at most 240 characters without a URL or credential-like value/
    );
  }
  for (const value of ["A calm note\u2028with a hidden separator", "A calm note\u202Ewith a bidi override"]) {
    const unsafeEvidence = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
    const cases = (unsafeEvidence.evaluation as Record<string, unknown>).cases as Array<Record<string, unknown>>;
    (cases[0]!.baseline as Record<string, unknown>).notes = value;
    assert.throws(() => parseGemmaCompatibilityEvidence(unsafeEvidence), /trimmed, single-line summary/);
  }
  for (const [label, change] of invalidProfileChanges()) {
    const invalidEvidence = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
    change(invalidEvidence.profile as Record<string, unknown>);
    assert.throws(() => parseGemmaCompatibilityEvidence(invalidEvidence), label);
  }
});

test("Gemma replay fails on a provider rejection without retrying or changing the body", async (t) => {
  let requestCount = 0;
  const rejectedBody: { value: Record<string, unknown> | null } = { value: null };
  const server = createServer(async (request, response) => {
    requestCount += 1;
    rejectedBody.value = JSON.parse(await requestText(request)) as Record<string, unknown>;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "fixture rejection" } }));
  });
  const origin = await listen(server);
  t.after(() => close(server));

  await assert.rejects(
    runReplay({
      endpointBaseUrl: `${origin}/v1`,
      model: "koboldcpp/gemma-4-31B-it-uncensored-heretic-Q8_0",
      runtime: TEST_RUNTIME,
      profile: testProfile(),
      optimization: GEMMA_CANDIDATE_OPTIMIZATION,
      operatorAcknowledgedExclusiveServer: true
    }),
    /Model request failed \(400\)/
  );
  assert.equal(requestCount, 1);
  assert.equal(rejectedBody.value?.cache_prompt, false);
});

test("Gemma replay preserves model output when a short credential occurs in prose", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "1667-gemma-https-"));
  const keyPath = path.join(directory, "key.pem");
  const certificatePath = path.join(directory, "certificate.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certificatePath, "-subj", "/CN=127.0.0.1", "-days", "1"
  ], { stdio: "ignore" });
  const server = createSecureServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certificatePath)
  }, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/proxy/v1/chat/completions");
    const body = JSON.parse(await requestText(request)) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "testing testament" }, finish_reason: null }] })}`,
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"));
  });
  const origin = await listenSecure(server);
  t.after(async () => {
    await closeSecure(server);
    rmSync(directory, { recursive: true, force: true });
  });
  const script = `
    import { runReplay } from "./evals/gemma-prompt-quality/runner.ts";
    import { parseReplayProfileManifest } from "./evals/gemma-prompt-quality/profile.ts";
    import { parseGemmaRuntimeConfiguration } from "./evals/gemma-prompt-quality/runtime.ts";
    import { EMPTY_SAMPLING_V2 } from "./shared/settings-v2-types.ts";
    const runtime = parseGemmaRuntimeConfiguration(${JSON.stringify(TEST_RUNTIME.configuration)});
    const profile = parseReplayProfileManifest({ schemaVersion: 1, runtimeArtifactSha256: runtime.configuration.model.artifact.sha256, profile: { name: "credential output", generation: { temperature: .7, maxOutputTokens: 400, effort: "default", cachePolicy: "off", tokenProbabilities: null }, sampling: { ...EMPTY_SAMPLING_V2, topP: .92, topK: 40, minP: .05, repeatPenalty: 1.08 }, timeouts: { responseHeaderMs: 600000, firstTokenMs: 120000, idleMs: 120000, totalMs: 1800000 } } }, runtime);
    const result = await runReplay({ endpointBaseUrl: ${JSON.stringify(`${origin}/proxy/v1`)}, runtime, profile, optimization: "late-cache-stable", operatorAcknowledgedExclusiveServer: true });
    process.stdout.write(JSON.stringify(result.samples.map((sample) => [sample.baseline.output, sample.candidate.output])));
  `;
  const { stdout } = await runFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, GEMMA_API_KEY: "test", NODE_TLS_REJECT_UNAUTHORIZED: "0" }
  });
  assert.deepEqual(JSON.parse(stdout), Array.from({ length: 10 }, () => ["testing testament", "testing testament"]));
});

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function invalidProfileChanges(): readonly [RegExp, (profile: Record<string, unknown>) => void][] {
  return [
    [/requires generation\.effort to be default/, (profile) => { profile.effort = "off"; }],
    [/(source fingerprint|profile does not match approved replay protocol)/, (profile) => {
      profile.timeouts = { ...(profile.timeouts as Record<string, unknown>), responseHeaderMs: 120_000 };
    }],
    [/key "01" is invalid/, (profile) => {
      profile.sampling = { ...(profile.sampling as Record<string, unknown>), logitBias: { "01": 0 } };
      profile.logitBiasState = "present";
    }],
    [/123 must be an integer in -100\.\.100/, (profile) => {
      profile.sampling = { ...(profile.sampling as Record<string, unknown>), logitBias: { "123": 101 } };
      profile.logitBiasState = "present";
    }],
    [/exceeds the 200-entry limit/, (profile) => {
      profile.sampling = {
        ...(profile.sampling as Record<string, unknown>),
        logitBias: Object.fromEntries(Array.from({ length: 201 }, (_, index) => [String(index), 0]))
      };
      profile.logitBiasState = "present";
    }]
  ];
}
